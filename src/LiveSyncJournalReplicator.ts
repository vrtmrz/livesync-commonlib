import {
    type EntryMilestoneInfo,
    type DatabaseConnectingStatus,
    type RemoteDBSettings, type EntryLeaf, LOG_LEVEL_NOTICE,
    type ChunkVersionRange,
    type DocumentID
} from "./types.ts";
import { Logger } from "./logger.ts";

import { JournalSyncMinio } from "./JournalSyncMinio.ts";

import { LiveSyncAbstractReplicator, type LiveSyncReplicatorEnv } from "./LiveSyncAbstractReplicator.ts";
import type { ENSURE_DB_RESULT } from "./LiveSyncDBFunctions.ts";
import type { CheckPointInfo, SimpleStore } from "./JournalSyncTypes.ts";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

const MILSTONE_DOCID = "_00000000-milestone.json"

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
}

export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
    simpleStore: SimpleStore<CheckPointInfo | any>;
    customFetchHandler: () => FetchHttpHandler | undefined;
}


export class LiveSyncJournalReplicator extends LiveSyncAbstractReplicator {


    syncStatus: DatabaseConnectingStatus = "NOT_CONNECTED";
    docArrived = 0;
    docSent = 0;

    lastSyncPullSeq = 0;
    maxPullSeq = 0;
    lastSyncPushSeq = 0;
    maxPushSeq = 0;
    controller?: AbortController;
    originalSetting!: RemoteDBSettings;
    nodeid = "";
    remoteLocked = false;
    remoteCleaned = false;
    remoteLockedAndDeviceNotAccepted = false;

    env: LiveSyncJournalReplicatorEnv;

    get client() {
        return this.setupJournalSyncClient();
    }

    _client!: JournalSyncMinio;

    setupJournalSyncClient() {
        const settings = this.env.getSettings();
        const id = settings.accessKey
        const key = settings.secretKey
        const bucket = settings.bucket
        const region = settings.region
        const endpoint = settings.endpoint
        const useCustomRequestHandler = settings.useCustomRequestHandler;
        if (this._client) {
            this._client.applyNewConfig(id, key, endpoint, bucket, this.env.simpleStore, this.env, useCustomRequestHandler, region);
            // NO OP.
            // this._client.requestStop();
        } else {
            this._client = new JournalSyncMinio(id, key, endpoint, bucket, this.env.simpleStore, this.env, useCustomRequestHandler, region);
        }
        return this._client;
    }

    async ensureBucketIsCompatible(deviceNodeID: string, currentVersionRange: ChunkVersionRange): Promise<ENSURE_DB_RESULT> {
        const defMilestonePoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: false,
            accepted_nodes: [deviceNodeID],
            node_chunk_info: { [deviceNodeID]: currentVersionRange }
        };

        const remoteMilestone: EntryMilestoneInfo = { ...defMilestonePoint, ...(await this.client.downloadJson(MILSTONE_DOCID) || {}) };
        remoteMilestone.node_chunk_info = { ...defMilestonePoint.node_chunk_info, ...remoteMilestone.node_chunk_info };

        const writeMilestone = (
            (
                remoteMilestone.node_chunk_info[deviceNodeID].min != currentVersionRange.min
                || remoteMilestone.node_chunk_info[deviceNodeID].max != currentVersionRange.max
            ));

