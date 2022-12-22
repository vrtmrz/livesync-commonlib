// Base class of LocalPouchDB
// Split from LiveSync for libraryisation.
//
import xxhash from "xxhash-wasm";
import {
    EntryDoc,
    EntryLeaf,
    EntryNodeInfo,
    LoadedEntry,
    Credential,
    EntryMilestoneInfo,
    LOG_LEVEL,
    LEAF_WAIT_TIMEOUT,
    NODEINFO_DOCID,
    VER,
    MILSTONE_DOCID,
    DatabaseConnectingStatus,
    ChunkVersionRange,
} from "./types.js";
import { RemoteDBSettings } from "./types";
import { resolveWithIgnoreKnownError, enableEncryption, runWithLock, delay } from "./utils";
import { Logger } from "./logger";
import { checkRemoteVersion, putDesignDocuments } from "./utils_couchdb";
import { LRUCache } from "./LRUCache";

import { putDBEntry, getDBEntry, getDBEntryMeta, deleteDBEntry, deleteDBEntryPrefix, ensureDatabaseIsCompatible, DBFunctionEnvironment } from "./LiveSyncDBFunctions.js";
// when replicated, LiveSync checks chunk versions that every node used.
// If all minimum version of every devices were up, that means we can convert database automatically.

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
}

