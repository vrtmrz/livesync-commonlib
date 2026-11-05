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
    type LOG_LEVEL,
} from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import type { ReplicationCallback, ReplicationStat } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import {
    type SimpleStore,
    concatUInt8Array,
    setAllItems,
    pickBucketSyncSettings,
    pickEncryptionSettings,
} from "@lib/common/utils.ts";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock";
import { wrappedDeflate, wrappedInflate } from "@lib/pouchdb/compress.ts";
import {
    type CheckPointInfo,
    CheckPointInfoDefault,
    type JournalReceiveFailureStage,
    type StoppedJournal,
} from "./JournalSyncTypes.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import {
    JournalStorageReadStatuses,
    type IJournalStorage,
    type JournalStorageConditionalWriteResult,
    type JournalStorageReadResult,
} from "./objectstore/JournalStorageAdapter.ts";

import {
    createSyncParamsHandler,
    type SyncParamsHandler,
    SyncParamsFetchError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
    isSyncParamsError,
} from "@lib/replication/SyncParamsHandler.ts";
import { REMOTE_CHUNK_FETCHED } from "@lib/pouchdb/LiveSyncLocalDB.ts";
import { decryptBinary, encryptBinary } from "octagonal-wheels/encryption/encryption";
import {
    encryptBinary as encryptBinaryHKDF,
    decryptBinary as decryptBinaryHKDF,
} from "octagonal-wheels/encryption/hkdf";

import { assertDatabasePathIdentity } from "@lib/pouchdb/pathIdentityCompatibility.ts";

import { decodeJournalRecords, serializeDoc, type ProcessingEntry } from "./journalRecords.ts";
import { JournalReceiveFailure, isJournalReceiveFailure } from "./JournalReceiveFailure.ts";
import {
    partitionJournalDocuments,
    selectChunksToSave,
    assessChunkWrites,
    journalMetadataRevisions,
    selectMetadataToSave,
    hasJournalWriteErrors,
} from "./journalReceive.ts";

type StoppedJournalState = {
    snapshot: StoppedJournal;
    database: PouchDB.Database<EntryDoc>;
    store: SimpleStore<CheckPointInfo>;
    configuration: string;
    checkpointGeneration: number;
};

type ReceivedJournalChunk = {
    key: string;
    docs: ProcessingEntry[];
    alreadyProcessed?: boolean;
    failure?: JournalReceiveFailure;
};

