import {
    type DocumentID,
    type EntryDoc,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    LOG_LEVEL_DEBUG,
    type EntryLeaf,
    type SyncParameters,
    DEFAULT_SYNC_PARAMETERS,
    ProtocolVersions,
    DOCID_JOURNAL_SYNC_PARAMETERS,
    type BucketSyncSetting,
} from "../../common/types.ts";
import { Logger } from "../../common/logger.ts";
import type { ReplicationCallback, ReplicationStat } from "../LiveSyncAbstractReplicator.ts";
import {
    type SimpleStore,
    concatUInt8Array,
    delay,
    escapeNewLineFromString,
    parseHeaderValues,
    setAllItems,
    unescapeNewLineFromString,
} from "../../common/utils.ts";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock";
import { wrappedDeflate } from "../../pouchdb/compress.ts";
import { wrappedInflate } from "../../pouchdb/compress.ts";
import { type CheckPointInfo, CheckPointInfoDefault } from "./JournalSyncTypes.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicator.ts";
import { Trench } from "../../memory/memutil.ts";
import { Notifier } from "octagonal-wheels/concurrency/processor";

import {
    clearHandlers,
    SyncParamsFetchError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
} from "../SyncParamsHandler.ts";
import { eventHub } from "../../hub/hub.ts";
import { REMOTE_CHUNK_FETCHED } from "../../pouchdb/LiveSyncLocalDB.ts";
const RECORD_SPLIT = `\n`;
const UNIT_SPLIT = `\u001f`;
type ProcessingEntry = PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta;

const te = new TextEncoder();
function serializeDoc(doc: EntryDoc): Uint8Array {
    if (doc._id.startsWith("h:")) {
        const data = (doc as EntryLeaf).data;
        const writeData = escapeNewLineFromString(data);
        return te.encode(`~${doc._id}${UNIT_SPLIT}${writeData}${RECORD_SPLIT}`);
    }
    return te.encode(JSON.stringify(doc) + RECORD_SPLIT);
}

export abstract class JournalSyncAbstract {
    _settings: BucketSyncSetting;
    get id() {
        return this._settings.accessKey;
    }
    get key() {
        return this._settings.secretKey;
    }
    get bucket() {
        return this._settings.bucket;
    }
    get endpoint() {
        return this._settings.endpoint;
    }
    get prefix() {
        return this._settings.bucketPrefix;
    }
    get region() {
        return this._settings.region;
    }
    get forcePathStyle() {
        return this._settings.forcePathStyle;
    }
    db: PouchDB.Database<EntryDoc>;
    hash = "";
    processReplication: ReplicationCallback;
    batchSize = 100;
    env: LiveSyncJournalReplicatorEnv;
    store: SimpleStore<CheckPointInfo>;
    get useCustomRequestHandler() {
        return this._settings.useCustomRequestHandler;
    }
    get customHeaders(): [string, string][] {
        return this._settings.bucketCustomHeaders.length == 0
            ? []
            : Object.entries(parseHeaderValues(this._settings.bucketCustomHeaders));
    }
    requestedStop = false;
    trench: Trench;
    notifier = new Notifier();

    getInitialSyncParameters(): Promise<SyncParameters> {
        return Promise.resolve({
            ...DEFAULT_SYNC_PARAMETERS,
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: "",
        } satisfies SyncParameters);
    }

    async getSyncParameters(): Promise<SyncParameters> {
        try {
            const downloadedSyncParams = await this.downloadJson<SyncParameters>(DOCID_JOURNAL_SYNC_PARAMETERS);
            if (!downloadedSyncParams) {
                throw new SyncParamsNotFoundError(`Missing sync parameters`);
            }
            return downloadedSyncParams;
        } catch (ex) {
            Logger(`Could not retrieve remote sync parameters`, LOG_LEVEL_INFO);
            throw SyncParamsFetchError.fromError(ex);
        }
    }
    async putSyncParameters(params: SyncParameters): Promise<boolean> {
        try {
            if (await this.uploadJson(DOCID_JOURNAL_SYNC_PARAMETERS, params)) {
                return true;
            }
            throw new SyncParamsUpdateError(`Could not store remote sync parameters`);
        } catch (ex) {
            Logger(`Could not upload sync parameters`, LOG_LEVEL_INFO);
            Logger(ex, LOG_LEVEL_VERBOSE);
            throw SyncParamsUpdateError.fromError(ex);
        }
    }