        if (writeMilestone) {
            remoteMilestone.node_chunk_info[deviceNodeID].min = currentVersionRange.min;
            remoteMilestone.node_chunk_info[deviceNodeID].max = currentVersionRange.max;
            await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
        }
        if (remoteMilestone.locked) {
            if (remoteMilestone.accepted_nodes.indexOf(deviceNodeID) == -1) {
                if (remoteMilestone.cleaned) {
                    return "NODE_CLEANED";
                }
                return "NODE_LOCKED";
            }
            return "LOCKED";
        }
        return "OK";

    }

    constructor(env: LiveSyncJournalReplicatorEnv) {
        super(env);
        this.env = env;
        // initialize local node information.
        this.initializeDatabaseForReplication();
        this.env.getDatabase().on("close", () => {
            this.closeReplication();
        })
    }

    // eslint-disable-next-line require-await
    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL_NOTICE);
        // no op now,
        return true;
    }

    terminateSync() {
        this.client.requestStop();
    }

    async openReplication(setting: RemoteDBSettings, _: boolean, showResult: boolean, ignoreCleanLock = false) {
        if (!await this.checkReplicationConnectivity(false, ignoreCleanLock)) return false;
        await this.client.sync(showResult);
    }

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
    async replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        if (!await this.checkReplicationConnectivity(false)) return false;
        return await this.client.sendLocalJournal(showingNotice);
    }

    async replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        if (!await this.checkReplicationConnectivity(false)) return false;
        return await this.client.receiveRemoteJournal(showingNotice);
    }


    async checkReplicationConnectivity(skipCheck: boolean, ignoreCleanLock = false) {
        if (!skipCheck) {
            this.remoteCleaned = false;
            this.remoteLocked = false;
            this.remoteLockedAndDeviceNotAccepted = false;
            const ensure = await this.ensureBucketIsCompatible(this.nodeid, currentVersionRange);
            if (ensure == "INCOMPATIBLE") {
                Logger("The remote database has no compatibility with the running version. Please upgrade the plugin.", LOG_LEVEL_NOTICE);
                return false;
            } else if (ensure == "NODE_LOCKED") {
                Logger("The remote database has been rebuilt or corrupted since we have synchronized last time. Fetch rebuilt DB, explicit unlocking or chunk clean-up is required.", LOG_LEVEL_NOTICE);
                this.remoteLockedAndDeviceNotAccepted = true;
                this.remoteLocked = true;
                return false;
            } else if (ensure == "LOCKED") {
                this.remoteLocked = true;
            } else if (ensure == "NODE_CLEANED") {
                if (ignoreCleanLock) {
                    this.remoteLocked = true;
                } else {
                    Logger("The remote database has been cleaned up. Fetch rebuilt DB, explicit unlocking or chunk clean-up is required.", LOG_LEVEL_NOTICE);
                    this.remoteLockedAndDeviceNotAccepted = true;
                    this.remoteLocked = true;
                    this.remoteCleaned = true;
                    return false;
                }
            }
        }
        return true
    }
    async fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]> {
        return []
    }

    closeReplication() {
        this.client.requestStop();
        this.syncStatus = "CLOSED";
        Logger("Replication closed");
        this.updateInfo();
    }

    async tryResetRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        try {
            await this.client.resetBucket();
            Logger("Remote Bucket Cleared", LOG_LEVEL_NOTICE);
            await this.tryCreateRemoteDatabase(setting);
        } catch (ex) {
            Logger("Something happened on Remote Bucket Clear", LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
        }
    }
    async tryCreateRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        Logger("Remote Database Created or Connected", LOG_LEVEL_NOTICE);
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean) {
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: locked,
            cleaned: lockByClean,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };

        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...(await this.client.downloadJson(MILSTONE_DOCID) || {}) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = [this.nodeid];
        remoteMilestone.locked = locked;
        remoteMilestone.cleaned = remoteMilestone.cleaned || lockByClean;
        if (locked) {
            Logger("Lock remote bucket to prevent data corruption", LOG_LEVEL_NOTICE);
        } else {
            Logger("Unlock remote bucket to prevent data corruption", LOG_LEVEL_NOTICE);
        }
        await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
    }
    async markRemoteResolved(setting: RemoteDBSettings) {
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: false,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange }
        };

        const remoteMilestone: EntryMilestoneInfo = { ...defInitPoint, ...(await this.client.downloadJson(MILSTONE_DOCID) || {}) };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = Array.from(new Set([...remoteMilestone.accepted_nodes, this.nodeid]));
        Logger("Mark this device as 'resolved'.", LOG_LEVEL_NOTICE);
        await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
    }

    async tryConnectRemote(setting: RemoteDBSettings, showResult: boolean = true): Promise<boolean> {
        const id = setting.accessKey
        const key = setting.secretKey
        const bucket = setting.bucket
        const region = setting.region
        const endpoint = setting.endpoint
        const useCustomRequestHandler = setting.useCustomRequestHandler;
        const testClient = new JournalSyncMinio(id, key, endpoint, bucket, this.env.simpleStore, this.env, useCustomRequestHandler, region);
        try {
            await testClient.listFiles("", 1);
            Logger(`Connected to ${endpoint} successfully!`, LOG_LEVEL_NOTICE);
            return true;
        } catch (ex) {
            Logger(`Error! Could not connected to ${endpoint}\n${(ex as Error).message}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
            return false
        }
    }

}