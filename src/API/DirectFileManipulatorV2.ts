import { MemoryValueStore } from "@vrtmrz/value-store";
import { createDirectChunkFetchSource } from "@lib/managers/chunkFetchSource.ts";
/**
 * The API for manipulating files stored in the CouchDB by Self-hosted LiveSync or its families.
 */
import {
    type DocumentID,
    type FilePathWithPrefix,
    type EntryHasPath,
    type FilePath,
    type EntryDoc,
    type NewEntry,
    type PlainEntry,
    type LoadedEntry,
    DEFAULT_SETTINGS,
    type HashAlgorithm,
    type ObsidianLiveSyncSettings,
    type RemoteDBSettings,
    type ChunkSplitterVersion,
    type SyncParameters,
    DEFAULT_SYNC_PARAMETERS,
    ProtocolVersions,
    DOCID_SYNC_PARAMETERS,
    VERSIONING_DOCID,
    type E2EEAlgorithm,
    E2EEAlgorithms,
    VER,
} from "@lib/common/types.ts";
import { checkRemoteVersion } from "@lib/pouchdb/negotiation.ts";
import {
    assessRemoteFeatureDocument,
    NFC_PATH_IDENTITY_FEATURE,
    requiredRemoteFeatures,
    usesEncryptedInternalMetadata,
} from "@lib/pouchdb/remoteFeatureCompatibility.ts";
import { assessRemoteDocumentIds } from "@lib/pouchdb/remoteIdCompatibility.ts";

import { PouchDB } from "@lib/pouchdb/pouchdb-http.ts";
import { LiveSyncLocalDB, type LiveSyncLocalDBEnv } from "@lib/pouchdb/LiveSyncLocalDB.ts";
import { isErrorOfMissingDoc } from "@lib/pouchdb/utils_couchdb.ts";
import { replicationFilter } from "@lib/pouchdb/compress.ts";
import { disableEncryption } from "@lib/pouchdb/encryption.ts";
import { enableEncryption } from "@lib/pouchdb/encryption.ts";
import {
    LEVEL_INFO,
    LEVEL_VERBOSE,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    Logger,
} from "octagonal-wheels/common/logger";
import { createBlob, determineTypeFromBlob } from "@lib/common/utils.ts";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    createSyncParamsHanderForServer,
    SyncParamsFetchError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
} from "@lib/replication/SyncParamsHandler.ts";

import { HeadlessServiceHub } from "@lib/services/HeadlessServices.ts";
import { HeadlessDatabaseService } from "@lib/services/implements/headless/HeadlessDatabaseService.ts";
import { ServiceContext } from "@lib/services/base/ServiceBase.ts";
import type { InjectableSettingService } from "@lib/services/implements/injectable/InjectableSettingService.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";

export type DirectFileManipulatorOptions = {
    url: string;
    username: string;
    password: string;
    passphrase: string | undefined;
    database: string;
    obfuscatePassphrase: string | undefined;
    idDerivationVersion?: 0 | 1;
    idDerivationKey?: string;
    encryptInternalMetadata?: boolean;
    useDynamicIterationCount?: boolean;
    customChunkSize?: number;
    minimumChunkSize?: number;
    hashAlg?: HashAlgorithm;
    useEden?: boolean;
    maxChunksInEden?: number;
    maxTotalLengthInEden?: number;
    maxAgeInEden?: number;
    /** Enables synchronisation of dot-prefixed internal files. */
    syncInternalFiles?: boolean;
    /**
     * @deprecated use chunkSplitterVersion instead.
     */
    enableChunkSplitterV2?: boolean;
    enableCompression?: boolean;
    handleFilenameCaseSensitive?: boolean;
    /**
     * @deprecated Chunk revisions are always derived from their content.
     */
    doNotUseFixedRevisionForChunks?: boolean;
    chunkSplitterVersion?: ChunkSplitterVersion;
    E2EEAlgorithm?: E2EEAlgorithm;
};