    getHash(settings: BucketSyncSetting) {
        return btoa(
            encodeURI([settings.endpoint, `${settings.bucket}${settings.bucketPrefix}`, settings.region].join())
        );
    }
    constructor(settings: BucketSyncSetting, store: SimpleStore<CheckPointInfo>, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings;

        this.db = env.getDatabase();
        this.env = env;
        this.processReplication = async (docs) => await env.$$parseReplicationResult(docs);
        this.store = store;
        this.hash = this.getHash(settings);
        this.trench = new Trench(store);
        clearHandlers();
    }
    applyNewConfig(settings: BucketSyncSetting, store: SimpleStore<CheckPointInfo>, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings;
        this.db = env.getDatabase();
        this.env = env;
        this.processReplication = async (docs) => await env.$$parseReplicationResult(docs);
        this.store = store;
        this.hash = this.getHash(settings);
        clearHandlers();
    }

    updateInfo(info: Partial<ReplicationStat>) {
        const old = this.env.replicationStat.value;
        this.env.replicationStat.value = {
            sent: info.sent ?? old.sent,
            arrived: info.arrived ?? old.arrived,
            maxPullSeq: info.maxPullSeq ?? old.maxPullSeq,
            maxPushSeq: info.maxPushSeq ?? old.maxPushSeq,
            lastSyncPullSeq: info.lastSyncPullSeq ?? old.lastSyncPullSeq,
            lastSyncPushSeq: info.lastSyncPushSeq ?? old.lastSyncPushSeq,
            syncStatus: info.syncStatus ?? old.syncStatus,
        };
    }
    async updateCheckPointInfo(func: (infoFrom: CheckPointInfo) => CheckPointInfo) {
        const checkPointKey = `bucketsync-checkpoint-${this.hash}` as DocumentID;
        const old = await this.getCheckpointInfo();
        const newInfo = func(old);
        this._currentCheckPointInfo = newInfo;
        await this.store.set(checkPointKey, newInfo);
        return newInfo;
    }

    _currentCheckPointInfo = { ...CheckPointInfoDefault };
    async getCheckpointInfo(): Promise<CheckPointInfo> {
        const checkPointKey = `bucketsync-checkpoint-${this.hash}` as DocumentID;
        const old: any = (await this.store.get(checkPointKey)) || {};
        const items = ["knownIDs", "sentIDs", "receivedFiles", "sentFiles"];
        for (const key of items) {
            if (key in old && typeof Array.isArray(old[key])) {
                old[key] = new Set(old[key]);
            }
        }
        this._currentCheckPointInfo = { ...CheckPointInfoDefault, ...old };
        return this._currentCheckPointInfo;
    }
    async resetAllCaches() {
        await this.trench.eraseAllPermanences();
        clearHandlers();
    }
    async resetCheckpointInfo() {
        await this.updateCheckPointInfo((info) => ({ ...CheckPointInfoDefault }));
        clearHandlers();
    }

    abstract resetBucket(): Promise<boolean>;

    abstract uploadJson<T>(key: string, body: any): Promise<T | boolean>;
    abstract downloadJson<T>(key: string): Promise<T | false>;

    abstract uploadFile(key: string, blob: Blob, mime: string): Promise<boolean>;
    abstract downloadFile(key: string): Promise<Uint8Array | false>;
    abstract listFiles(from: string, limit?: number): Promise<string[]>;
    abstract isAvailable(): Promise<boolean>;

