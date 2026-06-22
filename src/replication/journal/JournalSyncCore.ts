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
    E2EEAlgorithms,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import type { ReplicationCallback, ReplicationStat } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import {
    type SimpleStore,
    concatUInt8Array,
    escapeNewLineFromString,
    setAllItems,
    unescapeNewLineFromString,
} from "@lib/common/utils.ts";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock";
import { wrappedDeflate, wrappedInflate } from "@lib/pouchdb/compress.ts";
import { type CheckPointInfo, CheckPointInfoDefault } from "./JournalSyncTypes.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";

import {
    clearHandlers,
    createSyncParamsHanderForServer,
    SyncParamsFetchError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
} from "@lib/replication/SyncParamsHandler.ts";
import { eventHub } from "@lib/hub/hub.ts";
import { REMOTE_CHUNK_FETCHED } from "@lib/pouchdb/LiveSyncLocalDB.ts";
import { decryptBinary, encryptBinary } from "octagonal-wheels/encryption/encryption";
import {
    encryptBinary as encryptBinaryHKDF,
    decryptBinary as decryptBinaryHKDF,
} from "octagonal-wheels/encryption/hkdf";

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

export class JournalSyncCore {
    _settings: BucketSyncSetting;
    storage: IJournalStorage;

    get db() {
        return this.env.services.database.localDatabase.localDatabase;
    }

    get currentSettings() {
        return this.env.services.setting.currentSettings();
    }

    hash = "";
    processReplication: ReplicationCallback;
    batchSize = 100;
    env: LiveSyncJournalReplicatorEnv;
    store: SimpleStore<CheckPointInfo>;
    requestedStop = false;

    getInitialSyncParameters(): Promise<SyncParameters> {
        return Promise.resolve({
            ...DEFAULT_SYNC_PARAMETERS,
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: "",
        } satisfies SyncParameters);
    }

    async getSyncParameters(): Promise<SyncParameters> {
        try {
            const downloadedData = await this.storage.download(DOCID_JOURNAL_SYNC_PARAMETERS, true);
            if (!downloadedData) {
                throw new SyncParamsNotFoundError(`Missing sync parameters`);
            }
            const downloadedSyncParams = JSON.parse(new TextDecoder().decode(downloadedData)) as SyncParameters;
            return downloadedSyncParams;
        } catch (ex) {
            Logger(`Could not retrieve remote sync parameters`, LOG_LEVEL_INFO);
            throw SyncParamsFetchError.fromError(ex);
        }
    }