/** Host runtime capabilities used by a direct CouchDB connection. */
export type DirectFileManipulatorRuntimeOptions = Readonly<{
    /** Fetch implementation passed to PouchDB. Omit it to use PouchDB's default transport. */
    fetch?: typeof globalThis.fetch;
}>;

export type ReadyEntry = (NewEntry | PlainEntry) & { data: string[] };
export type MetaEntry = (NewEntry | PlainEntry) & { children: string[] };

function isNoteEntry(doc: EntryDoc | false): doc is NewEntry | PlainEntry {
    if (!doc) return false;
    return doc.type == "newnote" || doc.type == "plain";
}
function isReadyEntry(doc: EntryDoc | false): doc is ReadyEntry {
    if (!doc) return false;
    return "data" in doc;
}
// function isMetaEntry(doc: EntryDoc | false): doc is MetaEntry {
//     if (!doc) return false;
//     return "children" in doc;
// }

export type FileInfo = {
    ctime: number;
    mtime: number;
    size: number;
};

export type EnumerateConditions = {
    startKey?: string;
    endKey?: string;
    ids?: string[];
    metaOnly: boolean;
};

export class DirectFileManipulator implements LiveSyncLocalDBEnv {
    liveSyncLocalDB: LiveSyncLocalDB;
    options: DirectFileManipulatorOptions;
    readonly runtimeOptions: DirectFileManipulatorRuntimeOptions;
    ready = promiseWithResolvers<void>();
    services: HeadlessServiceHub<ServiceContext>;
    public async init() {
        try {
            await this.services.appLifecycle.onReady();
            if (!(await this.liveSyncLocalDB.initializeDatabase())) {
                throw new Error("Direct database initialisation was rejected.");
            }
            const idSettings = {
                ...this.settings,
                passphrase: this.options.obfuscatePassphrase || this.settings.passphrase,
            };
            const idCompatibility = await assessRemoteDocumentIds(
                this.liveSyncLocalDB.localDatabase,
                idSettings,
                (path) => this.services.path.path2idWithSettings(path, idSettings)
            );
            if (idCompatibility === "mismatched") {
                throw new Error("Direct database document IDs do not match the configured ID key.");
            }
            try {
                const versionInfo = await this.liveSyncLocalDB.localDatabase.get(VERSIONING_DOCID);
                const assessment = assessRemoteFeatureDocument(versionInfo);
                if (assessment.status === "supported" && assessment.usedFeatures.includes(NFC_PATH_IDENTITY_FEATURE)) {
                    throw new Error("Direct database version or features are not compatible.");
                }
            } catch (error) {
                if (!isErrorOfMissingDoc(error)) throw error;
            }
            const requiredFeatures = requiredRemoteFeatures(this.settings);
            if (
                !(await checkRemoteVersion(
                    this.liveSyncLocalDB.localDatabase,
                    async () => false,
                    VER,
                    requiredFeatures
                ))
            ) {
                throw new Error("Direct database version or features are not compatible.");
            }
            this.liveSyncLocalDB.refreshSettings();
            this.ready.resolve();
        } catch (error) {
            this.ready.reject(error);
        }
    }
    getBoundDatabaseService(
        options: () => DirectFileManipulatorOptions,
        runtimeOptions: DirectFileManipulatorRuntimeOptions
    ): typeof HeadlessDatabaseService {
        const _option = options;
        const _runtimeOptions = runtimeOptions;
        return class HeadlessDatabaseServiceExt<T extends ServiceContext> extends HeadlessDatabaseService<T> {
            override createPouchDBInstance<T extends object>(
                _name?: string,
                _options?: PouchDB.Configuration.DatabaseConfiguration
            ): PouchDB.Database<T> {
                const option = _option();
                const pouchDBOptions: PouchDB.Configuration.DatabaseConfiguration = {
                    auth: { username: option.username, password: option.password },
                };
                if (_runtimeOptions.fetch) {
                    pouchDBOptions.fetch = _runtimeOptions.fetch;
                }
                return new PouchDB(option.url + "/" + option.database, pouchDBOptions);
            }
        };
    }