    async _createJournalPack(override?: number | string) {
        const checkPointInfo = await this.getCheckpointInfo();
        const from = override || checkPointInfo.lastLocalSeq;
        Logger(`Journal reading from seq:${from}`, LOG_LEVEL_VERBOSE);
        let knownKeyCount = 0;
        let sendKeyCount = 0;
        const allChangesTask = this.db.changes({
            live: false,
            since: override || from,
            // include_docs: true,
            conflicts: true,
            limit: this.batchSize,
            return_docs: true,
            // conflicts: true,
            attachments: false,
            style: "all_docs",
            filter: (doc: EntryDoc) => {
                const key = this.getDocKey(doc);
                if (this._currentCheckPointInfo.knownIDs.has(key)) {
                    knownKeyCount++;
                    return false;
                }
                if (this._currentCheckPointInfo.sentIDs.has(key)) {
                    knownKeyCount++;
                    return false;
                }
                sendKeyCount++;
                return true;
            },
        });
        const allChanges = await allChangesTask;
        if (allChanges.results.length == 0) {
            return { changes: [], hasNext: false, packLastSeq: allChanges.last_seq };
        }
        Logger(
            `${sendKeyCount} items possibly needs to be sent (${knownKeyCount} keys has been received before)`,
            LOG_LEVEL_DEBUG
        );
        const bd = await this.db.bulkGet({
            docs: allChanges.results.map((e) => e.changes.map((change) => ({ id: e.id, rev: change.rev }))).flat(),
            revs: true,
        });
        const packLastSeq = allChanges.last_seq;
        const dbInfo = await this.db.info();
        const hasNext = packLastSeq < dbInfo.update_seq;
        const docs = bd.results.map((e) => e.docs).flat();
        // Thinning out the docs.
        const docChanges = docs
            .filter((e) => "ok" in e)
            .map((e) => (e as any).ok)
            .filter((doc: EntryDoc) => {
                const key = this.getDocKey(doc);
                if (this._currentCheckPointInfo.knownIDs.has(key)) {
                    knownKeyCount++;
                    return false;
                }
                if (this._currentCheckPointInfo.sentIDs.has(key)) {
                    knownKeyCount++;
                    return false;
                }
                return true;
            }) as (EntryDoc & PouchDB.Core.GetMeta)[];
        return { changes: docChanges, hasNext, packLastSeq };
    }

