import {
    EntryDoc, EntryNodeInfo, EntryMilestoneInfo,
    LOG_LEVEL, NODEINFO_DOCID,
    VER,
    MILSTONE_DOCID,
    DatabaseConnectingStatus,
    ChunkVersionRange, RemoteDBSettings, EntryLeaf
} from "./types";
import { resolveWithIgnoreKnownError, delay } from "./utils";
import { Logger } from "./logger";
import { checkRemoteVersion, putDesignDocuments } from "./utils_couchdb";

import { ensureDatabaseIsCompatible } from "./LiveSyncDBFunctions.js";
import { ObservableStore } from "./store.js";


const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
}
type ReplicationCallback = (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void>;

type EventParamArray<T> =
    ["change", PouchDB.Replication.SyncResult<T>] |
    ["change", PouchDB.Replication.ReplicationResult<T>] |
    ["active"] |
    ["complete", PouchDB.Replication.SyncResultComplete<T>] |
    ["complete", PouchDB.Replication.ReplicationResultComplete<T>] |
    ["error", any] |
    ["denied", any] |
    ["paused", any] |
    ["finally"]
    ;

export interface LiveSyncReplicatorEnv {
    getDatabase(): PouchDB.Database<EntryDoc>;
    getSettings(): RemoteDBSettings;
    getIsMobile(): boolean;
    getLastPostFailedBySize(): boolean;
    processReplication: ReplicationCallback;
    connectRemoteCouchDB(uri: string, auth: { username: string; password: string }, disableRequestURI: boolean, passphrase: string | boolean, useDynamicIterationCount: boolean): Promise<string | { db: PouchDB.Database<EntryDoc>; info: PouchDB.Core.DatabaseInfo }>;
    replicationStat: ObservableStore<{
        sent: number;
        arrived: number;
        maxPullSeq: number;
        maxPushSeq: number;
        lastSyncPullSeq: number;
        lastSyncPushSeq: number;
        syncStatus: DatabaseConnectingStatus;
    }>
}
async function* genReplication(s: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>, signal: AbortSignal) {

    const p = [] as EventParamArray<EntryDoc>[];
    let locker: () => Promise<void> = () => Promise.resolve();
    let unlock = () => {
        locker = () => new Promise<void>((res) => unlock = res);
    };
    unlock();
    const push = function (e: EventParamArray<EntryDoc>) {
        p.push(e);
        unlock();
    }

    //@ts-ignore
    s.on("complete", (result) => push(["complete", result]));
    //@ts-ignore
    s.on("change", result => push(["change", result]));
    s.on("active", () => push(["active"]));
    s.on("denied", err => push(["denied", err]));
    s.on("error", err => push(["error", err]));
    s.on("paused", err => push(["paused", err]));
    s.then(() => push(["finally"])).catch(() => push(["finally"]));

    try {
        L1:
        do {
            const r = p.shift();
            if (r) {
                yield r;
                if (r[0] == "finally") break;
                continue;
            } else {
                const dx = async () => { await locker(); return true };
                do {
                    const timeout = async () => { await delay(100); return false };
                    const raced = await Promise.race([dx(), timeout()]);
                    if (raced) continue L1;
                    if (signal.aborted) break L1;
                    // eslint-disable-next-line no-constant-condition
                } while (true);
            }
        } while (true);
    } finally {
        s.cancel();
    }
}

export class LiveSyncDBReplicator {

    syncStatus: DatabaseConnectingStatus = "NOT_CONNECTED";
    docArrived = 0;
    docSent = 0;

    lastSyncPullSeq = 0;
    maxPullSeq = 0;
    lastSyncPushSeq = 0;
    maxPushSeq = 0;
    controller: AbortController;
    // localDatabase: PouchDB.Database<EntryDoc>;
    originalSetting: RemoteDBSettings = null;
    nodeid = "";
    remoteLocked = false;
    remoteLockedAndDeviceNotAccepted = false;

    env: LiveSyncReplicatorEnv;

    async initializeDatabaseForReplication(): Promise<boolean> {
        const db = this.env.getDatabase();
        try {
            const nodeinfo: EntryNodeInfo = await resolveWithIgnoreKnownError<EntryNodeInfo>(db.get(NODEINFO_DOCID), {
                _id: NODEINFO_DOCID,
                type: "nodeinfo",
                nodeid: "",
                v20220607: true,
            });
            if (nodeinfo.nodeid == "") {
                nodeinfo.nodeid = Math.random().toString(36).slice(-10);
                await db.put(nodeinfo);
            }

            this.nodeid = nodeinfo.nodeid;
            await putDesignDocuments(db);
        } catch (ex) {
            Logger(ex);
            return false;
        }
    }

    constructor(env: LiveSyncReplicatorEnv) {
        this.env = env;
        // initialize local node information.
        this.initializeDatabaseForReplication();
        this.env.getDatabase().on("close", () => {
            this.closeReplication();
        })
    }

    // eslint-disable-next-line require-await
    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL.NOTICE);
        // no op now,
        return true;
    }

    terminateSync() {
        if (!this.controller) {
            return;
        }
        this.controller.abort();
        this.controller = null;
    }

    async openReplication(setting: RemoteDBSettings, keepAlive: boolean, showResult: boolean) {
        await this.initializeDatabaseForReplication();
        if (keepAlive) {
            this.openContinuousReplication(setting, showResult, false);
        } else {
            return this.openOneShotReplication(setting, showResult, false, "sync");
        }
    }
    replicationActivated(showResult: boolean) {
        this.syncStatus = "CONNECTED";
        this.updateInfo();
        Logger("Replication activated", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
    }
    async replicationChangeDetected(e: PouchDB.Replication.SyncResult<EntryDoc>, showResult: boolean, docSentOnStart: number, docArrivedOnStart: number) {
        try {
            if (e.direction == "pull") {
                await this.env.processReplication(e.change.docs);
                this.docArrived += e.change.docs.length;
            } else {
                this.docSent += e.change.docs.length;
            }
            if (showResult) {
                const maxPullSeq = this.maxPullSeq;
                const maxPushSeq = this.maxPushSeq;
                const lastSyncPullSeq = this.lastSyncPullSeq;
                const lastSyncPushSeq = this.lastSyncPushSeq;
                const pushLast = ((lastSyncPushSeq == 0) ? "" : (lastSyncPushSeq >= maxPushSeq ? " (LIVE)" : ` (${maxPushSeq - lastSyncPushSeq})`));
                const pullLast = ((lastSyncPullSeq == 0) ? "" : (lastSyncPullSeq >= maxPullSeq ? " (LIVE)" : ` (${maxPullSeq - lastSyncPullSeq})`));
                Logger(`↑${this.docSent - docSentOnStart}${pushLast} ↓${this.docArrived - docArrivedOnStart}${pullLast}`, LOG_LEVEL.NOTICE, "sync");
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
        this.terminateSync();
    }
    replicationDenied(e: any) {
        this.syncStatus = "ERRORED";
        this.updateInfo();
        this.terminateSync();
        Logger("Replication denied", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationErrored(e: any) {
        this.syncStatus = "ERRORED";
        this.terminateSync();
        this.updateInfo();
        Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
        Logger(e);
    }
    replicationPaused() {
        this.syncStatus = "PAUSED";
        this.updateInfo();
        Logger("Replication paused", LOG_LEVEL.VERBOSE, "sync");
    }

    async processSync(syncHandler: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>, showResult: boolean, docSentOnStart: number, docArrivedOnStart: number,
        syncMode: "sync" | "pullOnly" | "pushOnly",
        retrying: boolean): Promise<"DONE" | "NEED_RETRY" | "NEED_RESURRECT" | "FAILED"> {
        const controller = new AbortController();
        if (this.controller) {
            this.controller.abort();
        }
        this.controller = controller;
        const gen = genReplication(syncHandler, controller.signal);
        try {
            for await (const [type, e] of gen) {
                switch (type) {
                    case "change":
                        if ("direction" in e) {
                            if (e.direction == "pull") {
                                this.lastSyncPullSeq = Number(`${e.change.last_seq}`.split("-")[0]);
                            } else {
                                this.lastSyncPushSeq = Number(`${e.change.last_seq}`.split("-")[0]);
                            }
                            await this.replicationChangeDetected(e, showResult, docSentOnStart, docArrivedOnStart);
                        } else {
                            if (syncMode == "pullOnly") {
                                this.lastSyncPullSeq = Number(`${e.last_seq}`.split("-")[0]);
                                await this.replicationChangeDetected({ direction: "pull", change: e }, showResult, docSentOnStart, docArrivedOnStart);

                            } else if (syncMode == "pushOnly") {
                                this.lastSyncPushSeq = Number(`${e.last_seq}`.split("-")[0]);
                                this.updateInfo();
                                await this.replicationChangeDetected({ direction: "push", change: e }, showResult, docSentOnStart, docArrivedOnStart);
                            }
                        }
                        if (retrying) {
                            if (this.docSent - docSentOnStart + (this.docArrived - docArrivedOnStart) > this.originalSetting.batch_size * 2) {
                                return "NEED_RESURRECT";
                            }
                        }
                        break;
                    case "complete":
                        this.replicationCompleted(showResult);
                        return "DONE";
                    case "active":
                        this.replicationActivated(showResult);
                        break;
                    case "denied":
                        this.replicationDenied(e);
                        return "FAILED";
                    case "error":
                        this.replicationErrored(e);
                        Logger("Replication stopped.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
                        if (this.env.getLastPostFailedBySize()) {
                            if (e && e?.status == 413) {
                                Logger(`Self-hosted LiveSync has detected some remote-database-incompatible chunks that exist in the local database. It means synchronization with the server had been no longer possible.\n\nThe problem may be caused by chunks that were created with the faulty version or by switching platforms of the database.\nTo solve the circumstance, configure the remote database correctly or we have to rebuild both local and remote databases.`, LOG_LEVEL.NOTICE);
                                return;
                            }
                            return "NEED_RETRY";
                            // Duplicate settings for smaller batch.
                        } else {
                            Logger("Replication error", LOG_LEVEL.NOTICE, "sync");
                            Logger(e);
                        }
                        return "FAILED"
                    case "paused":
                        this.replicationPaused()
                        break;
                    case "finally":
                        break;
                    default:
                        Logger(`Unexpected synchronization status:${JSON.stringify(e)}`);
                }
            }
            return "DONE";
        } catch (ex) {
            Logger(`Unexpected synchronization exception`);
            Logger(ex, LOG_LEVEL.VERBOSE)

        } finally {
            this.terminateSync();
            this.controller = null;
        }
    }
    async openOneShotReplication(
        setting: RemoteDBSettings,
        showResult: boolean,
        retrying: boolean,
        syncMode: "sync" | "pullOnly" | "pushOnly"
    ): Promise<boolean> {
        if (this.controller != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        const localDB = this.env.getDatabase()
        Logger(`OneShot Sync begin... (${syncMode})`);
        const ret = await this.checkReplicationConnectivity(setting, true, retrying, showResult);
        if (ret === false) {
            Logger("Could not connect to server.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "sync");
            return;
        }
        this.maxPullSeq = Number(`${ret.info.update_seq}`.split("-")[0]);
        this.maxPushSeq = Number(`${(await localDB.info()).update_seq}`.split("-")[0]);
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
        this.terminateSync();
        let syncHandler: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>;
        if (syncMode == "sync") {
            syncHandler = localDB.sync(db, { checkpoint: "target", ...syncOptionBase });
        } else if (syncMode == "pullOnly") {
            syncHandler = localDB.replicate.from(db, { checkpoint: "target", ...syncOptionBase, ...(setting.readChunksOnline ? { filter: "replicate/pull" } : {}) });
        } else if (syncMode == "pushOnly") {
            syncHandler = localDB.replicate.to(db, { checkpoint: "target", ...syncOptionBase, ...(setting.readChunksOnline ? { filter: "replicate/push" } : {}) });
        }
        const syncResult = await this.processSync(syncHandler, showResult, docSentOnStart, docArrivedOnStart, syncMode, retrying);
        if (syncResult == "DONE") {
            return true;
        }
        if (syncResult == "FAILED") {
            return false;
        }
        if (syncResult == "NEED_RESURRECT") {
            this.terminateSync();
            return await this.openOneShotReplication(this.originalSetting, showResult, false, syncMode);
        }
        if (syncResult == "NEED_RETRY") {
            const tempSetting: RemoteDBSettings = JSON.parse(JSON.stringify(setting));
            tempSetting.batch_size = Math.ceil(tempSetting.batch_size / 2) + 2;
            tempSetting.batches_limit = Math.ceil(tempSetting.batches_limit / 2) + 2;
            if (tempSetting.batch_size <= 5 && tempSetting.batches_limit <= 5) {
                Logger("We can't replicate more lower value.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                return false;
            } else {
                Logger(`Retry with lower batch size:${tempSetting.batch_size}/${tempSetting.batches_limit}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                return await this.openOneShotReplication(tempSetting, showResult, true, syncMode);
            }
        }
        return false;
    }

    updateInfo: () => void = () => {
        this.env.replicationStat.set({
            sent: this.docSent,
            arrived: this.docArrived,
            maxPullSeq: this.maxPullSeq,
            maxPushSeq: this.maxPushSeq,
            lastSyncPullSeq: this.lastSyncPullSeq,
            lastSyncPushSeq: this.lastSyncPushSeq,
            syncStatus: this.syncStatus
        });
    };
    replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return this.openOneShotReplication(
            setting,
            showingNotice ?? false,
            false,
            "pushOnly"
        )
    }

    replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return this.openOneShotReplication(setting, showingNotice, false, "pullOnly");
    }


    async checkReplicationConnectivity(setting: RemoteDBSettings, keepAlive: boolean, skipCheck: boolean, showResult: boolean) {

        if (setting.versionUpFlash != "") {
            Logger("Open settings and check message, please.", LOG_LEVEL.NOTICE);
            return false;
        }
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        if (this.controller != null) {
            Logger("Another replication running.");
            return false;
        }

        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.env.getIsMobile());
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
        const syncOption: PouchDB.Replication.SyncOptions = keepAlive ? { live: true, retry: true, heartbeat: setting.useTimeouts ? false : 30000, ...syncOptionBase } : { ...syncOptionBase };

        return { db: dbRet.db, info: dbRet.info, syncOptionBase, syncOption };
    }


    async openContinuousReplication(setting: RemoteDBSettings, showResult: boolean, retrying: boolean): Promise<boolean> {
        if (this.controller != null) {
            Logger("Replication is already in progress.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
            return;
        }
        const localDB = this.env.getDatabase();
        Logger("Before LiveSync, start OneShot once...");
        if (await this.openOneShotReplication(
            setting,
            showResult,
            false,
            "pullOnly"
        )) {
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
            this.maxPullSeq = Number(`${ret.info.update_seq}`.split("-")[0]);
            this.maxPushSeq = Number(`${(await localDB.info()).update_seq}`.split("-")[0]);
            this.updateInfo();
            const docArrivedOnStart = this.docArrived;
            const docSentOnStart = this.docSent;
            if (!retrying) {
                //TODO if successfully saved, roll back org setting.
                this.originalSetting = setting;
            }
            this.terminateSync();
            const syncHandler = localDB.sync<EntryDoc>(db, {
                ...syncOption,
                pull: {
                    checkpoint: "target",
                },
                push: {
                    checkpoint: "source",
                },
            });
            const syncMode = "sync";
            const syncResult = await this.processSync(syncHandler, showResult, docSentOnStart, docArrivedOnStart, syncMode, retrying);

            if (syncResult == "DONE") {
                return true;
            }
            if (syncResult == "FAILED") {
                return false;
            }
            if (syncResult == "NEED_RESURRECT") {
                this.terminateSync();
                return await this.openContinuousReplication(this.originalSetting, showResult, false);
            }
            if (syncResult == "NEED_RETRY") {
                const tempSetting: RemoteDBSettings = JSON.parse(JSON.stringify(setting));
                tempSetting.batch_size = Math.ceil(tempSetting.batch_size / 2) + 2;
                tempSetting.batches_limit = Math.ceil(tempSetting.batches_limit / 2) + 2;
                if (tempSetting.batch_size <= 5 && tempSetting.batches_limit <= 5) {
                    Logger("We can't replicate more lower value.", showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    return false;
                } else {
                    Logger(`Retry with lower batch size:${tempSetting.batch_size}/${tempSetting.batches_limit}`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO);
                    return await this.openContinuousReplication(tempSetting, showResult, true);
                }
            }
        }
    }

    closeReplication() {
        if (!this.controller) {
            return;
        }
        this.controller.abort();
        this.controller = null;
        this.syncStatus = "CLOSED";
        Logger("Replication closed");
        this.updateInfo();
    }

    async tryResetRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        const con = await this.connectRemoteCouchDBWithSetting(setting, this.env.getIsMobile());
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
        const con2 = await this.connectRemoteCouchDBWithSetting(setting, this.env.getIsMobile());

        if (typeof con2 === "string") return;
        Logger("Remote Database Created or Connected", LOG_LEVEL.NOTICE);
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean) {
        const uri = setting.couchDB_URI + (setting.couchDB_DBNAME == "" ? "" : "/" + setting.couchDB_DBNAME);
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.env.getIsMobile());
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
        const dbRet = await this.connectRemoteCouchDBWithSetting(setting, this.env.getIsMobile());
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

    connectRemoteCouchDBWithSetting(settings: RemoteDBSettings, isMobile: boolean) {
        if (settings.encrypt && settings.passphrase == "" && !settings.permitEmptyPassphrase) {
            return "Empty passphrases cannot be used without explicit permission";
        }
        return this.env.connectRemoteCouchDB(
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

    async fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]> {
        const ret = await this.connectRemoteCouchDBWithSetting(this.env.getSettings(), this.env.getIsMobile());
        if (typeof (ret) === "string") {

            Logger(`Could not connect to server.${ret} `, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }
        const remoteChunks = await ret.db.allDocs({ keys: missingChunks, include_docs: true });
        if (remoteChunks.rows.some((e: any) => "error" in e)) {
            Logger(`Some chunks are not exists both on remote and local database.`, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }

        const remoteChunkItems = remoteChunks.rows.map((e: any) => e.doc as EntryLeaf);
        return remoteChunkItems;
    }

}