import {
    type EntryDoc,
    type DatabaseConnectingStatus,
    type RemoteDBSettings,
    type BucketSyncSetting,
    type ObsidianLiveSyncSettings,
    type EntryLeaf,
    type EntryNodeInfo,
    NODEINFO_DOCID
} from "./types.ts";

import type { ReactiveSource } from "./reactive.ts";
import { Logger } from "./logger.ts";
import { resolveWithIgnoreKnownError } from "./utils.ts";


export type ReplicationCallback = (e: PouchDB.Core.ExistingDocument<EntryDoc>[]) => Promise<void> | void;
export type ReplicationStat = {
    sent: number;
    arrived: number;
    maxPullSeq: number;
    maxPushSeq: number;
    lastSyncPullSeq: number;
    lastSyncPushSeq: number;
    syncStatus: DatabaseConnectingStatus;
}
export interface LiveSyncReplicatorEnv {
    getDatabase(): PouchDB.Database<EntryDoc>;
    getSettings(): RemoteDBSettings & BucketSyncSetting & Pick<ObsidianLiveSyncSettings, "remoteType">;
    getIsMobile(): boolean;
    getLastPostFailedBySize(): boolean;
    processReplication: ReplicationCallback;
    replicationStat: ReactiveSource<ReplicationStat>,
}

export abstract class LiveSyncAbstractReplicator {

    syncStatus: DatabaseConnectingStatus = "NOT_CONNECTED";
    docArrived = 0;
    docSent = 0;

    lastSyncPullSeq = 0;
    maxPullSeq = 0;
    lastSyncPushSeq = 0;
    maxPushSeq = 0;
    controller?: AbortController;
    // localDatabase: PouchDB.Database<EntryDoc>;
    originalSetting!: RemoteDBSettings;
    nodeid = "";
    remoteLocked = false;
    remoteCleaned = false;
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
            return true;
        } catch (ex) {
            Logger(ex);
        }
        return false;
    }

    constructor(env: LiveSyncReplicatorEnv) {
        this.env = env;
        // initialize local node information.
    }

    abstract terminateSync(): void

    abstract openReplication(setting: RemoteDBSettings, keepAlive: boolean, showResult: boolean, ignoreCleanLock: boolean): Promise<void | boolean>

    updateInfo: () => void = () => {
        this.env.replicationStat.value = {
            sent: this.docSent,
            arrived: this.docArrived,
            maxPullSeq: this.maxPullSeq,
            maxPushSeq: this.maxPushSeq,
            lastSyncPullSeq: this.lastSyncPullSeq,
            lastSyncPushSeq: this.lastSyncPushSeq,
            syncStatus: this.syncStatus
        };
    };

    abstract tryConnectRemote(setting: RemoteDBSettings, showResult?: boolean): Promise<boolean>;
    abstract replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>
    abstract replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>
    abstract closeReplication(): void;

    abstract tryResetRemoteDatabase(setting: RemoteDBSettings): Promise<void>
    abstract tryCreateRemoteDatabase(setting: RemoteDBSettings): Promise<void>

    abstract markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean): Promise<void>;
    abstract markRemoteResolved(setting: RemoteDBSettings): Promise<void>;

    abstract fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]>;

}