    async putSyncParameters(params: SyncParameters): Promise<boolean> {
        try {
            const data = new TextEncoder().encode(JSON.stringify(params));
            if (await this.storage.upload(DOCID_JOURNAL_SYNC_PARAMETERS, data, "application/json")) {
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

    constructor(
        settings: BucketSyncSetting,
        store: SimpleStore<CheckPointInfo>,
        env: LiveSyncJournalReplicatorEnv,
        storage: IJournalStorage
    ) {
        this._settings = settings;
        this.env = env;
        this.processReplication = async (docs: PouchDB.Core.ExistingDocument<EntryDoc>[]) =>
            await env.services.replication.parseSynchroniseResult(docs);
        this.store = store;
        this.hash = this.getHash(settings);
        this.storage = storage;
        clearHandlers();
    }

    async downloadJson<T>(key: string): Promise<T | false> {
        try {
            const data = await this.storage.download(key, true);
            if (!data) return false;
            return JSON.parse(new TextDecoder().decode(data)) as T;
        } catch (ex) {
            Logger(`Could not download json ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async uploadJson<T>(key: string, body: T): Promise<boolean> {
        try {
            const data = new TextEncoder().encode(JSON.stringify(body));
            return await this.storage.upload(key, data, "application/json");
        } catch (ex) {
            Logger(`Could not upload json ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    applyNewConfig(settings: BucketSyncSetting, store: SimpleStore<CheckPointInfo>, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings;
        this.env = env;
        this.processReplication = async (docs: PouchDB.Core.ExistingDocument<EntryDoc>[]) =>
            await env.services.replication.parseSynchroniseResult(docs);
        this.store = store;
        this.hash = this.getHash(settings);
        this.storage.applyNewConfig(settings);
        clearHandlers();
    }

    updateInfo(info: Partial<ReplicationStat>) {
        const old = this.env.services.replicator.replicationStatics.value;
        this.env.services.replicator.replicationStatics.value = {
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
        const old: Record<string, unknown> = (await this.store.get(checkPointKey)) || {};
        const items = ["knownIDs", "sentIDs", "receivedFiles", "sentFiles"];
        for (const key of items) {
            if (!(key in old)) {
                continue;
            }
            const value = old[key];
            if (value instanceof Set) {
                continue;
            }
            if (Array.isArray(value)) {
                old[key] = new Set(value);
                continue;
            }
            if (value && typeof value === "object") {
                old[key] = new Set(Object.keys(value));
                continue;
            }
            old[key] = new Set<string>();
        }
        this._currentCheckPointInfo = { ...CheckPointInfoDefault, ...old };
        return this._currentCheckPointInfo;
    }

    resetAllCaches(): void {
        clearHandlers();
    }

    async resetCheckpointInfo() {
        await this.updateCheckPointInfo((info) => ({ ...CheckPointInfoDefault }));
        clearHandlers();
    }

    private getJournalEpochFromSyncParams(params: SyncParameters): string {
        return `${params.protocolVersion}:${params.pbkdf2salt}`;
    }

    async ensureCheckpointCachesAreFresh(): Promise<void> {
        let journalEpoch = "";
        try {
            const params = await this.getSyncParameters();
            journalEpoch = this.getJournalEpochFromSyncParams(params);
        } catch {
            return;
        }

        const current = await this.getCheckpointInfo();
        if (current.journalEpoch === journalEpoch) {
            return;
        }

        const lastSentFile = [...current.sentFiles].sort().pop();

        // Epoch changed (or first observed on migrated devices).
        // Use sentFiles to determine whether the remote was wiped:
        //   - No sent history          → fresh device or empty state; save epoch, keep caches.
        //   - File still on remote     → epoch changed without a wipe (e.g. protocol bump or
        //                                first run after upgrade); save epoch, keep caches.
        //   - File gone from remote    → wipe confirmed; save epoch, reset caches.
        // sentFiles names are timestamp-based (e.g. "1712345678900-docs.jsonl.gz") and
        // virtually never collide across separate remote lifetimes.
        if (!lastSentFile) {
            // No send history: cannot confirm wipe; just record the epoch.
            await this.updateCheckPointInfo((info) => ({ ...info, journalEpoch }));
            return;
        }

        let remoteWipeConfirmed: boolean;
        try {
            // listFiles uses S3 StartAfter (exclusive), so slice off the last char to land
            // just before the target key, then check if the returned entry matches exactly.
            const probe = await this.storage.listFiles(lastSentFile.slice(0, -1), 1);
            remoteWipeConfirmed = probe[0] !== lastSentFile;
        } catch {
            remoteWipeConfirmed = true;
        }

        if (!remoteWipeConfirmed) {
            // Remote files are intact: no wipe occurred. Save epoch and preserve caches.
            await this.updateCheckPointInfo((info) => ({ ...info, journalEpoch }));
            Logger(`Journal epoch changed (remote files still present). Epoch updated; caches kept.`, LOG_LEVEL_NOTICE);
            return;
        }

        Logger(`Journal epoch changed and remote wipe confirmed. Clearing dedupe caches.`, LOG_LEVEL_NOTICE);
        await this.updateCheckPointInfo((info) => ({
            ...info,
            journalEpoch,
            knownIDs: new Set<string>(),
            sentIDs: new Set<string>(),
            receivedFiles: new Set<string>(),
            sentFiles: new Set<string>(),
        }));
        clearHandlers();
    }

    async isAvailable(): Promise<boolean> {
        return await this.storage.isAvailable();
    }

    async resetBucket(): Promise<boolean> {
        let files = [] as string[];
        try {
            do {
                files = await this.storage.listFiles("", 100);
                if (files.length == 0) {
                    break;
                }
                await this.storage.deleteFiles(files);
            } while (files.length != 0);
            clearHandlers();
        } catch (ex) {
            Logger(`WARNING! Could not delete files.`, LOG_LEVEL_NOTICE, "reset-bucket");
            Logger(ex, LOG_LEVEL_VERBOSE);
        }

        const journals = await this._getRemoteJournals();
        if (journals.length == 0) {
            Logger("Nothing to delete!", LOG_LEVEL_NOTICE);
            return true;
        }
        await this.storage.deleteFiles(journals);
        Logger(`${journals.length} items has been deleted!`, LOG_LEVEL_NOTICE);
        await this.resetCheckpointInfo();
        return true;
    }

    getRemoteKey(): string {
        return this.getHash(this._settings);
    }

    async getReplicationPBKDF2Salt(refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        const server = this.getRemoteKey();
        const manager = createSyncParamsHanderForServer(server, {
            put: (params: SyncParameters) => this.putSyncParameters(params),
            get: () => this.getSyncParameters(),
            create: () => this.getInitialSyncParameters(),
        });
        return await manager.getPBKDF2Salt(refresh);
    }

    isEncryptionPrevented(fileName: string): boolean {
        if (fileName.endsWith(DOCID_JOURNAL_SYNC_PARAMETERS)) return true;
        return false;
    }

    private async decryptDataV2(
        encrypted: Uint8Array<ArrayBuffer>,
        set: RemoteDBSettings
    ): Promise<Uint8Array<ArrayBuffer>> {
        const salt = await this.getReplicationPBKDF2Salt();
        return await decryptBinaryHKDF(encrypted, set.passphrase, salt);
    }

    private async decryptDataV1(
        encrypted: Uint8Array<ArrayBuffer>,
        set: RemoteDBSettings
    ): Promise<Uint8Array<ArrayBuffer>> {
        return (await decryptBinary(
            encrypted,
            set.passphrase,
            set.useDynamicIterationCount
        )) as Uint8Array<ArrayBuffer>;
    }

    async decryptDownloaded(
        key: string,
        encrypted: Uint8Array<ArrayBuffer>,
        set: RemoteDBSettings
    ): Promise<Uint8Array<ArrayBuffer>> {
        const u = new Uint8Array(encrypted);
        try {
            if (!set.encrypt || set.passphrase == "" || this.isEncryptionPrevented(key)) {
                return u;
            }
            if (set.E2EEAlgorithm === E2EEAlgorithms.ForceV1) {
                return await this.decryptDataV1(u, set);
            }
            const decrypted = await this.decryptDataV2(u, set);
            return decrypted;
        } catch (ex) {
            Logger(`Failed to decrypt in v2. Falling back to v1: ${key}`, LOG_LEVEL_INFO);
            try {
                const r = await this.decryptDataV1(u, set);
                Logger(`Decrypted in v1: ${key}`, LOG_LEVEL_VERBOSE);
                return r;
            } catch (ex2) {
                Logger(`Could not decrypt in v1: ${key}`, LOG_LEVEL_VERBOSE);
                Logger(ex, LOG_LEVEL_VERBOSE);
                Logger(ex2, LOG_LEVEL_VERBOSE);
                throw ex2;
            }
        }
    }

    async encryptForUpload(
        key: string,
        data: Uint8Array<ArrayBuffer>,
        set: RemoteDBSettings
    ): Promise<Uint8Array<ArrayBuffer>> {
        if (!set.encrypt || set.passphrase == "" || this.isEncryptionPrevented(key)) {
            return data;
        }

        if (set.E2EEAlgorithm === E2EEAlgorithms.V2) {
            const salt = await this.getReplicationPBKDF2Salt();
            return await encryptBinaryHKDF(data, set.passphrase, salt);
        } else {
            return await encryptBinary(data, set.passphrase, set.useDynamicIterationCount);
        }
    }

    getDocKey(doc: EntryDoc) {
        if (doc && doc._id.startsWith("h:")) {
            return doc._id;
        }
        return doc._id + "-" + doc._rev;
    }

    async _createJournalPack(override?: number | string) {
        const checkPointInfo = await this.getCheckpointInfo();
        const from = override || checkPointInfo.lastLocalSeq;
        Logger(`Journal reading from seq:${from}`, LOG_LEVEL_VERBOSE);
        let knownKeyCount = 0;
        const allChangesTask = this.db.changes({
            live: false,
            since: override || from,
            conflicts: true,
            limit: this.batchSize,
            return_docs: true,
            attachments: false,
            style: "all_docs",
            // NOTE: Do NOT add a filter function here that tests the winning-revision doc.
            // With style:"all_docs", each change entry can carry multiple leaf revisions
            // (e.g. the winner plus a newly-created tombstone for a resolved conflict).
            // A filter based on the winner's key would incorrectly suppress the entire entry
            // even when one of the other leaf revisions (e.g. the tombstone) has never been
            // sent.  Per-revision deduplication is handled correctly by the second filter
            // applied after bulkGet below.
        });
        const allChanges = await allChangesTask;
        if (allChanges.results.length == 0) {
            return { changes: [], hasNext: false, packLastSeq: allChanges.last_seq };
        }
        const bd = await this.db.bulkGet({
            docs: allChanges.results.map((e) => e.changes.map((change) => ({ id: e.id, rev: change.rev }))).flat(),
            revs: true,
        });
        const packLastSeq = allChanges.last_seq;
        const dbInfo = await this.db.info();
        const hasNext = packLastSeq < dbInfo.update_seq;
        const docs = bd.results.map((e) => e.docs).flat();

        const docChanges = docs
            .filter((e) => "ok" in e)
            .map((e) => e.ok as EntryDoc)
            .filter((doc) => {
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
            });
        Logger(
            `Checked ${allChanges.results.length} changed entries, selected ${docChanges.length} docs (${knownKeyCount} keys already known)`,
            LOG_LEVEL_DEBUG
        );
        return { changes: docChanges, hasNext, packLastSeq };
    }

    private _createSendReadableStream(startSeq: number, logLevel: any, MSG_KEY: string) {
        let currentLastSeq = startSeq;
        return new ReadableStream({
            pull: async (controller) => {
                if (this.requestedStop) {
                    Logger("Packing Journal : Stop requested", logLevel, MSG_KEY);
                    controller.close();
                    return;
                }
                const { changes, hasNext, packLastSeq } = await this._createJournalPack(currentLastSeq);
                if (changes.length > 0) {
                    controller.enqueue({ changes, packLastSeq });
                }
                currentLastSeq = packLastSeq as number;
                if (!hasNext) {
                    controller.close();
                }
            },
        });
    }

    private _createSendCompressTransformStream(startSeq: number, seqToProcess: number, logLevel: any, MSG_KEY: string) {
        const maxOutBufLength = 250;
        const maxBinarySize = 1024 * 1024 * 10;
        let outBuf: Uint8Array[] = [];
        let binarySize = 0;
        let batchSentIDs: string[] = [];
        let lastProcessedSeq = startSeq;

        return new TransformStream({
            transform: async (chunk, controller) => {
                lastProcessedSeq = chunk.packLastSeq as number;
                const currentSeq = lastProcessedSeq - startSeq;
                Logger(`Packing Journal: ${currentSeq} / ${seqToProcess}`, logLevel, MSG_KEY);

                for (const row of chunk.changes) {
                    const serialized = serializeDoc(row);
                    batchSentIDs.push(this.getDocKey(row));
                    binarySize += serialized.length;
                    outBuf.push(serialized);

                    if (outBuf.length > maxOutBufLength || binarySize > maxBinarySize) {
                        const sendBuf = concatUInt8Array(outBuf);
                        const bin = await wrappedDeflate(sendBuf, { consume: true, level: 8 });
                        controller.enqueue({ bin, packLastSeq: chunk.packLastSeq, sentIDs: [...batchSentIDs] });
                        outBuf = [];
                        binarySize = 0;
                        batchSentIDs = [];
                    }
                }
            },
            flush: async (controller) => {
                if (outBuf.length > 0) {
                    const sendBuf = concatUInt8Array(outBuf);
                    const bin = await wrappedDeflate(sendBuf, { consume: true, level: 8 });
                    controller.enqueue({ bin, packLastSeq: lastProcessedSeq, sentIDs: [...batchSentIDs] });
                }
            },
        });
    }

    private _createSendUploadWritableStream(max: number) {
        let sentFilesCount = 0;
        return new WritableStream({
            write: async (chunk) => {
                const sendTimeStamp = Date.now();
                const filename = `${sendTimeStamp}-docs.jsonl.gz`;
                const mime = "application/octet-stream";

                const encryptedBin = await this.encryptForUpload(filename, chunk.bin, this.currentSettings);

                const ret = await this.storage.upload(filename, encryptedBin, mime);
                if (!ret) {
                    throw new Error(`Could not send journalPack to the bucket (${filename})`);
                }

                sentFilesCount++;
                this.updateInfo({
                    sent: sentFilesCount,
                    maxPushSeq: max,
                    lastSyncPushSeq: chunk.packLastSeq as number,
                });

                await this.updateCheckPointInfo((info) => ({
                    ...info,
                    lastLocalSeq: chunk.packLastSeq,
                    sentIDs: setAllItems(info.sentIDs, chunk.sentIDs),
                    sentFiles: info.sentFiles.add(filename),
                }));

                Logger(`Uploading journal: Uploaded as ${filename}`, LOG_LEVEL_INFO);
            },
        });
    }

    async sendLocalJournal(showMessage = false) {
        this.updateInfo({ syncStatus: "JOURNAL_SEND" });
        return await shareRunningResult("send_journal_stream", async () => {
            this.requestedStop = false;
            const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
            const MSG_KEY = "pack_journal";

            const max = (await this.db.info()).update_seq as number;
            const checkPointInfo = await this.getCheckpointInfo();
            const startSeq = checkPointInfo.lastLocalSeq as number;
            const seqToProcess = max - startSeq;

            Logger(`Packing Journal: Start sending`, logLevel, MSG_KEY);

            const readable = this._createSendReadableStream(startSeq, logLevel, MSG_KEY);
            const transform = this._createSendCompressTransformStream(startSeq, seqToProcess, logLevel, MSG_KEY);
            const writable = this._createSendUploadWritableStream(max);

            try {
                await readable.pipeThrough(transform).pipeTo(writable);
                if (seqToProcess != 0) {
                    Logger(`Packing Journal: Finished packaging ${seqToProcess}`, logLevel, MSG_KEY);
                } else {
                    Logger(`Packing Journal: No journals to be packed!`, logLevel, MSG_KEY);
                }
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            } catch (ex) {
                Logger(`Packing Journal Error`, logLevel);
                Logger(ex, LOG_LEVEL_VERBOSE);
                this.updateInfo({ syncStatus: "ERRORED" });
                return false;
            }
        });
    }

    async _getRemoteJournals() {
        const checkPointInfo = await this.getCheckpointInfo();
        const StartAfter = [...checkPointInfo.receivedFiles.keys()].sort((a, b) =>
            b.localeCompare(a, undefined, { numeric: true })
        )[0];
        const files = (await this.storage.listFiles(StartAfter)).filter((e) => !e.startsWith("_"));
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
                const e2 = e1.map((e) => (e as { id?: string }).id ?? undefined);
                const existChunks = new Set(e2.filter((e) => e !== undefined));
                const saveChunks = chunks
                    .filter((e) => !existChunks.has(e._id))
                    .map((e) => ({ ...e, _rev: undefined }));
                const ret = await this.db.bulkDocs<EntryDoc>(saveChunks, { new_edits: true });
                const saveError = ret.filter((e) => "error" in e).map((e) => e.id);

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
            } catch (ex) {
                Logger(`Applying chunks failed`, LOG_LEVEL_INFO);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }

            // Docs saving.
            // Docs have different revisions, hence revision comparisons and merging are necessary.
            const params = docs.map((e) => [e._id, [e._rev]] as const);
            const docsRevs = params.reduce(
                (acc, [id, revs]) => {
                    return { ...acc, [id]: [...(acc[id] ?? []), ...revs] };
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

            await this.db.bulkDocs<EntryDoc>(saveDocs, { new_edits: false });

            const writeDoc = !this.env.services.setting.currentSettings().suspendParseReplicationResult;
            if (writeDoc) {
                await this.processReplication(saveDocs satisfies PouchDB.Core.ExistingDocument<EntryDoc>[]);
            }

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

    private _createReceiveReadableStream(files: string[]) {
        return new ReadableStream({
            pull: (controller) => {
                if (this.requestedStop || files.length === 0) {
                    controller.close();
                    return;
                }
                const file = files.shift();
                if (file) {
                    controller.enqueue(file);
                }
            },
        });
    }

    private _createReceiveTransformStream(logLevel: any) {
        let count = 0;
        return new TransformStream({
            transform: async (key: string, controller) => {
                count++;
                Logger(`Receiving Journal: ${count}`, logLevel, "receivejournal");

                const checkPointInfo = await this.getCheckpointInfo();
                if (checkPointInfo.sentFiles.has(key) || checkPointInfo.receivedFiles.has(key)) {
                    Logger(`Receiving Journal: ${key} is already processed`, LOG_LEVEL_VERBOSE);
                    await this.updateCheckPointInfo((info) => ({
                        ...info,
                        receivedFiles: info.receivedFiles.add(key),
                    }));
                    return; // Skip
                }

                try {
                    const encryptedData = await this.storage.download(key, true);
                    if (encryptedData === false) {
                        throw new Error("Download Error");
                    }

                    const data = await this.decryptDownloaded(
                        key,
                        encryptedData as Uint8Array<ArrayBuffer>,
                        this.currentSettings
                    );

                    const decompressed = await wrappedInflate(new Uint8Array(data), { consume: true });
                    if (decompressed.length == 0) {
                        controller.enqueue({ key, docs: [] });
                        return;
                    }

                    let idxFrom = 0;
                    let idxTo = 0;
                    const d = new TextDecoder();
                    const result = [] as ProcessingEntry[];
                    do {
                        idxTo = decompressed.indexOf(0x0a, idxFrom);
                        if (idxTo == -1) break;
                        const piece = decompressed.slice(idxFrom, idxTo);
                        const strPiece = d.decode(piece);
                        if (strPiece.startsWith("~")) {
                            const [idPart, dataPart] = strPiece.substring(1).split(UNIT_SPLIT);
                            result.push({
                                _id: idPart as DocumentID,
                                data: unescapeNewLineFromString(dataPart),
                                type: "leaf",
                                _rev: "",
                            });
                        } else {
                            result.push(JSON.parse(strPiece));
                        }
                        idxFrom = idxTo + 1;
                    } while (idxTo > 0);

                    controller.enqueue({ key, docs: result });
                } catch (ex) {
                    controller.error(ex);
                }
            },
        });
    }

    private _createReceiveWritableStream() {
        let downloaded = 0;
        return new WritableStream({
            write: async (chunk) => {
                const { key, docs } = chunk;
                if (docs.length > 0) {
                    const success = await this.processDocuments(docs);
                    if (!success) {
                        throw new Error(`Could not process downloaded journals for ${key}`);
                    }
                }

                await this.updateCheckPointInfo((info) => ({
                    ...info,
                    receivedFiles: info.receivedFiles.add(key),
                }));
                downloaded++;
                this.updateInfo({ arrived: downloaded, maxPullSeq: downloaded, lastSyncPullSeq: downloaded });
                Logger(`Processing journal: ${key} has been processed`, LOG_LEVEL_INFO);
            },
        });
    }

    async receiveRemoteJournal(showMessage = false) {
        this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" });
        return await shareRunningResult("receive_journal_stream", async () => {
            this.requestedStop = false;
            const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;

            Logger("Receiving Journal: Getting list of remote journal", logLevel, "receivejournal");
            const files = await this._getRemoteJournals();
            if (files.length == 0) {
                Logger(`Receiving Journal: No journals needs to be downloaded`, logLevel, "receivejournal");
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            }

            const readable = this._createReceiveReadableStream(files);
            const transform = this._createReceiveTransformStream(logLevel);
            const writable = this._createReceiveWritableStream();

            try {
                await readable.pipeThrough(transform).pipeTo(writable);
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            } catch (ex) {
                Logger(`Receive Journal Error`, logLevel);
                Logger(ex, LOG_LEVEL_VERBOSE);
                this.updateInfo({ syncStatus: "ERRORED" });
                return false;
            }
        });
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