function isJournalKey(key: string): boolean {
    return !key.startsWith("_");
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
    private syncParamsHandler?: SyncParamsHandler;
    private receiveTask?: Promise<boolean>;
    private stoppedJournal?: StoppedJournalState;
    private checkpointGeneration = 0;

    private receiveConfiguration(): string {
        return JSON.stringify([
            pickBucketSyncSettings({ ...this.currentSettings, ...this._settings }),
            pickEncryptionSettings(this.currentSettings),
            this.currentSettings.pathNormalizationVersion,
            this.currentSettings.handleFilenameCaseSensitive,
        ]);
    }

    private matchesStoppedContext(stopped: StoppedJournalState): boolean {
        return (
            stopped.database === this.db &&
            stopped.store === this.store &&
            stopped.configuration === this.receiveConfiguration() &&
            stopped.checkpointGeneration === this.checkpointGeneration
        );
    }

    /** Return the current failure for presentation before an explicit single-Journal skip. */
    getStoppedJournal(): StoppedJournal | undefined {
        if (this.stoppedJournal && !this.matchesStoppedContext(this.stoppedJournal)) {
            this.stoppedJournal = undefined;
        }
        return this.stoppedJournal?.snapshot;
    }

    /**
     * Acknowledge only the exact failure presented to the user, then resume receipt.
     * Stale snapshots, another active receive, and a later Stop request are rejected.
     * Any subsequent Journal failure stops the resumed operation normally.
     */
    skipStoppedJournalAndResume(stopped: StoppedJournal, showMessage = false): Promise<boolean> {
        if (!stopped || this.receiveTask || this.requestedStop || this.getStoppedJournal() !== stopped) {
            return Promise.resolve(false);
        }
        return this.startReceive(showMessage, this.stoppedJournal);
    }

    getInitialSyncParameters(): Promise<SyncParameters> {
        return Promise.resolve({
            ...DEFAULT_SYNC_PARAMETERS,
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: "",
        } satisfies SyncParameters);
    }

    async getSyncParameters(): Promise<SyncParameters> {
        try {
            const result = await this.storage.downloadWithResult(DOCID_JOURNAL_SYNC_PARAMETERS, true);
            if (result.status === JournalStorageReadStatuses.NOT_FOUND) {
                throw new SyncParamsNotFoundError(`Missing sync parameters`);
            }
            if (result.status === JournalStorageReadStatuses.UNAVAILABLE) {
                throw SyncParamsFetchError.fromError(result.error);
            }
            const downloadedSyncParams = JSON.parse(new TextDecoder().decode(result.value)) as SyncParameters;
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

    async downloadJsonWithResult<T>(key: string): Promise<JournalStorageReadResult<T>> {
        const result = await this.storage.downloadWithResult(key, true);
        if (result.status !== JournalStorageReadStatuses.AVAILABLE) return result;
        try {
            return {
                status: JournalStorageReadStatuses.AVAILABLE,
                value: JSON.parse(new TextDecoder().decode(result.value)) as T,
                ...(result.revision === undefined ? {} : { revision: result.revision }),
            };
        } catch (ex) {
            Logger(`Could not parse downloaded json ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return {
                status: JournalStorageReadStatuses.UNAVAILABLE,
                error: ex,
            };
        }
    }

    async uploadJsonIfUnchanged<T>(
        key: string,
        body: T,
        revision: string
    ): Promise<JournalStorageConditionalWriteResult> {
        if (revision.trim().length === 0) {
            throw new TypeError("A non-empty revision is required for a conditional upload");
        }
        const uploadIfUnchanged = this.storage.uploadIfUnchanged;
        if (!uploadIfUnchanged) return "unsupported";
        const data = new TextEncoder().encode(JSON.stringify(body));
        return await uploadIfUnchanged.call(this.storage, key, data, "application/json", revision);
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
        this.resetAllCaches();
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
        this.stoppedJournal = undefined;
        this.checkpointGeneration++;
        const checkPointKey = `bucketsync-checkpoint-${this.hash}` as DocumentID;
        const old = await this.getCheckpointInfo();
        const newInfo = func(old);
        await this.store.set(checkPointKey, newInfo);
        this._currentCheckPointInfo = newInfo;
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
        this.syncParamsHandler = undefined;
    }

    async resetCheckpointInfo() {
        await this.updateCheckPointInfo(() => ({
            ...CheckPointInfoDefault,
            knownIDs: new Set<string>(),
            sentIDs: new Set<string>(),
            receivedFiles: new Set<string>(),
            sentFiles: new Set<string>(),
        }));
    }

    private getJournalEpochFromSyncParams(params: SyncParameters): string {
        return `${params.protocolVersion}:${params.pbkdf2salt}`;
    }

    async ensureCheckpointCachesAreFresh(): Promise<void> {
        // This fresh read also prepares the Security Seed before compatibility
        // checks can write a milestone. Encrypted files reuse this snapshot.
        const params = await this.getSyncParamsHandler().fetch(true);
        if (!params) throw new SyncParamsFetchError("Could not prepare Journal synchronisation parameters");
        const journalEpoch = this.getJournalEpochFromSyncParams(params);

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
    }

    async isAvailable(): Promise<boolean> {
        return await this.storage.isAvailable();
    }

    async resetBucket(): Promise<boolean> {
        this.resetAllCaches();
        try {
            // Retain identity and decryption evidence until every Journal has been deleted.
            const skippedFiles: string[] = [];
            let from = "";
            let files: string[];
            do {
                files = await this.storage.listFiles(from, 100);
                if (files.length > 0) {
                    const nextFrom = files[files.length - 1];
                    if (nextFrom <= from) {
                        throw new Error("Journal reset listing did not advance. Control documents have been retained.");
                    }
                    skippedFiles.push(...files.filter((key) => !isJournalKey(key)));
                    const journals = files.filter(isJournalKey);
                    if (journals.length > 0 && !(await this.storage.deleteFiles(journals))) return false;
                    from = nextFrom;
                }
            } while (files.length > 0);

            while (skippedFiles.length > 0) {
                if (!(await this.storage.deleteFiles(skippedFiles.splice(0, 100)))) return false;
            }
        } catch (ex) {
            Logger(`WARNING! Could not delete files.`, LOG_LEVEL_NOTICE, "reset-bucket");
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }

        await this.resetCheckpointInfo();
        Logger("Remote bucket cleared", LOG_LEVEL_NOTICE);
        return true;
    }

    getRemoteKey(): string {
        return this.getHash(this._settings);
    }

    async getReplicationPBKDF2Salt(refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return await this.getSyncParamsHandler().getPBKDF2Salt(refresh);
    }

    private getSyncParamsHandler(): SyncParamsHandler {
        return (this.syncParamsHandler ??= createSyncParamsHandler({
            put: (params: SyncParameters) => this.putSyncParameters(params),
            get: () => this.getSyncParameters(),
            create: () => this.getInitialSyncParameters(),
        }));
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
            if (isSyncParamsError(ex)) {
                throw ex;
            }
            Logger(`Failed to decrypt in v2. Falling back to v1: ${key}`, LOG_LEVEL_INFO);
            try {
                const r = await this.decryptDataV1(u, set);
                Logger(`Decrypted in v1: ${key}`, LOG_LEVEL_VERBOSE);
                return r;
            } catch (ex2) {
                Logger(`Could not decrypt in v1: ${key}`, LOG_LEVEL_VERBOSE);
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

    private _createSendReadableStream(startSeq: number, logLevel: LOG_LEVEL, MSG_KEY: string) {
        let currentLastSeq = startSeq;
        return new ReadableStream({
            pull: async (controller) => {
                while (true) {
                    if (this.requestedStop) {
                        Logger("Packing Journal : Stop requested", logLevel, MSG_KEY);
                        controller.close();
                        return;
                    }
                    const { changes, hasNext, packLastSeq } = await this._createJournalPack(currentLastSeq);
                    currentLastSeq = packLastSeq as number;
                    if (changes.length > 0) {
                        controller.enqueue({ changes, packLastSeq });
                        return;
                    }
                    if (!hasNext) {
                        controller.close();
                        return;
                    }
                }
            },
        });
    }

    private _createSendCompressTransformStream(
        startSeq: number,
        seqToProcess: number,
        logLevel: LOG_LEVEL,
        MSG_KEY: string,
        stats: { packedDocs: number }
    ) {
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
                    stats.packedDocs++;

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

    private _createSendUploadWritableStream(
        max: number,
        logLevel: LOG_LEVEL,
        MSG_KEY: string,
        stats: { uploadedFiles: number }
    ) {
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
                stats.uploadedFiles++;
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

                Logger(`Uploading journal: ${sentFilesCount} / ...`, logLevel, MSG_KEY);
            },
        });
    }

    async sendLocalJournal(showMessage = false) {
        await assertDatabasePathIdentity(this.db, this.currentSettings);
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

            const stats = { packedDocs: 0, uploadedFiles: 0 };
            const readable = this._createSendReadableStream(startSeq, logLevel, MSG_KEY);
            const transform = this._createSendCompressTransformStream(startSeq, seqToProcess, logLevel, MSG_KEY, stats);
            const writable = this._createSendUploadWritableStream(max, logLevel, `${MSG_KEY}_upload`, stats);

            try {
                await readable.pipeThrough(transform).pipeTo(writable);
                if (seqToProcess != 0) {
                    Logger(
                        `Packing Journal: Finished. Processed ${stats.packedDocs} doc(s) into ${stats.uploadedFiles} chunk(s)`,
                        logLevel,
                        MSG_KEY
                    );
                    if (stats.uploadedFiles > 0) {
                        Logger(
                            `Uploading journal: All ${stats.uploadedFiles} chunk(s) uploaded`,
                            logLevel,
                            `${MSG_KEY}_upload`
                        );
                    }
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

    async hasRemoteJournals(): Promise<boolean> {
        return (await this.storage.listFiles("", 1)).some(isJournalKey);
    }

    async _getRemoteJournals() {
        const checkPointInfo = await this.getCheckpointInfo();
        const StartAfter = [...checkPointInfo.receivedFiles.keys()].sort((a, b) =>
            b.localeCompare(a, undefined, { numeric: true })
        )[0];
        const files = (await this.storage.listFiles(StartAfter)).filter(isJournalKey);
        if (!files) return [];
        return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    async processDocuments(allDocs: ProcessingEntry[]) {
        try {
            await this.processDocumentsForReceive(allDocs);
            return true;
        } catch {
            Logger("Applying journal failed", LOG_LEVEL_INFO);
            return false;
        }
    }

    private async processDocumentsForReceive(allDocs: ProcessingEntry[], key?: string): Promise<void> {
        const { chunks, docs } = partitionJournalDocuments(allDocs);
        const chunkRows = (await this.db.allDocs({ include_docs: true, keys: chunks.map((entry) => entry._id) })).rows;
        const saveChunks = selectChunksToSave(chunks, chunkRows);

        let chunkResults: (PouchDB.Core.Error | PouchDB.Core.Response)[];
        try {
            chunkResults = await this.db.bulkDocs<EntryDoc>(saveChunks, { new_edits: true });
        } catch (error) {
            throw new JournalReceiveFailure("chunk-write", key);
        }

        const chunkWrites = assessChunkWrites(saveChunks, chunkResults);
        chunkWrites.persisted.forEach((entry) =>
            this.env.services.context.events.emitEvent(REMOTE_CHUNK_FETCHED, entry as EntryLeaf)
        );
        if (chunkWrites.failed) {
            throw new JournalReceiveFailure("chunk-write", key);
        }

        await this.updateCheckPointInfo((info) => ({
            ...info,
            knownIDs: setAllItems(
                info.knownIDs,
                chunks.map((entry) => this.getDocKey(entry))
            ),
        }));

        const diffRevs = await this.db.revsDiff(journalMetadataRevisions(docs));
        const saveDocs = selectMetadataToSave(docs, diffRevs);

        let metadataResults: (PouchDB.Core.Error | PouchDB.Core.Response)[];
        try {
            metadataResults = await this.db.bulkDocs<EntryDoc>(saveDocs, { new_edits: false });
        } catch (error) {
            throw new JournalReceiveFailure("metadata-write", key);
        }
        if (hasJournalWriteErrors(metadataResults)) {
            throw new JournalReceiveFailure("metadata-write", key);
        }

        const writeDoc = !this.currentSettings.suspendParseReplicationResult;
        if (writeDoc) {
            // Re-deliver all Metadata in the Journal so a retry also reflects revisions
            // persisted before an earlier partial write failed.
            await this.processReplication(docs satisfies PouchDB.Core.ExistingDocument<EntryDoc>[]);
        }

        await this.updateCheckPointInfo((info) => ({
            ...info,
            knownIDs: setAllItems(
                info.knownIDs,
                docs.map((entry) => this.getDocKey(entry))
            ),
        }));

        const applyTotal = saveDocs.length;
        const wholeItems = docs.length;
        Logger(
            "Applied " + applyTotal + " of " + wholeItems + " docs (" + (wholeItems - applyTotal) + " skipped)",
            LOG_LEVEL_VERBOSE
        );
    }

    private _createReceiveReadableStream(files: string[]) {
        return new ReadableStream<string>({
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

    private _createReceiveTransformStream(logLevel: LOG_LEVEL) {
        let count = 0;
        return new TransformStream<string, ReceivedJournalChunk>({
            transform: async (key, controller) => {
                count++;
                Logger("Receiving Journal: " + count, logLevel, "receivejournal");

                const checkpointInfo = await this.getCheckpointInfo();
                if (checkpointInfo.sentFiles.has(key) || checkpointInfo.receivedFiles.has(key)) {
                    Logger("Receiving Journal: " + key + " is already processed", LOG_LEVEL_VERBOSE);
                    controller.enqueue({ key, docs: [], alreadyProcessed: true });
                    return;
                }

                const enqueueFailure = (stage: JournalReceiveFailureStage) => {
                    controller.enqueue({
                        key,
                        docs: [],
                        failure: new JournalReceiveFailure(stage, key),
                    });
                };

                let downloadResult: JournalStorageReadResult<Uint8Array>;
                try {
                    downloadResult = await this.storage.downloadWithResult(key, true);
                } catch (error) {
                    controller.error(error);
                    return;
                }
                if (downloadResult.status === JournalStorageReadStatuses.NOT_FOUND) {
                    enqueueFailure("download");
                    return;
                }
                if (downloadResult.status === JournalStorageReadStatuses.UNAVAILABLE) {
                    controller.error(new Error("Journal download unavailable"));
                    return;
                }

                const settings = this.currentSettings;
                let data: Uint8Array<ArrayBuffer>;
                try {
                    data = await this.decryptDownloaded(key, downloadResult.value as Uint8Array<ArrayBuffer>, settings);
                } catch (error) {
                    if (isSyncParamsError(error)) {
                        controller.error(error);
                    } else {
                        enqueueFailure("decrypt");
                    }
                    return;
                }

                let decompressed: Uint8Array<ArrayBuffer>;
                try {
                    decompressed = await wrappedInflate(new Uint8Array(data), { consume: true });
                } catch {
                    enqueueFailure("inflate");
                    return;
                }
                const decoded = decodeJournalRecords(decompressed);
                if (decoded.ok === false) {
                    enqueueFailure(decoded.stage);
                    return;
                }
                controller.enqueue({ key, docs: decoded.docs });
            },
        });
    }

    private _createReceiveWritableStream() {
        let downloaded = 0;
        return new WritableStream<ReceivedJournalChunk>({
            write: async (chunk) => {
                const { key, docs } = chunk;
                const checkpointInfo = await this.getCheckpointInfo();
                if (
                    chunk.alreadyProcessed ||
                    checkpointInfo.sentFiles.has(key) ||
                    checkpointInfo.receivedFiles.has(key)
                ) {
                    await this.updateCheckPointInfo((info) => {
                        const receivedFiles = new Set(info.receivedFiles);
                        receivedFiles.add(key);
                        return { ...info, receivedFiles };
                    });
                    return;
                }

                let failure = chunk.failure;
                if (!failure && docs.length > 0) {
                    try {
                        await this.processDocumentsForReceive(docs, key);
                    } catch (error) {
                        if (isJournalReceiveFailure(error)) {
                            failure = error;
                        } else {
                            throw error;
                        }
                    }
                }
                if (failure) throw new JournalReceiveFailure(failure.stage, key);

                await this.updateCheckPointInfo((info) => {
                    const receivedFiles = new Set(info.receivedFiles);
                    receivedFiles.add(key);
                    return { ...info, receivedFiles };
                });
                downloaded++;
                this.updateInfo({ arrived: downloaded, maxPullSeq: downloaded, lastSyncPullSeq: downloaded });
                Logger("Processing journal: " + key + " has been processed", LOG_LEVEL_INFO);
            },
        });
    }

    /** Receive until completion, a failure, or an explicit Stop request. */
    receiveRemoteJournal(showMessage = false): Promise<boolean> {
        return this.receiveTask ?? this.startReceive(showMessage);
    }

    private startReceive(showMessage: boolean, stopped?: StoppedJournalState): Promise<boolean> {
        this.stoppedJournal = undefined;
        this.requestedStop = false;
        const task = Promise.resolve()
            .then(() => this.performReceive(showMessage, stopped))
            .finally(() => {
                if (this.receiveTask === task) this.receiveTask = undefined;
            });
        this.receiveTask = task;
        return task;
    }

    private async prepareStoppedJournalSkip(files: string[], stopped: StoppedJournalState) {
        const checkpoint = await this.getCheckpointInfo();
        const nextKey = files.find((key) => !checkpoint.sentFiles.has(key) && !checkpoint.receivedFiles.has(key));
        if (this.requestedStop || !this.matchesStoppedContext(stopped) || nextKey !== stopped.snapshot.key) {
            Logger(
                "The stopped Journal has changed. Retry replication before choosing a Journal to skip.",
                LOG_LEVEL_NOTICE,
                "receivejournal"
            );
            this.updateInfo({ syncStatus: this.requestedStop ? "CLOSED" : "ERRORED" });
            return undefined;
        }
        await this.updateCheckPointInfo((info) => ({
            ...info,
            receivedFiles: setAllItems(new Set(info.receivedFiles), [stopped.snapshot.key]),
        }));
        return files.filter((key) => key !== stopped.snapshot.key);
    }

    private recordReceiveFailure(
        error: unknown,
        logLevel: LOG_LEVEL,
        context: Pick<StoppedJournalState, "database" | "store" | "configuration">
    ): void {
        if (!isJournalReceiveFailure(error)) return;
        Logger("Receive Journal " + (error.key ?? "item") + " failed at " + error.stage, logLevel, "receivejournal");
        if (
            !this.requestedStop &&
            error.key &&
            context.database === this.db &&
            context.store === this.store &&
            context.configuration === this.receiveConfiguration()
        ) {
            this.stoppedJournal = {
                snapshot: Object.freeze({ key: error.key, stage: error.stage }),
                ...context,
                checkpointGeneration: this.checkpointGeneration,
            };
        }
    }

    private async receiveJournalFiles(files: string[], logLevel: LOG_LEVEL): Promise<boolean> {
        if (this.requestedStop) {
            this.updateInfo({ syncStatus: "CLOSED" });
            return false;
        }
        if (files.length === 0) {
            Logger("Receiving Journal: No journals needs to be downloaded", logLevel, "receivejournal");
            this.updateInfo({ syncStatus: "COMPLETED" });
            return true;
        }
        const readable = this._createReceiveReadableStream(files);
        const transform = this._createReceiveTransformStream(logLevel);
        const writable = this._createReceiveWritableStream();
        await readable.pipeThrough(transform).pipeTo(writable);
        if (this.requestedStop) {
            Logger("Receive Journal closed after the active operation", LOG_LEVEL_NOTICE, "receivejournal");
            this.updateInfo({ syncStatus: "CLOSED" });
            return false;
        }
        this.updateInfo({ syncStatus: "COMPLETED" });
        return true;
    }

    private async performReceive(showMessage: boolean, stopped?: StoppedJournalState): Promise<boolean> {
        const database = this.db;
        const store = this.store;
        const configuration = this.receiveConfiguration();
        await assertDatabasePathIdentity(database, this.currentSettings);
        this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" });
        const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        let skippedKey: string | undefined;
        try {
            Logger("Receiving Journal: Getting list of remote journal", logLevel, "receivejournal");
            let files = await this._getRemoteJournals();
            if (this.requestedStop) {
                this.updateInfo({ syncStatus: "CLOSED" });
                return false;
            }
            if (stopped) {
                const remainingFiles = await this.prepareStoppedJournalSkip(files, stopped);
                if (!remainingFiles) return false;
                skippedKey = stopped.snapshot.key;
                files = remainingFiles;
                Logger(
                    "Skipping Journal " +
                        skippedKey +
                        " at " +
                        stopped.snapshot.stage +
                        " by explicit request. Content or history may remain missing.",
                    LOG_LEVEL_NOTICE,
                    "receivejournal"
                );
            }
            return await this.receiveJournalFiles(files, logLevel);
        } catch (error) {
            Logger(
                this.requestedStop
                    ? "Receive Journal closed after an active operation failed"
                    : "Receive Journal Error",
                this.requestedStop ? LOG_LEVEL_NOTICE : logLevel,
                "receivejournal"
            );
            this.recordReceiveFailure(error, logLevel, { database, store, configuration });
            this.updateInfo({ syncStatus: this.requestedStop ? "CLOSED" : "ERRORED" });
            return false;
        } finally {
            if (skippedKey) {
                Logger("Receiving Journal: explicitly skipped " + skippedKey, LOG_LEVEL_NOTICE, "receivejournal");
            }
        }
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
        this.stoppedJournal = undefined;
        this.requestedStop = true;
    }

    /** Stop this Journal operation owner and release its storage transport. */
    dispose(): void {
        this.requestStop();
        this.resetAllCaches();
        this.storage.dispose?.();
    }
}