    constructor(options: DirectFileManipulatorOptions, runtimeOptions: DirectFileManipulatorRuntimeOptions = {}) {
        this.options = options;
        this.runtimeOptions = runtimeOptions;
        const getSettings = () => this.settings;
        const context = new ServiceContext();
        this.services = new HeadlessServiceHub(context, {
            deviceValues: new MemoryValueStore(),
            pouchDB: PouchDB,
            database: this.getBoundDatabaseService(() => this.options, this.runtimeOptions),
            getPathObfuscationPassphrase: () => this.options.obfuscatePassphrase ?? false,
            databaseLifecycleMode: "direct-access",
        });

        // (this.services.setting as InjectableSettingService<ServiceContext>).currentSettings.setHandler(
        //     getSettings.bind(this)
        // );
        (this.services.setting as InjectableSettingService<ServiceContext>).saveData.setHandler((data) => {
            console.warn("Saving settings is not supported in DirectFileManipulator.");
            return Promise.resolve();
        });
        (this.services.setting as InjectableSettingService<ServiceContext>).loadData.setHandler(() => {
            console.warn("Loading settings is not supported in DirectFileManipulator.");
            return Promise.resolve(getSettings());
        });
        this.services.setting.settings = getSettings();
        // this.services.database.createPouchDBInstance.setHandler(this.$$createPouchDBInstance.bind(this));
        this.services.databaseEvents.onDatabaseInitialisation.addHandler(this.$everyOnInitializeDatabase.bind(this));
        this.liveSyncLocalDB = new LiveSyncLocalDB(this.options.url, this, {
            createChunkFetchSource: createDirectChunkFetchSource,
        });
        // Callers observe constructor-started initialisation through `ready`. Register a
        // handler immediately so a failure cannot become an unhandled rejection before
        // the host starts awaiting that promise.
        void this.ready.promise.catch((): void => {});
        void this.init();
    }

    $$id2path(id: DocumentID, entry?: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix {
        return this.services.path.id2path(id, entry, stripPrefix);
    }
    async $$path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        return await this.services.path.path2id(filename, prefix);
    }
    // $$createPouchDBInstance<T extends object>(
    //     _name?: string,
    //     _options?: PouchDB.Configuration.DatabaseConfiguration
    // ): PouchDB.Database<T> {
    //     return new PouchDB(this.options.url + "/" + this.options.database, {
    //         auth: { username: this.options.username, password: this.options.password },
    //     });
    // }

    getInitialSyncParameters(setting: RemoteDBSettings): Promise<SyncParameters> {
        // TODO: Switch to select protocolVersion based on the setting.
        return Promise.resolve({
            ...DEFAULT_SYNC_PARAMETERS,
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
        } satisfies SyncParameters);
    }
    async getSyncParameters(setting: RemoteDBSettings): Promise<SyncParameters> {
        try {
            const downloadedSyncParams = await this.rawGet<SyncParameters>(DOCID_SYNC_PARAMETERS);
            if (!downloadedSyncParams) {
                throw new SyncParamsNotFoundError(`Sync parameters have not been found in the database.`);
            }
            return downloadedSyncParams;
        } catch (ex) {
            Logger(`Could not retrieve remote sync parameters`, LOG_LEVEL_INFO);
            throw SyncParamsFetchError.fromError(ex);
        }
    }
    async putSyncParameters(setting: RemoteDBSettings, params: SyncParameters): Promise<boolean> {
        try {
            const ret = await this.liveSyncLocalDB.putRaw(params as unknown as EntryDoc);
            if (ret.ok) {
                return true;
            }
            throw new SyncParamsUpdateError(`Could not store remote sync parameters`);
        } catch (ex) {
            Logger(`Could not store remote sync parameters`, LOG_LEVEL_INFO);
            throw SyncParamsUpdateError.fromError(ex);
        }
    }
    async getReplicationPBKDF2Salt(setting: RemoteDBSettings, refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        const server = `${setting.couchDB_URI.replace(/\/+$/, "")}/${setting.couchDB_DBNAME}`;
        const manager = createSyncParamsHanderForServer(server, {
            put: (params: SyncParameters) => this.putSyncParameters(setting, params),
            get: () => this.getSyncParameters(setting),
            create: () => this.getInitialSyncParameters(setting),
        });
        return await manager.getPBKDF2Salt(refresh);
    }
    $everyOnInitializeDatabase(db: LiveSyncLocalDB): Promise<boolean> {
        replicationFilter(db.localDatabase, this.options.enableCompression ?? false);
        disableEncryption();
        if (this.options.passphrase && typeof this.options.passphrase === "string") {
            enableEncryption(
                db.localDatabase,
                this.options.passphrase,
                this.options.useDynamicIterationCount ?? false,
                false,
                async () => await this.getReplicationPBKDF2Salt(this.getSettings()),
                this.options.E2EEAlgorithm ?? E2EEAlgorithms.V2,
                usesEncryptedInternalMetadata(this.settings)
            );
        }
        return Promise.resolve(true);
    }