type ReplicationCallback = (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>;
export abstract class LocalPouchDBBase implements DBFunctionEnvironment {
    auth: Credential;
    dbname: string;
    settings: RemoteDBSettings;
    localDatabase!: PouchDB.Database<EntryDoc>;
    nodeid = "";
    isReady = false;

    h32!: (input: string, seed?: number) => string;
    h32Raw!: (input: Uint8Array, seed?: number) => number;
    hashCaches = new LRUCache();

    corruptedEntries: { [key: string]: EntryDoc } = {};
    remoteLocked = false;
    remoteLockedAndDeviceNotAccepted = false;

    changeHandler: PouchDB.Core.Changes<EntryDoc> | null = null;
    syncHandler: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc> | null = null;

    leafArrivedCallbacks: { [key: string]: (() => void)[] } = {};

    syncStatus: DatabaseConnectingStatus = "NOT_CONNECTED";
    docArrived = 0;
    docSent = 0;
    docSeq = "";

    isMobile = false;

    chunkVersion = -1;
    maxChunkVersion = -1;
    minChunkVersion = -1;
    needScanning = false;

    abstract id2path(filename: string): string;
    abstract path2id(filename: string): string;

    abstract CreatePouchDBInstance<T>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>


    cancelHandler<T extends PouchDB.Core.Changes<EntryDoc> | PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>>(handler: T): T {
        if (handler != null) {
            handler.removeAllListeners();
            handler.cancel();
            handler = null;
        }
        return null;
    }
    abstract beforeOnUnload(): void;
    onunload() {
        //this.kvDB.close();
        this.beforeOnUnload();
        this.leafArrivedCallbacks;
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.syncHandler = this.cancelHandler(this.syncHandler);
        this.localDatabase.removeAllListeners();
    }

    constructor(settings: RemoteDBSettings, dbname: string, isMobile: boolean) {
        this.auth = {
            username: "",
            password: "",
        };
        this.dbname = dbname;
        this.settings = settings;
        this.cancelHandler = this.cancelHandler.bind(this);
        this.isMobile = isMobile;
    }
    abstract onClose(): void;
    close() {
        Logger("Database closed (by close)");
        this.isReady = false;
        this.changeHandler = this.cancelHandler(this.changeHandler);
        if (this.localDatabase != null) {
            this.localDatabase.close();
        }
        this.onClose();
        // this.kvDB.close();
    }

    async isOldDatabaseExists() {
        const db = this.CreatePouchDBInstance<EntryDoc>(this.dbname + "-livesync", {
            auto_compaction: this.settings.useHistory ? false : true,
            revs_limit: 20,
            deterministic_revs: true,
            skip_setup: true,
        });
        try {
            const info = await db.info();
            Logger(info, LOG_LEVEL.VERBOSE);
            return db;
        } catch (ex) {
            return false;
        }
    }
    abstract onInitializeDatabase(): Promise<void>;
    async initializeDatabase(): Promise<boolean> {
        await this.prepareHashFunctions();
        if (this.localDatabase != null) this.localDatabase.close();
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.localDatabase = null;

        this.localDatabase = this.CreatePouchDBInstance<EntryDoc>(this.dbname + "-livesync-v2", {
            auto_compaction: this.settings.useHistory ? false : true,
            revs_limit: 100,
            deterministic_revs: true,
        });
        await this.onInitializeDatabase();
        //this.kvDB = await OpenKeyValueDatabase(this.dbname + "-livesync-kv");
        Logger("Database info", LOG_LEVEL.VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL.VERBOSE);
        Logger("Open Database...");
        // The sequence after migration.
        const nextSeq = async (): Promise<boolean> => {
            Logger("Database Info");
            Logger(await this.localDatabase.info(), LOG_LEVEL.VERBOSE);
            // initialize local node information.
            const nodeinfo: EntryNodeInfo = await resolveWithIgnoreKnownError<EntryNodeInfo>(this.localDatabase.get(NODEINFO_DOCID), {
                _id: NODEINFO_DOCID,
                type: "nodeinfo",
                nodeid: "",
                v20220607: true,
            });
            if (nodeinfo.nodeid == "") {
                nodeinfo.nodeid = Math.random().toString(36).slice(-10);
                await this.localDatabase.put(nodeinfo);
            }
            this.localDatabase.on("close", () => {
                Logger("Database closed.");
                this.isReady = false;
                this.localDatabase.removeAllListeners();
            });
            this.nodeid = nodeinfo.nodeid;
            await putDesignDocuments(this.localDatabase);

            // Tracings the leaf id
            const changes = this.localDatabase
                .changes({
                    since: "now",
                    live: true,
                    filter: (doc) => doc.type == "leaf",
                })
                .on("change", (e) => {
                    if (e.deleted) return;
                    this.leafArrived(e.id);
                    this.docSeq = `${e.seq}`;
                });
            this.changeHandler = changes;
            this.isReady = true;
            Logger("Database is now ready.");
            return true;
        };
        Logger("Checking old database", LOG_LEVEL.VERBOSE);
        const old = await this.isOldDatabaseExists();

        //Migrate.
        if (old) {
            const oi = await old.info();
            if (oi.doc_count == 0) {
                Logger("Old database is empty, proceed to next step", LOG_LEVEL.VERBOSE);
                // already converted.
                return nextSeq();
            }
            //
            Logger("We have to upgrade database..", LOG_LEVEL.NOTICE, "conv");
            try {

                // To debug , uncomment below.

                // this.localDatabase.destroy();
                // await delay(100);
                // this.localDatabase = new PouchDB<EntryDoc>(this.dbname + "-livesync-v2", {
                //     auto_compaction: this.settings.useHistory ? false : true,
                //     revs_limit: 100,
                //     deterministic_revs: true,
                // });
                const newDbStatus = await this.localDatabase.info();
                Logger("New database is initialized");
                Logger(newDbStatus);

                if (this.settings.encrypt) {
                    enableEncryption(old, this.settings.passphrase, this.settings.useDynamicIterationCount);
                }
                const rep = old.replicate.to(this.localDatabase, { batch_size: 25, batches_limit: 10 });
                rep.on("change", (e) => {
                    Logger(`Converting ${e.docs_written} docs...`, LOG_LEVEL.NOTICE, "conv");
                });
                const w = await rep;

                if (w.ok) {
                    Logger("Conversion completed!", LOG_LEVEL.NOTICE, "conv");
                    old.destroy(); // delete the old database.
                    this.isReady = true;
                    return await nextSeq();
                } else {
                    throw new Error("Conversion failed!");
                }
            } catch (ex) {
                Logger("Conversion failed!, If you are fully synchronized, please drop the old database in the Hatch pane in setting dialog. or please make an issue on Github.", LOG_LEVEL.NOTICE, "conv");
                Logger(ex);
                this.isReady = false;
                return false;
            }
        } else {
            return await nextSeq();
        }
    }

    async prepareHashFunctions() {
        if (this.h32 != null) return;
        const { h32, h32Raw } = await xxhash();
        this.h32 = h32;
        this.h32Raw = h32Raw;
    }

    // leaf waiting

    leafArrived(id: string) {
        if (typeof this.leafArrivedCallbacks[id] !== "undefined") {
            for (const func of this.leafArrivedCallbacks[id]) {
                func();
            }
            delete this.leafArrivedCallbacks[id];
        }
    }
    // wait
    waitForLeafReady(id: string): Promise<boolean> {
        return new Promise((res, rej) => {
            // Set timeout.
            const timer = setTimeout(() => rej(new Error(`Chunk reading timed out:${id}`)), LEAF_WAIT_TIMEOUT);
            if (typeof this.leafArrivedCallbacks[id] == "undefined") {
                this.leafArrivedCallbacks[id] = [];
            }
            this.leafArrivedCallbacks[id].push(() => {
                clearTimeout(timer);
                res(true);
            });
        });
    }

    async getDBLeaf(id: string, waitForReady: boolean): Promise<string> {
        // when in cache, use that.
        const leaf = this.hashCaches.revGet(id);
        if (leaf) {
            return leaf;
        }
        try {
            const w = await this.localDatabase.get(id);
            if (w.type == "leaf") {
                this.hashCaches.set(id, w.data);
                return w.data;
            }
            throw new Error(`Corrupted chunk detected: ${id}`);
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                if (waitForReady) {
                    // just leaf is not ready.
                    // wait for on
                    if ((await this.waitForLeafReady(id)) === false) {
                        throw new Error(`time out (waiting chunk)`);
                    }
                    return this.getDBLeaf(id, false);
                } else {
                    throw new Error(`Chunk was not found: ${id}`);
                }
            } else {
                Logger(`Something went wrong while retrieving chunks`);
                throw ex;
            }
        }
    }

    // eslint-disable-next-line require-await
    async getDBEntryMeta(path: string, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntryMeta(this, path, opt, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async getDBEntry(path: string, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntry(this, path, opt, dump, waitForReady, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntry(path: string, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        return deleteDBEntry(this, path, opt);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntryPrefix(prefixSrc: string): Promise<boolean> {
        return deleteDBEntryPrefix(this, prefixSrc);
    }
    // eslint-disable-next-line require-await
    async putDBEntry(note: LoadedEntry, saveAsBigChunk?: boolean) {
        return putDBEntry(this, note, saveAsBigChunk);
    }

    updateInfo: () => void = () => {
        console.log("Update Info default implement");
    };
    // eslint-disable-next-line require-await
    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL.NOTICE);
        // no op now,
        return true;
    }
    replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return new Promise((res, rej) => {
            this.openOneshotReplication(
                setting,
                showingNotice ?? false,
                async (e) => { },
                false,
                (e) => {
                    if (e === true) res(e);
                    rej(e);
                },
                "pushOnly"
            );
        });
    }

    async checkReplicationConnectivity(setting: RemoteDBSettings, keepAlive: boolean, skipCheck: boolean, showResult: boolean) {
        if (!this.isReady) {
            Logger("Database is not ready.");
            return false;
        }

        if (setting.versionUpFlash != "") {
            Logger("Open settings and check message, please.", LOG_LEVEL.NOTICE);
            return false;
        }
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        if (this.syncHandler != null) {
            Logger("Another replication running.");
            return false;
        }

        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}: ${dbRet}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
            return false;
        }

        if (!skipCheck) {
            await putDesignDocuments(dbRet.db);
            if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
                Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
                return false;
            }

            const ensure = await ensureDatabaseIsCompatible(dbRet.db, setting, this.nodeid, currentVersionRange);
            if (ensure == "INCOMPATIBLE") {
                Logger("The remote database has no compatibility with the running version. Please upgrade the plugin.", LOG_LEVEL.NOTICE);
                return false;
            } else if (ensure == "NODE_LOCKED") {
                Logger("The remote database has been rebuilt or corrupted since we have synchronized last time. Fetch rebuilt DB or explicit unlocking is required. See the settings dialog.", LOG_LEVEL.NOTICE);
                this.remoteLockedAndDeviceNotAccepted = true;
                this.remoteLocked = true;
                return false;
            } else if (ensure == "LOCKED") {
                this.remoteLocked = true;
            }
        }
        const syncOptionBase: PouchDB.Replication.SyncOptions = {
            batches_limit: setting.batches_limit,
            batch_size: setting.batch_size,
        };
        if (setting.readChunksOnline) {
            syncOptionBase.push = { filter: 'replicate/push' };
            syncOptionBase.pull = { filter: 'replicate/pull' };
        }
        const syncOption: PouchDB.Replication.SyncOptions = keepAlive ? { live: true, retry: true, heartbeat: 30000, ...syncOptionBase } : { ...syncOptionBase };

        return { db: dbRet.db, info: dbRet.info, syncOptionBase, syncOption };
    }

    openReplication(setting: RemoteDBSettings, keepAlive: boolean, showResult: boolean, callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>) {
        if (keepAlive) {
            this.openContinuousReplication(setting, showResult, callback, false);
        } else {
            this.openOneshotReplication(setting, showResult, callback, false, null, "sync");
        }
    }
    replicationActivated(showResult: boolean) {
        this.syncStatus = "CONNECTED";
        this.updateInfo();
        Logger("Replication activated", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
    }
    async replicationChangeDetected(e: PouchDB.Replication.SyncResult<EntryDoc>, showResult: boolean, docSentOnStart: number, docArrivedOnStart: number, callback: ReplicationCallback) {
        try {
            if (e.direction == "pull") {
                await callback(e.change.docs);
                this.docArrived += e.change.docs.length;
            } else {
                this.docSent += e.change.docs.length;
            }
            if (showResult) {
                Logger(`↑${this.docSent - docSentOnStart} ↓${this.docArrived - docArrivedOnStart}`, LOG_LEVEL.NOTICE, "sync");
            }
            this.updateInfo();
        } catch (ex) {
            Logger("Replication callback error", LOG_LEVEL.NOTICE, "sync");
            Logger(ex, LOG_LEVEL.NOTICE);
            //
        }
    }
    replicationCompleted(showResult: boolean) {
        this.syncStatus = "COMPLETED";
        this.updateInfo();
        Logger("Replication completed", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, showResult ? "sync" : "");
        this.syncHandler = this.cancelHandler(this.syncHandler);
    }
    replicationDenied(e: any) {
        this.syncStatus = "ERRORED";
        this.updateInfo();
        this.syncHandler = this.cancelHandler(this.syncHandler);
        Logger("Replication denied", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationErrored(e: any) {
        this.syncStatus = "ERRORED";
        this.syncHandler = this.cancelHandler(this.syncHandler);
        this.updateInfo();
        Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationPaused() {
        this.syncStatus = "PAUSED";
        this.updateInfo();
        Logger("replication paused", LOG_LEVEL.VERBOSE, "sync");
    }

    async openOneshotReplication(
        setting: RemoteDBSettings,
        showResult: boolean,
        callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>,
        retrying: boolean,
        callbackDone: ((e: boolean | any) => void) | null,
        syncMode: "sync" | "pullOnly" | "pushOnly"
    ): Promise<boolean> {
        if (this.syncHandler != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        Logger(`Oneshot Sync begin... (${syncMode})`);
        let thisCallback = callbackDone;
        const ret = await this.checkReplicationConnectivity(setting, true, retrying, showResult);
        if (ret === false) {
            Logger("Could not connect to server.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        if (showResult) {
            Logger("Looking for the point last synchronized point.", LOG_LEVEL.NOTICE, "sync");
        }
        const { db, syncOptionBase } = ret;
        this.syncStatus = "STARTED";
        this.updateInfo();
        const docArrivedOnStart = this.docArrived;
        const docSentOnStart = this.docSent;
        if (!retrying) {
            // If initial replication, save setting to rollback
            this.originalSetting = setting;
        }
        this.syncHandler = this.cancelHandler(this.syncHandler);
        if (syncMode == "sync") {
            this.syncHandler = this.localDatabase.sync(db, { checkpoint: "target", ...syncOptionBase });
            this.syncHandler
                .on("change", async (e) => {
                    await this.replicationChangeDetected(e, showResult, docSentOnStart, docArrivedOnStart, callback);
                    if (retrying) {
                        if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                            // restore configuration.
                            Logger("Back into original settings once.");
                            this.syncHandler = this.cancelHandler(this.syncHandler);
                            this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                        }
                    }
                })
                .on("complete", (e) => {
                    this.replicationCompleted(showResult);
                    if (thisCallback != null) {
                        thisCallback(true);
                    }
                });
        } else if (syncMode == "pullOnly") {
            this.syncHandler = this.localDatabase.replicate.from(db, { checkpoint: "target", ...syncOptionBase, ...(this.settings.readChunksOnline ? { filter: "replicate/pull" } : {}) });
            this.syncHandler
                .on("change", async (e) => {
                    await this.replicationChangeDetected({ direction: "pull", change: e }, showResult, docSentOnStart, docArrivedOnStart, callback);
                    if (retrying) {
                        if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                            // restore configuration.
                            Logger("Back into original settings once.");
                            this.syncHandler = this.cancelHandler(this.syncHandler);
                            this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                        }
                    }
                })
                .on("complete", (e) => {
                    this.replicationCompleted(showResult);
                    if (thisCallback != null) {
                        thisCallback(true);
                    }
                });
        } else if (syncMode == "pushOnly") {
            this.syncHandler = this.localDatabase.replicate.to(db, { checkpoint: "target", ...syncOptionBase, ...(this.settings.readChunksOnline ? { filter: "replicate/push" } : {}) });
            this.syncHandler.on("change", async (e) => {
                await this.replicationChangeDetected({ direction: "push", change: e }, showResult, docSentOnStart, docArrivedOnStart, callback);
                if (retrying) {
                    if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                        // restore configuration.
                        Logger("Back into original settings once.");
                        this.syncHandler = this.cancelHandler(this.syncHandler);
                        this.openOneshotReplication(this.originalSetting, showResult, callback, false, callbackDone, syncMode);
                    }
                }
            })
            this.syncHandler.on("complete", (e) => {
                this.replicationCompleted(showResult);
                if (thisCallback != null) {
                    thisCallback(true);
                }
            });
        }

        this.syncHandler
            .on("active", () => this.replicationActivated(showResult))
            .on("denied", (e) => {
                this.replicationDenied(e);
                if (thisCallback != null) {
                    thisCallback(e);
                }
            })
            .on("error", (e: any) => {
                this.replicationErrored(e);
                Logger("Replication stopped.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
                if (this.getLastPostFailedBySize()) {
                    if ("status" in e && e.status == 413) {
                        Logger(`Self-hosted LiveSync has detected some remote-database-incompatible chunks that exist in the local database. It means synchronization with the server had been no longer possible.\n\nThe problem may be caused by chunks that were created with the faulty version or by switching platforms of the database.\nTo solve the circumstance, configure the remote database correctly or we have to rebuild both local and remote databases.`, LOG_LEVEL.NOTICE);
                        return;
                    }
                    // Duplicate settings for smaller batch.
                    const tempSetting: RemoteDBSettings = JSON.parse(JSON.stringify(setting));
                    tempSetting.batch_size = Math.ceil(tempSetting.batch_size / 2) + 2;
                    tempSetting.batches_limit = Math.ceil(tempSetting.batches_limit / 2) + 2;
                    if (tempSetting.batch_size <= 5 && tempSetting.batches_limit <= 5) {
                        Logger("We can't replicate more lower value.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    } else {
                        Logger(`Retry with lower batch size:${tempSetting.batch_size}/${tempSetting.batches_limit}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                        thisCallback = null;
                        this.openOneshotReplication(tempSetting, showResult, callback, true, callbackDone, syncMode);
                    }
                } else {
                    Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
                    Logger(e);
                }
                if (thisCallback != null) {
                    thisCallback(e);
                }
            })
            .on("paused", (e) => this.replicationPaused());

        await this.syncHandler;
    }

    abstract getLastPostFailedBySize(): boolean;
    openContinuousReplication(setting: RemoteDBSettings, showResult: boolean, callback: (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>, retrying: boolean) {
        if (this.syncHandler != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
            return;
        }
        Logger("Before LiveSync, start OneShot once...");
        this.openOneshotReplication(
            setting,
            showResult,
            callback,
            false,
            async () => {
                Logger("LiveSync begin...");
                const ret = await this.checkReplicationConnectivity(setting, true, true, showResult);
                if (ret === false) {
                    Logger("Could not connect to server.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    return;
                }
                if (showResult) {
                    Logger("Looking for the point last synchronized point.", LOG_LEVEL.NOTICE, "sync");
                }
                const { db, syncOption } = ret;
                this.syncStatus = "STARTED";
                this.updateInfo();
                const docArrivedOnStart = this.docArrived;
                const docSentOnStart = this.docSent;
                if (!retrying) {
                    //TODO if successfully saved, roll back org setting.
                    this.originalSetting = setting;
                }
                this.syncHandler = this.cancelHandler(this.syncHandler);
                this.syncHandler = this.localDatabase.sync<EntryDoc>(db, {
                    ...syncOption,
                    pull: {
                        checkpoint: "target",
                    },
                    push: {
                        checkpoint: "source",
                    },
                });
                this.syncHandler
                    .on("active", () => this.replicationActivated(showResult))
                    .on("change", async (e) => {
                        await this.replicationChangeDetected(e, showResult, docSentOnStart, docArrivedOnStart, callback);
                        if (retrying) {
                            if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                                // restore sync values
                                Logger("Back into original settings once.");
                                this.syncHandler = this.cancelHandler(this.syncHandler);
                                this.openContinuousReplication(this.originalSetting, showResult, callback, false);
                            }
                        }
                    })
                    .on("complete", (e) => this.replicationCompleted(showResult))
                    .on("denied", (e) => this.replicationDenied(e))
                    .on("error", (e) => {
                        this.replicationErrored(e);
                        Logger("Replication stopped.", LOG_LEVEL.NOTICE, "sync");
                    })
                    .on("paused", (e) => this.replicationPaused());
            },
            "pullOnly"
        );
    }

    originalSetting: RemoteDBSettings = null;

    closeReplication() {
        this.syncStatus = "CLOSED";
        this.updateInfo();
        this.syncHandler = this.cancelHandler(this.syncHandler);
        Logger("Replication closed");
    }

    async resetLocalOldDatabase() {
        const oldDB = await this.isOldDatabaseExists();
        if (oldDB) {
            oldDB.destroy();
            Logger("Deleted!", LOG_LEVEL.NOTICE);
        } else {
            Logger("Old database is not exist.", LOG_LEVEL.NOTICE);
        }
    }
    abstract onResetDatabase(): Promise<void>;
    async resetDatabase() {
        this.changeHandler = this.cancelHandler(this.changeHandler);
        this.closeReplication();
        Logger("Database closed for reset Database.");
        this.isReady = false;
        await this.localDatabase.destroy();
        //await this.kvDB.destroy();
        this.onResetDatabase();
        this.localDatabase = null;
        await this.initializeDatabase();
        Logger("Local Database Reset", LOG_LEVEL.NOTICE);
    }
    async tryResetRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        const con = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof con == "string") return;
        try {
            await con.db.destroy();
            Logger("Remote Database Destroyed", LOG_LEVEL.NOTICE);
            await this.tryCreateRemoteDatabase(setting);
        } catch (ex) {
            Logger("Something happened on Remote Database Destroy:", LOG_LEVEL.NOTICE);
            Logger(ex, LOG_LEVEL.NOTICE);
        }
    }
    async tryCreateRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        const con2 = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);

        if (typeof con2 === "string") return;
        Logger("Remote Database Created or Connected", LOG_LEVEL.NOTICE);
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean) {
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}:${dbRet}`, LOG_LEVEL.NOTICE);
            return;
        }

        if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
            Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
            return;
        }
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: locked,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };

        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...await resolveWithIgnoreKnownError(dbRet.db.get(MILSTONE_DOCID), defInitPoint) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = [this.nodeid];
        remoteMilestone.locked = locked;
        if (locked) {
            Logger("Lock remote database to prevent data corruption", LOG_LEVEL.NOTICE);
        } else {
            Logger("Unlock remote database to prevent data corruption", LOG_LEVEL.NOTICE);
        }
        await dbRet.db.put(remoteMilestone);
    }
    async markRemoteResolved(setting: RemoteDBSettings) {
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.isMobile);
        if (typeof dbRet === "string") {
            Logger(`could not connect to ${uri}:${dbRet}`, LOG_LEVEL.NOTICE);
            return;
        }

        if (!(await checkRemoteVersion(dbRet.db, this.migrate.bind(this), VER))) {
            Logger("Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed", LOG_LEVEL.NOTICE);
            return;
        }
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: false,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };
        // check local database hash status and remote replicate hash status
        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...await resolveWithIgnoreKnownError(dbRet.db.get(MILSTONE_DOCID), defInitPoint) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = Array.from(new Set([...remoteMilestone.accepted_nodes, this.nodeid]));
        Logger("Mark this device as 'resolved'.", LOG_LEVEL.NOTICE);
        await dbRet.db.put(remoteMilestone);
    }
    async sanCheck(entry: EntryDoc): Promise<boolean> {
        if (entry.type == "plain" || entry.type == "newnote") {
            const children = entry.children;
            Logger(`sancheck:checking:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
            try {
                const dc = await this.localDatabase.allDocs({ keys: [...children] });
                if (dc.rows.some((e) => "error" in e)) {
                    this.corruptedEntries[entry._id] = entry;
                    Logger(`sancheck:corrupted:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
                    return false;
                }
                return true;
            } catch (ex) {
                Logger(ex);
            }
        }
        return false;
    }

    isVersionUpgradable(ver: number) {
        if (this.maxChunkVersion < 0) return false;
        if (this.minChunkVersion < 0) return false;
        if (this.maxChunkVersion > 0 && this.maxChunkVersion < ver) return false;
        if (this.minChunkVersion > 0 && this.minChunkVersion > ver) return false;
        return true;
    }

    isTargetFile(file: string) {
        if (file.includes(":")) return true;
        if (this.settings.syncOnlyRegEx) {
            const syncOnly = new RegExp(this.settings.syncOnlyRegEx);
            if (!file.match(syncOnly)) return false;
        }
        if (this.settings.syncIgnoreRegEx) {
            const syncIgnore = new RegExp(this.settings.syncIgnoreRegEx);
            if (file.match(syncIgnore)) return false;
        }
        return true;
    }

    collectThrottleTimeout: ReturnType<typeof setTimeout> = null;
    collectThrottleQueuedIds = [] as string[];

    // It is no de-javu.
    chunkCollectedCallbacks: { [key: string]: { ok: ((chunk: EntryLeaf) => void)[], failed: (() => void) } } = {};
    chunkCollected(chunk: EntryLeaf) {
        const id = chunk._id;
        // Pull the hooks.
        // (One id will pull some hooks)
        if (typeof this.chunkCollectedCallbacks[id] !== "undefined") {
            for (const func of this.chunkCollectedCallbacks[id].ok) {
                func(chunk);
            }
            delete this.chunkCollectedCallbacks[id];
        } else {
            Logger(`Collected handler of ${id} is missing, it might be error but perhaps it already timed out.`, LOG_LEVEL.VERBOSE);
        }
    }
    async CollectChunks(ids: string[], showResult = false, waitForReady?: boolean) {

        // Register callbacks.
        const promises = ids.map(id => new Promise<EntryLeaf>((res, rej) => {
            // Lay the hook that be pulled when chunks are incoming.
            if (typeof this.chunkCollectedCallbacks[id] == "undefined") {
                this.chunkCollectedCallbacks[id] = { ok: [], failed: () => { delete this.chunkCollectedCallbacks[id]; rej() } };
            }
            this.chunkCollectedCallbacks[id].ok.push((chunk) => {
                res(chunk);
            });
        }));

        // Queue chunks for batch request.
        this.collectThrottleQueuedIds = [...new Set([...this.collectThrottleQueuedIds, ...ids])];
        this.execCollect();

        const res = await Promise.all(promises);
        return res;
    }
    execCollect() {
        // do not await.
        runWithLock("execCollect", false, async () => {
            const timeoutLimit = 333; // three requests per second as maximum

            const requesting = [...this.collectThrottleQueuedIds];
            if (requesting.length == 0) return;
            this.collectThrottleQueuedIds = [];
            const chunks = await this.CollectChunksInternal(requesting, false);
            if (chunks) {
                for (const chunk of chunks) {
                    this.chunkCollected(chunk);
                }
            } else {
                // TODO: need more explicit message. 
                Logger(`Could not retrieve chunks`, LOG_LEVEL.NOTICE);
            }
            for (const id of requesting) {
                if (id in this.chunkCollectedCallbacks) {
                    this.chunkCollectedCallbacks[id].failed();
                }
            }

            await delay(timeoutLimit);
        }).then(() => { /* fire and forget */ });
    }

    // Collect chunks from both local and remote.
    async CollectChunksInternal(ids: string[], showResult = false): Promise<false | EntryLeaf[]> {
        // Fetch local chunks.
        const localChunks = await this.localDatabase.allDocs({ keys: ids, include_docs: true });
        const missingChunks = localChunks.rows.filter(e => "error" in e).map(e => e.key);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.rows.map(e => e.doc) as EntryLeaf[];
        }

        // Fetching remote chunks.
        const ret = await this.connectRemoteCouchDBWithSetting(this.settings, this.isMobile);
        if (typeof (ret) === "string") {

            Logger(`Could not connect to server.${ret} `, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }

        const remoteChunks = await ret.db.allDocs({ keys: missingChunks, include_docs: true });
        if (remoteChunks.rows.some((e: any) => "error" in e)) {
            Logger(`Some chunks are not exists both on remote and local database.`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }

        const remoteChunkItems = remoteChunks.rows.map((e: any) => e.doc);
        const max = remoteChunkItems.length;
        remoteChunks.rows.forEach(e => this.hashCaches.set(e.id, (e.doc as EntryLeaf).data));
        // Cache remote chunks to the local database.
        const remoteDocs = remoteChunks.rows.map(e => ({ ...e.doc }));
        await this.localDatabase.bulkDocs(remoteDocs, { new_edits: false });
        let last = 0;
        // Chunks should be ordered by as we requested.
        function findChunk(key: string) {
            const offset = last;
            for (let i = 0; i < max; i++) {
                const idx = (offset + i) % max;
                last = i;
                if (remoteChunkItems[idx]._id == key) return remoteChunkItems[idx];
            }
            throw Error("Chunk collecting error");
        }
        // Merge them
        return localChunks.rows.map(e => ("error" in e) ? (findChunk(e.key)) : e.doc);
    }


    connectRemoteCouchDBWithSetting(settings: RemoteDBSettings, isMobile: boolean) {
        return this.connectRemoteCouchDB(
            settings.couchDB_URI + (settings.couchDB_DBNAME == "" ? "" : "/" + settings.couchDB_DBNAME),
            {
                username: settings.couchDB_USER,
                password: settings.couchDB_PASSWORD,
            },
            settings.disableRequestURI || isMobile,
            settings.encrypt ? settings.passphrase : settings.encrypt,
            settings.useDynamicIterationCount
        );
    }

    abstract connectRemoteCouchDB(uri: string, auth: { username: string; password: string }, disableRequestURI: boolean, passphrase: string | boolean, useDynamicIterationCount: boolean): Promise<string | { db: PouchDB.Database<EntryDoc>; info: PouchDB.Core.DatabaseInfo }>;

}