    getDocKey(doc: EntryDoc) {
        if (doc && doc._id.startsWith("h:")) {
            // When leaf, we do not think about revisions.
            return doc._id;
        }
        return doc._id + "-" + doc._rev;
    }
    async uploadQueued(showMessage = false, wrapUp = false) {
        return await shareRunningResult("upload_queue", async () => {
            const MSG_KEY = "send_journal";
            const TASK_TITLE = "Uploading journal:";
            const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;

            let uploaded = 0;
            do {
                const queued = await this.trench.dequeuePermanentWithCommit<Uint8Array<ArrayBuffer>>(`upload_queue`);

                if (!queued) {
                    if (this.isPacking) {
                        Logger(
                            `${TASK_TITLE} Queue run out, but process is running. wait for the next.`,
                            LOG_LEVEL_VERBOSE
                        );
                        await Promise.race([this.notifier.nextNotify, delay(3000)]);
                        continue;
                    }
                    if (uploaded) {
                        Logger(`${TASK_TITLE}: ${uploaded} files have been uploaded!`, logLevel, MSG_KEY);
                    } else {
                        if (!wrapUp) Logger(`No files needs to be uploaded!`, logLevel, MSG_KEY);
                    }
                    return true;
                }
                const { key, value, commit, cancel, cancelCount, pendingItems } = queued;
                this.updateInfo({ sent: uploaded, maxPushSeq: pendingItems + uploaded, lastSyncPushSeq: 1 });
                Logger(
                    `${TASK_TITLE} ${uploaded} / ${pendingItems + uploaded}${cancelCount != 0 ? `\nRETRY:${cancelCount}` : ""}`,
                    logLevel,
                    MSG_KEY
                );
                Logger(
                    `${TASK_TITLE} ${key} ${cancelCount != 0 ? `TRY:${cancelCount}` : ""} ${pendingItems} left`,
                    LOG_LEVEL_VERBOSE
                );
                if (cancelCount > 3) {
                    Logger(`${TASK_TITLE} Something went wrong on processing queue ${key}.`, LOG_LEVEL_NOTICE);
                    return false;
                }
                const sendTimeStamp = Date.now();

                const filename = `${sendTimeStamp}-docs.jsonl.gz`;
                const mime = "application/octet-stream";
                const blob = new Blob([value], { type: mime });
                try {
                    const ret = await this.uploadFile(filename, blob, mime);
                    if (!ret) {
                        throw new Error("Could not send journalPack to the bucket");
                    }
                    await commit();
                    uploaded++;
                    await this.updateCheckPointInfo((info) => ({ ...info, sentFiles: info.sentFiles.add(filename) }));
                    Logger(`${TASK_TITLE}: Uploaded ${key} as ${filename}`, LOG_LEVEL_INFO);
                } catch (ex) {
                    Logger(
                        `${TASK_TITLE} Could not send journalPack to the bucket (${key} as ${filename})`,
                        LOG_LEVEL_NOTICE
                    );
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    Logger(`${TASK_TITLE} Uploading ${key} cancelled for retry`, LOG_LEVEL_VERBOSE);
                    cancel();
                    await delay(1000); // Need Backoff?
                    continue;
                }
            } while (this.requestedStop == false);
        });
    }
    isPacking = false;
    async packAndCompress(showMessage = false) {
        return await shareRunningResult("create_send_data", async () => {
            try {
                this.isPacking = true;
                const MSG_KEY = "pack_journal";
                const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
                this.requestedStop = false;
                const checkPointInfo = await this.getCheckpointInfo();
                const max = (await this.db.info()).update_seq as number;
                const sentIDs = checkPointInfo.sentIDs;
                const maxOutBufLength = 250;
                const maxBinarySize = 1024 * 1024 * 10;
                let currentLastSeq = checkPointInfo.lastLocalSeq;
                let binarySize = 0;
                const outBuf = [] as Uint8Array[];
                let isFinished = false;
                const startSeq = checkPointInfo.lastLocalSeq as number;
                const seqToProcess = max - startSeq;

                Logger(`Packing Journal: Start sending`, logLevel, MSG_KEY);
                do {
                    if (this.requestedStop) {
                        Logger("Packing Journal : Stop requested", logLevel, MSG_KEY);
                        isFinished = true;
                        break;
                    }

                    const { changes, hasNext, packLastSeq } = await this._createJournalPack(currentLastSeq);
                    const currentSeq = (packLastSeq as number) - startSeq;
                    if (changes.length == 0) {
                        isFinished = true;
                    } else {
                        Logger(`Packing Journal: ${currentSeq} / ${seqToProcess}`, logLevel, MSG_KEY);
                        // this.updateInfo({ maxPushSeq: max, sent: currentLastSeq as number, lastSyncPushSeq: startSeq })
                        for (const row of changes) {
                            const serialized = serializeDoc(row);
                            sentIDs.add(this.getDocKey(row));
                            binarySize += serialized.length;
                            outBuf.push(serialized);
                            if (outBuf.length > maxOutBufLength || binarySize > maxBinarySize) {
                                const sendBuf = concatUInt8Array(outBuf);
                                const orgLen = sendBuf.byteLength;
                                const bin = await wrappedDeflate(sendBuf, { consume: true, level: 8 });
                                Logger(
                                    `Packing Journal: Compressed ${orgLen} bytes to ${bin.byteLength} bytes (${orgLen != 0 ? Math.ceil((bin.byteLength / orgLen) * 100) : "--"}%)`,
                                    LOG_LEVEL_VERBOSE
                                );
                                await this.trench.queuePermanent(`upload_queue`, bin);
                                this.notifier.notify();
                                outBuf.length = 0;
                                binarySize = 0;
                            }
                        }
                    }
                    if (outBuf.length > 0) {
                        const sendBuf = concatUInt8Array(outBuf);
                        const orgLen = sendBuf.byteLength;
                        const bin = await wrappedDeflate(sendBuf, { consume: true, level: 8 });
                        Logger(
                            `Packing Journal: Compressed ${orgLen} bytes to ${bin.byteLength} bytes (${orgLen != 0 ? Math.ceil((bin.byteLength / orgLen) * 100) : "--"}%)`,
                            LOG_LEVEL_VERBOSE
                        );
                        await this.trench.queuePermanent(`upload_queue`, bin);
                        this.notifier.notify();
                    }
                    await this.updateCheckPointInfo((info) => ({
                        ...info,
                        lastLocalSeq: packLastSeq,
                        sentIDs,
                    }));
                    currentLastSeq = packLastSeq;
                    if (!hasNext) {
                        // End of the queue
                        isFinished = true;
                        break;
                    }
                } while (this.requestedStop == false && !isFinished);
                if (seqToProcess != 0) {
                    Logger(`Packing Journal: Packaging ${seqToProcess}`, logLevel, MSG_KEY);
                } else {
                    Logger(`Packing Journal: No journals to be packed!`, logLevel, MSG_KEY);
                }
                this.notifier.notify();
                return true;
            } finally {
                this.isPacking = false;
                this.notifier.notify();
            }
        });
    }
    async sendLocalJournal(showMessage = false) {
        this.updateInfo({ syncStatus: "JOURNAL_SEND" });
        const results = await Promise.all([this.packAndCompress(showMessage), this.uploadQueued(showMessage)]);
        if (results.every((e) => e)) {
            // recap;
            const r = await this.uploadQueued(showMessage, true);
            if (r) {
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            }
        }
        this.updateInfo({ syncStatus: "ERRORED" });
        return false;
    }
    async _getRemoteJournals() {
        const checkPointInfo = await this.getCheckpointInfo();
        const StartAfter = [...checkPointInfo.receivedFiles.keys()].sort((a, b) =>
            b.localeCompare(a, undefined, { numeric: true })
        )[0];
        const files = (await this.listFiles(StartAfter)).filter((e) => !e.startsWith("_"));
        if (!files) return [];
        return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    async processDocuments(allDocs: ProcessingEntry[]) {
        let applyTotal = 0;
        let wholeItems = 0;
        try {
            // Sort transferred into chunks and docs.
            const chunks = [] as typeof allDocs;
            const docs = [] as typeof allDocs;
            allDocs.forEach((e) => {
                if (e._id.startsWith("h:")) {
                    chunks.push(e);
                } else {
                    docs.push(e);
                }
            });
            // Chunk saving.
            // Chunks always have the same content, hence revision comparisons are unnecessary
            try {
                const e1 = (await this.db.allDocs({ include_docs: true, keys: [...chunks.map((e) => e._id)] })).rows;
                const e2 = e1.map((e) => (e as any).id ?? undefined);
                const existChunks = new Set(e2.filter((e) => e !== undefined));
                const saveChunks = chunks
                    .filter((e) => !existChunks.has(e._id))
                    .map((e) => ({ ...e, _rev: undefined }));
                const ret = await this.db.bulkDocs<EntryDoc>(saveChunks, { new_edits: true });
                const saveError = ret.filter((e) => "error" in e).map((e) => e.id);
                // Send arrived notification.
                saveChunks
                    .filter((e) => saveError.indexOf(e._id) === -1)
                    .forEach((doc) => eventHub.emitEvent(REMOTE_CHUNK_FETCHED, doc as EntryLeaf));
                await this.updateCheckPointInfo((info) => ({
                    ...info,
                    knownIDs: setAllItems(
                        info.knownIDs,
                        chunks.map((e) => this.getDocKey(e))
                    ),
                }));
                Logger(
                    `Saved ${ret.length} chunks in transferred ${chunks.length} chunks (Error:${saveError.length})`,
                    LOG_LEVEL_VERBOSE
                );
            } catch (ex) {
                Logger(`Applying chunks failed`, LOG_LEVEL_INFO);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
            // Docs saving.
            // Docs have different revisions, hence revision comparisons and merging are necessary.
            const params = docs.map((e) => [e._id, [e._rev]] as const);
            const docsRevs = params.reduce(
                (acc, [id, revs]) => {
                    return {
                        ...acc,
                        [id]: [...(acc[id] ?? []), ...revs],
                    };
                },
                {} as { [key: string]: string[] }
            );
            const diffRevs = await this.db.revsDiff(docsRevs);
            const saveDocs = docs.filter(
                (e) =>
                    e._id in diffRevs &&
                    "missing" in diffRevs[e._id] &&
                    (diffRevs[e._id].missing?.indexOf(e._rev) ?? 0) !== -1
            );
            Logger(
                `Applying ${saveDocs.length} docs (Total transferred:${docs.length}, docs:${allDocs.length})`,
                LOG_LEVEL_VERBOSE
            );
            await this.db.bulkDocs<EntryDoc>(saveDocs, { new_edits: false });
            await this.processReplication(saveDocs as PouchDB.Core.ExistingDocument<EntryDoc>[]);
            await this.updateCheckPointInfo((info) => ({
                ...info,
                knownIDs: setAllItems(
                    info.knownIDs,
                    docs.map((e) => this.getDocKey(e))
                ),
            }));
            applyTotal += saveDocs.length;
            wholeItems += docs.length;
            Logger(
                `Applied ${applyTotal} of ${wholeItems} docs (${wholeItems - applyTotal} skipped)`,
                LOG_LEVEL_VERBOSE
            );
            return true;
        } catch (ex) {
            Logger(`Applying journal failed`, LOG_LEVEL_INFO);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async processDownloadedJournals(showMessage = false, wrapUp = false) {
        return await shareRunningResult("process_downloaded_journals", async () => {
            const MSG_KEY = "send_journal";
            const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
            const TASK_TITLE = `Processing journal:`;
            let downloaded = 0;
            do {
                const queued = await this.trench.dequeuePermanentWithCommit<Uint8Array>(`parse_file`);
                if (!queued) {
                    if (this.isDownloading) {
                        Logger(
                            `${TASK_TITLE} Queue run out, but process is running. wait for the next.`,
                            LOG_LEVEL_VERBOSE
                        );
                        await Promise.race([this.notifier.nextNotify, delay(3000)]);
                        continue;
                    }
                    if (downloaded) {
                        Logger(`${TASK_TITLE} ${downloaded} files have been uploaded!`, logLevel, MSG_KEY);
                    } else {
                        if (!wrapUp) Logger(`${TASK_TITLE} No files needs to be processed!`, logLevel, MSG_KEY);
                    }
                    return true;
                }
                const { key, value, commit, cancel, cancelCount, pendingItems } = queued;
                this.updateInfo({ arrived: downloaded, maxPullSeq: pendingItems + downloaded, lastSyncPullSeq: 1 });
                Logger(
                    `${TASK_TITLE} ${downloaded} / ${pendingItems + downloaded}${cancelCount != 0 ? `\nRETRY:${cancelCount}` : ""}`,
                    logLevel,
                    "processjournal"
                );
                if (cancelCount > 3) {
                    Logger(`${TASK_TITLE} Something went wrong on processing queue ${key}.`, LOG_LEVEL_NOTICE);
                    return false;
                }
                const decompressed = await wrappedInflate(value, { consume: true });
                if (decompressed.length == 0) {
                    await commit();
                    downloaded++;
                    Logger(`${TASK_TITLE}: ${key} has been processed`, LOG_LEVEL_INFO);
                    continue;
                }
                let idxFrom = 0;
                let idxTo = 0;
                const d = new TextDecoder();
                const result = [] as ProcessingEntry[];
                do {
                    idxTo = decompressed.indexOf(0x0a, idxFrom);
                    if (idxTo == -1) {
                        break;
                    }
                    const piece = decompressed.slice(idxFrom, idxTo);
                    const strPiece = d.decode(piece);
                    if (strPiece.startsWith("~")) {
                        const [key, data] = strPiece.substring(1).split(UNIT_SPLIT);
                        result.push({
                            _id: key as DocumentID,
                            data: unescapeNewLineFromString(data),
                            type: "leaf",
                            _rev: "", // It may ignored.
                        });
                    } else {
                        result.push(JSON.parse(strPiece));
                    }
                    idxFrom = idxTo + 1;
                } while (idxTo > 0);
                try {
                    if (await this.processDocuments(result)) {
                        await commit();
                        downloaded++;
                        Logger(`${TASK_TITLE}: ${key} has been processed`, LOG_LEVEL_INFO);
                    } else {
                        throw new Error("Could not process downloaded journals");
                    }
                } catch (ex) {
                    Logger(`${TASK_TITLE}: Could not process downloaded journals`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    Logger(`${TASK_TITLE}: ${key} cancelled for retry`, LOG_LEVEL_VERBOSE);
                    cancel();
                    await delay(1000); // Need Backoff?
                    continue;
                }
            } while (this.requestedStop == false);
            return true;
        });
    }

    isDownloading = false;
    async downloadRemoteJournals(showMessage = false) {
        return await shareRunningResult("downloadRemoteJournals", async () => {
            try {
                this.isDownloading = true;
                const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
                Logger("Receiving Journal: Getting list of remote journal", logLevel, "receivejournal");
                const files = await this._getRemoteJournals();
                if (files.length == 0) {
                    Logger(`Receiving Journal: No journals needs to be downloaded`, logLevel, "receivejournal");
                    return true;
                }
                let count = 0;
                for (const key of files) {
                    count++;
                    Logger(`Receiving Journal: ${count} / ${files.length}`, logLevel, "receivejournal");
                    if (this.requestedStop) {
                        Logger(`Receiving canceled: ${key}`, logLevel);
                        return false;
                    }
                    if (this._currentCheckPointInfo.sentFiles.has(key)) {
                        // If this device already sent it before, mark it as downloaded.
                        Logger(`Receiving Journal: ${key} is own sent file`, LOG_LEVEL_VERBOSE);
                        await this.updateCheckPointInfo((info) => ({
                            ...info,
                            receivedFiles: info.receivedFiles.add(key),
                        }));
                        continue;
                    }
                    try {
                        const data = await this.downloadFile(key);
                        if (data === false) {
                            throw new Error("Download Error");
                        }
                        // Now it has been queued, so we can mark it
                        await this.trench.queuePermanent("parse_file", data);
                        await this.updateCheckPointInfo((info) => ({
                            ...info,
                            receivedFiles: info.receivedFiles.add(key),
                        }));
                        this.notifier.notify();
                    } catch (ex) {
                        Logger(`Could not download ${key}`, logLevel);
                        Logger(ex, LOG_LEVEL_DEBUG);
                        return false;
                    }
                }
            } finally {
                this.isDownloading = false;
                this.notifier.notify();
            }
            this.notifier.notify();
            return true;
        });
    }

    async receiveRemoteJournal(showMessage = false) {
        this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" });
        this.requestedStop = false;
        const results = await Promise.all([
            this.downloadRemoteJournals(showMessage),
            this.processDownloadedJournals(showMessage),
        ]);
        if (results.every((e) => e)) {
            // parse it again
            const r = await this.processDownloadedJournals(showMessage, true);
            if (r) {
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            }
        }
        this.updateInfo({ syncStatus: "ERRORED" });
        return false;
    }

    async sync(showResult = false) {
        return (
            (await shareRunningResult("replicate", async () => {
                this.requestedStop = false;
                const receiveResult = await this.receiveRemoteJournal(showResult);
                if (this.requestedStop) return;
                if (!receiveResult) {
                    const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
                    Logger(
                        `Could not receive remote journal, so we prevent sending local journals to prevent unwanted mass transfers`,
                        logLevel
                    );
                    return;
                }
                return await this.sendLocalJournal(showResult);
            })) ?? false
        );
    }

    requestStop() {
        this.requestedStop = true;
    }
}