    getSettings(): RemoteDBSettings {
        return this.settings;
    }
    async close() {
        this.endWatch();
        await this.liveSyncLocalDB.close();
        return this.liveSyncLocalDB.onunload();
    }
    async path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        return await this.services.path.path2id(filename, prefix);
    }

    get settings() {
        const retObj: ObsidianLiveSyncSettings = {
            ...DEFAULT_SETTINGS,
            ...{
                minimumChunkSize: this.options.minimumChunkSize ?? DEFAULT_SETTINGS.minimumChunkSize,
                encrypt: this.options.passphrase ? true : false,
                passphrase: this.options.passphrase ?? "",
                idDerivationVersion: this.options.idDerivationVersion ?? 0,
                idDerivationKey: this.options.idDerivationKey ?? "",
                deleteMetadataOfDeletedFiles: DEFAULT_SETTINGS.deleteMetadataOfDeletedFiles,
                customChunkSize: this.options.customChunkSize ?? DEFAULT_SETTINGS.customChunkSize,
                doNotPaceReplication: DEFAULT_SETTINGS.doNotPaceReplication,
                hashAlg: this.options.hashAlg ?? DEFAULT_SETTINGS.hashAlg,
                useEden: this.options.useEden ?? DEFAULT_SETTINGS.useEden,
                maxChunksInEden: this.options.maxChunksInEden ?? DEFAULT_SETTINGS.maxChunksInEden,
                maxTotalLengthInEden: this.options.maxTotalLengthInEden ?? DEFAULT_SETTINGS.maxTotalLengthInEden,
                maxAgeInEden: this.options.maxAgeInEden ?? DEFAULT_SETTINGS.maxAgeInEden,
                enableChunkSplitterV2: this.options.enableChunkSplitterV2 ?? DEFAULT_SETTINGS.enableChunkSplitterV2,
                chunkSplitterVersion: this.options.chunkSplitterVersion ?? DEFAULT_SETTINGS.chunkSplitterVersion,
                disableWorkerForGeneratingChunks: true,
                processSmallFilesInUIThread: true,
                doNotUseFixedRevisionForChunks:
                    this.options.doNotUseFixedRevisionForChunks ?? DEFAULT_SETTINGS.doNotUseFixedRevisionForChunks,
                couchDB_URI: this.options.url,
                couchDB_DBNAME: this.options.database,
                couchDB_USER: this.options.username,
                couchDB_PASSWORD: this.options.password,
                accessKey: "",
                secretKey: "",
                bucket: "",
                region: "",
                endpoint: "",
                enableCompression: this.options.enableCompression ?? DEFAULT_SETTINGS.enableCompression,
                handleFilenameCaseSensitive:
                    this.options.handleFilenameCaseSensitive ?? DEFAULT_SETTINGS.handleFilenameCaseSensitive,
                usePathObfuscation: !!this.options.obfuscatePassphrase,
                encryptInternalMetadata: this.options.encryptInternalMetadata ?? false,
                syncInternalFiles: this.options.syncInternalFiles ?? DEFAULT_SETTINGS.syncInternalFiles,
                E2EEAlgorithm: this.options.E2EEAlgorithm ?? E2EEAlgorithms.V2,
            },
        };
        return retObj;
    }

    /**
     * Get specific document from the Remote Database by path.
     * @param path
     * @param metaOnly if it has been enabled, the note does not contains the content.
     * @returns
     */
    async get(path: FilePathWithPrefix, metaOnly = false) {
        if (metaOnly) {
            return await this.liveSyncLocalDB.getDBEntryMeta(path);
        } else {
            return await this.liveSyncLocalDB.getDBEntry(path);
        }
    }

    /**
     * Get specific document from the Remote Database by ID.
     * @param path
     * @param metaOnly if it has been enabled, the note does not contains the content.
     * @returns
     */
    async getById(id: string, metaOnly = false): Promise<false | MetaEntry | ReadyEntry> {
        // TODO: TREAT FOR CONFLICTED FILES or OLD REVISIONS.
        // Logger(`GET: START: ${id}`, LOG_LEVEL_VERBOSE)
        const meta = await this.liveSyncLocalDB.getRaw(id as DocumentID);
        if (!isNoteEntry(meta)) return false;
        if (metaOnly) {
            // Logger(`GET: DONE (METAONLY): ${id}`, LOG_LEVEL_INFO)
            return meta;
        }
        return this.getByMeta(meta);
    }
    async getByMeta(doc: MetaEntry): Promise<ReadyEntry> {
        const docX = await this.liveSyncLocalDB.getDBEntryFromMeta(doc as LoadedEntry);
        if (!isReadyEntry(docX)) {
            throw new Error(`Corrupted document: ${doc.path}`);
        }
        return docX;
    }

    async rawGet<T>(id: DocumentID): Promise<false | T> {
        try {
            const doc = await this.liveSyncLocalDB.getRaw(id);
            return doc as T;
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
            throw ex;
        }
    }

    /**
     * Put a note to the remote database
     * @param path
     * @param data
     * @param info
     * @param type
     * @returns
     */
    async put(path: string, data: string[] | Blob, info: FileInfo, _type: "newnote" | "plain" = "plain") {
        const id = await this.path2id(path as FilePathWithPrefix);
        const saveData = data instanceof Blob ? data : createBlob(data);
        const datatype = determineTypeFromBlob(saveData);
        const putDoc = {
            _id: id,
            path: path as FilePathWithPrefix,
            data: saveData,
            ctime: info.ctime,
            mtime: info.mtime,
            size: info.size,
            type: datatype,
            eden: {},
            children: [] as string[],
            datatype: datatype,
        };
        Logger(`PUT: UPLOADING: ${path}`, LOG_LEVEL_VERBOSE);
        const ret = await this.liveSyncLocalDB.putDBEntry(putDoc);
        if (ret) {
            Logger(`PUT: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        } else {
            Logger(`PUT: FAILED: ${path}`, LOG_LEVEL_NOTICE);
            return false;
        }
    }

    async delete(path: string) {
        Logger(`DELETE: START: ${path}`, LOG_LEVEL_VERBOSE);
        const ret = await this.liveSyncLocalDB.deleteDBEntry(path as FilePathWithPrefix);
        if (ret) {
            Logger(`DELETE: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        } else {
            Logger(`DELETE: FAILED: ${path}`, LOG_LEVEL_INFO);
            return false;
        }
    }
    // Untested
    async *enumerate(_cond: EnumerateConditions) {
        //TODO
        // const param = {} as Record<string, string>;
        // if (cond.startKey) param.startkey = cond.startKey;
        // if (cond.endKey) param.endkey = cond.endKey;
        // if (cond.ids) param.keys = JSON.stringify(cond.ids);
        // let key = cond.startKey;
        // do {
        //     const result = await this._fetchJson(["_all_docs"], {}, "get", { ...param, include_docs: true, startkey: key, limit: 100 });
        //     if (!result.rows || result.rows.length == 0) {
        //         break;
        //     }
        //     //there are some result
        //     for (const v of result.rows) {
        //         const doc = v.doc;
        //         if (cond.metaOnly) {
        //             yield await doc;
        //         } else {
        //             yield await this.getByMeta(doc);
        //         }
        //         key = doc._id + "\u{10ffff}"
        //     }
        // } while (true);
        // return;
    }
    async *_enumerate(startKey: string, endKey: string, opt: { metaOnly: boolean }) {
        if (opt.metaOnly) return yield* this.liveSyncLocalDB.findEntries(startKey, endKey, {});
        for await (const f of this.liveSyncLocalDB.findEntries(startKey, endKey, {})) {
            yield await this.getByMeta(f);
        }
    }
    async *enumerateAllNormalDocs(opt: { metaOnly: boolean }) {
        // const opt = {};
        const targets = [
            this._enumerate("", "h:", opt),
            this._enumerate(`h:\u{10ffff}`, "i:", opt),
            this._enumerate(`i:\u{10ffff}`, "ix:", opt),
            this._enumerate(`ix:\u{10ffff}`, "ps:", opt),
            this._enumerate(`ps:\u{10ffff}`, "\u{10ffff}", opt),
        ];
        for (const target of targets) {
            for await (const f of target) {
                yield f;
            }
        }
    }

    watching = false;
    changes: PouchDB.Core.Changes<EntryDoc> | undefined;
    since = "";
    private stopWatching?: () => void;
    private resumeWatching?: () => void;
    private watchInFlight = 0;
    private watchDelivering = new Set<string>();
    private watchCheckpointPending?: Promise<void>;

    /**
     * Watch file changes, retrying incomplete reads and rejected consumer callbacks.
     * Resolving the file callback acknowledges processing. The optional checkpoint
     * callback must resolve after the host has persisted its safe resume position.
     */
    beginWatch(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean,
        onCheckpoint?: (seq: string | number) => Promise<void> | void
    ) {
        if (this.stopWatching || this.watching) return false;
        this.watching = true;
        this.watchInFlight ??= 0;
        this.watchDelivering ??= new Set<string>();
        type Position = { order: number; seq: string | number };
        type Pending = {
            id: string;
            doc: MetaEntry | undefined;
            seq: string | number;
            before: Position;
            running: boolean;
            failures: number;
            due: number;
        };
        const pending = new Map<string, Pending>();
        let latest: Position = { order: 0, seq: this.since };
        let durableOrder = 0;
        let connection = 0;
        let connected = false;
        let retryTimer: number | ReturnType<typeof setTimeout> | undefined;
        let reconnectTimer: number | ReturnType<typeof setTimeout> | undefined;
        let checkpointTask: Promise<void> | undefined;
        let checkpointFailures = 0;
        let checkpointDue = 0;
        const delivering = this.watchDelivering;
        const active = () => this.stopWatching === stop;
        const backoff = (failures: number) => Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
        // Map insertion order retains each document's first unresolved obligation.
        // Completed rows need only the latest position, even behind a long-lived gap.
        const safePosition = (): Position => pending.values().next().value?.before ?? latest;
        const current = (item: Pending, epoch: number) =>
            active() && connected && connection === epoch && pending.get(item.id) === item;
        const stop = () => {
            this.watching = false;
            connected = false;
            connection++;
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
            pending.clear();
            this.stopWatching = undefined;
            this.resumeWatching = undefined;
            const changes = this.changes;
            this.changes = undefined;
            changes?.cancel();
        };
        this.stopWatching = stop;

        const schedule = () => {
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            retryTimer = undefined;
            if (!active() || !connected) return;
            let next = Infinity;
            if (this.watchInFlight < 4) {
                for (const item of pending.values()) {
                    if (!item.running && !delivering.has(item.id)) next = Math.min(next, item.due);
                }
            }
            if (!checkpointTask && safePosition().order > durableOrder) next = Math.min(next, checkpointDue);
            if (next !== Infinity) {
                retryTimer = compatGlobal.setTimeout(
                    () => {
                        retryTimer = undefined;
                        void pump();
                    },
                    Math.max(0, next - Date.now())
                );
            }
        };
        const flushCheckpoint = (): Promise<void> => {
            if (checkpointTask) return checkpointTask;
            if (!active() || !connected || Date.now() < checkpointDue) return Promise.resolve();
            const position = safePosition();
            if (position.order <= durableOrder) return Promise.resolve();
            const epoch = connection;
            const previous = this.watchCheckpointPending;
            const task = (async () => {
                // A stopped watch may already have invoked host persistence. Complete
                // it before a new session can submit a later checkpoint.
                if (previous) await previous;
                if (!active() || connection !== epoch) return;
                try {
                    await onCheckpoint?.(position.seq);
                    if (!active()) return;
                    this.since = String(position.seq);
                    if (connection === epoch) durableOrder = position.order;
                    checkpointFailures = 0;
                    checkpointDue = 0;
                } catch (ex) {
                    Logger(`WATCH: CHECKPOINT FAILED`, LEVEL_INFO, "watch");
                    Logger(ex, LEVEL_VERBOSE, "watch");
                    if (active() && connection === epoch) {
                        checkpointDue = Date.now() + backoff(++checkpointFailures);
                    }
                }
            })().finally(() => {
                checkpointTask = undefined;
                if (this.watchCheckpointPending === task) this.watchCheckpointPending = undefined;
                if (active()) {
                    void flushCheckpoint();
                    schedule();
                }
            });
            checkpointTask = task;
            this.watchCheckpointPending = task;
            return task;
        };
        const process = async (item: Pending, epoch: number) => {
            let loading = true;
            try {
                const doc = item.doc;
                if (doc && isNoteEntry(doc) && (!checkIsInterested || checkIsInterested(doc))) {
                    Logger(`WATCH: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
                    const ready: ReadyEntry =
                        doc.deleted || doc._deleted ? { ...doc, data: [] } : await this.getByMeta(doc);
                    if (!current(item, epoch)) return;
                    loading = false;
                    delivering.add(item.id);
                    try {
                        await callback(ready, item.seq);
                    } finally {
                        delivering.delete(item.id);
                    }
                    if (!current(item, epoch)) return;
                    Logger(`WATCH: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
                }
                if (!current(item, epoch)) return;
                pending.delete(item.id);
                void flushCheckpoint();
            } catch (ex) {
                if (!current(item, epoch)) return;
                Logger(
                    loading ? `WATCH: DOCUMENT LOAD FAILED: ${item.doc?.path}` : `WATCH: PROCESS FAILED`,
                    LEVEL_INFO,
                    "watch"
                );
                Logger(ex, LEVEL_VERBOSE, "watch");
                item.due = Date.now() + backoff(++item.failures);
            }
        };
        const pump = (): Promise<void> => {
            if (!active() || !connected) return Promise.resolve();
            const tasks: Promise<void>[] = [];
            for (const item of pending.values()) {
                if (this.watchInFlight >= 4) break;
                if (item.running || item.due > Date.now() || delivering.has(item.id)) continue;
                item.running = true;
                this.watchInFlight++;
                const task = process(item, connection).finally(() => {
                    item.running = false;
                    this.watchInFlight--;
                    // Releasing an uncancellable read also wakes a replacement watch.
                    this.resumeWatching?.();
                });
                tasks.push(task);
            }
            void flushCheckpoint();
            schedule();
            return Promise.all(tasks).then((): void => {});
        };
        this.resumeWatching = () => {
            void pump();
        };
        const reconnect = (epoch: number) => {
            if (!active() || !connected || connection !== epoch) return;
            this.watching = false;
            connected = false;
            connection++;
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            retryTimer = undefined;
            pending.clear();
            const changes = this.changes;
            this.changes = undefined;
            changes?.cancel();
            Logger(`WATCH: CONNECTION HAS BEEN CLOSED, RECONNECTING...`, LEVEL_INFO, "watch");
            reconnectTimer = compatGlobal.setTimeout(() => {
                reconnectTimer = undefined;
                void (async () => {
                    if (checkpointTask) await checkpointTask;
                    if (active()) connect();
                })();
            }, 10_000);
        };
        const connect = () => {
            if (!active()) return;
            const epoch = ++connection;
            this.watching = true;
            connected = true;
            latest = { order: 0, seq: this.since };
            durableOrder = 0;
            checkpointFailures = 0;
            checkpointDue = 0;
            try {
                this.changes = this.liveSyncLocalDB.localDatabase
                    .changes({
                        include_docs: true,
                        since: this.since,
                        selector: { type: { $ne: "leaf" } },
                        live: true,
                    })
                    .on("change", async (change: any) => {
                        if (!active() || !connected || connection !== epoch) return;
                        const before = latest;
                        latest = { order: before.order + 1, seq: change.seq };
                        const id = change.id ?? change.doc?._id ?? change.doc?.path ?? `row:${latest.order}`;
                        const previous = pending.get(id);
                        // Bare tombstones can reuse only metadata already pending in
                        // this session; an unknown obfuscated path cannot be invented.
                        const doc =
                            change.doc?._deleted && previous?.doc ? { ...previous.doc, ...change.doc } : change.doc;
                        pending.set(id, {
                            id,
                            doc,
                            seq: change.seq,
                            before: previous?.before ?? before,
                            running: false,
                            failures: 0,
                            due: 0,
                        });
                        await pump();
                    })
                    .on("complete", () => reconnect(epoch))
                    .on("error", (err: Error) => {
                        if (!active() || connection !== epoch) return;
                        Logger(`WATCH: ERROR: `, LEVEL_INFO, "watch");
                        Logger(err, LEVEL_VERBOSE, "watch");
                        reconnect(epoch);
                    });
            } catch (ex) {
                Logger(`WATCH: ERROR: `, LEVEL_INFO, "watch");
                Logger(ex, LEVEL_VERBOSE, "watch");
                reconnect(epoch);
            }
        };
        connect();
    }
    endWatch() {
        this.stopWatching?.();
    }
    async followUpdates(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean
    ) {
        try {
            if (this.since == "") {
                this.since = "0";
            }
            Logger(`FOLLOW: START: (since:${this.since})`, LEVEL_INFO, "followUpdates");
            const last = await this.liveSyncLocalDB.localDatabase
                .changes({
                    include_docs: true,
                    since: this.since,
                    filter: "replicate/pull",
                    live: false,
                })
                .on("change", async (change) => {
                    const doc = change.doc;
                    if (!doc) {
                        return;
                    }
                    if (!isNoteEntry(doc)) {
                        return;
                    }
                    if (checkIsInterested) {
                        if (!checkIsInterested(doc)) {
                            Logger(`FOLLOW: SKIP ${doc._id}: OUT OF TARGET FOLDER`, LOG_LEVEL_VERBOSE, "watch");
                            return;
                        }
                    }
                    Logger(`FOLLOW: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
                    const docX = await this.getByMeta(doc);
                    try {
                        await callback(docX, change.seq);
                        Logger(`FOLLOW: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
                    } catch (ex) {
                        Logger(`FOLLOW: PROCESS FAILED`, LEVEL_INFO, "watch");
                        Logger(ex, LEVEL_VERBOSE, "watch");
                    }
                })
                .on("complete", () => {
                    Logger(`FOLLOW: FINISHED AT ${this.since}`, LEVEL_INFO, "watch");
                    this.watching = false;
                    this.changes = undefined;
                })
                .on("error", (err) => {
                    Logger(`FOLLOW: ERROR at ${this.since}: ${err}`, LEVEL_INFO, "watch");
                });
            return last.last_seq;
        } catch (e) {
            Logger(`FOLLOW: ERROR: ${e}`, LEVEL_INFO, "watch");
        }
        return this.since;
    }
}
