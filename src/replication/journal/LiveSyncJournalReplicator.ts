import {
    type EntryMilestoneInfo,
    type RemoteDBSettings,
    type EntryLeaf,
    LOG_LEVEL_NOTICE,
    type ChunkVersionRange,
    type DocumentID,
    LOG_LEVEL_VERBOSE,
    DEVICE_ID_PREFERRED,
    TweakValuesTemplate,
    type TweakValues,
    type NodeData,
} from "../../common/types.ts";
import { Logger } from "../../common/logger.ts";

import { JournalSyncMinio } from "./objectstore/JournalSyncMinio.ts";

import {
    LiveSyncAbstractReplicator,
    type LiveSyncReplicatorEnv,
    type RemoteDBStatus,
} from "../LiveSyncAbstractReplicator.ts";
import { ensureRemoteIsCompatible, type ENSURE_DB_RESULT } from "../../pouchdb/LiveSyncDBFunctions.ts";
import type { CheckPointInfo } from "./JournalSyncTypes.ts";
import { fireAndForget, type SimpleStore } from "../../common/utils.ts";

import { extractObject } from "../../common/utils.ts";
import { clearHandlers } from "../SyncParamsHandler.ts";
import type { ServiceHub } from "../../services/ServiceHub.ts";

const MILSTONE_DOCID = "_00000000-milestone.json";

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
};

export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
    // simpleStore: SimpleStore<CheckPointInfo | any>;
    // $$customFetchHandler: () => FetchHttpHandler | undefined;
    services: ServiceHub;
}

export class LiveSyncJournalReplicator extends LiveSyncAbstractReplicator {
    override env: LiveSyncJournalReplicatorEnv;

    get isChunkSendingSupported(): boolean {
        return false;
    }
    get client() {
        return this.setupJournalSyncClient();
    }

    get simpleStore() {
        return this.env.services.keyValueDB.simpleStore as SimpleStore<CheckPointInfo>;
    }
    _client!: JournalSyncMinio;

    override async getReplicationPBKDF2Salt(
        setting: RemoteDBSettings,
        refresh?: boolean
    ): Promise<Uint8Array<ArrayBuffer>> {
        return await this.client.getReplicationPBKDF2Salt(refresh);
    }

    setupJournalSyncClient() {
        const settings = this.currentSettings;
        if (this._client) {
            this._client.applyNewConfig(settings, this.simpleStore, this.env);
            // NO OP.
            // this._client.requestStop();
        } else {
            this._client = new JournalSyncMinio(settings, this.simpleStore, this.env);
        }
        return this._client;
    }

    async ensureBucketIsCompatible(
        deviceNodeID: string,
        currentVersionRange: ChunkVersionRange
    ): Promise<ENSURE_DB_RESULT> {
        const downloadedMilestone = await this.client.downloadJson<EntryMilestoneInfo>(MILSTONE_DOCID);
        const cPointInfo = await this.client.getCheckpointInfo();
        const progress = [...(cPointInfo?.receivedFiles || [])].sort().pop() || "";
        return await ensureRemoteIsCompatible(
            downloadedMilestone,
            this.currentSettings,
            deviceNodeID,
            currentVersionRange,
            {
                app_version: this.env.services.API.getAppVersion(),
                plugin_version: this.env.services.API.getPluginVersion(),
                vault_name: this.env.services.vault.vaultName(),
                device_name: this.env.services.vault.getVaultName(),
                progress: progress,
            },
            async (info) => {
                await this.client.uploadJson(MILSTONE_DOCID, info);
            }
        );
    }

    constructor(env: LiveSyncJournalReplicatorEnv) {
        super(env);
        this.env = env;
        // initialize local node information.
        fireAndForget(() => this.initializeDatabaseForReplication());
        this.rawDatabase.on("close", () => {
            this.closeReplication();
        });
    }

    // eslint-disable-next-line require-await
    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL_NOTICE);
        // no op now,
        return Promise.resolve(true);
    }

    terminateSync() {
        this.client.requestStop();
    }

    async openReplication(setting: RemoteDBSettings, _: boolean, showResult: boolean, ignoreCleanLock = false) {
        if (!(await this.checkReplicationConnectivity(false, ignoreCleanLock))) return false;
        await this.client.sync(showResult);
    }

    async replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        if (!(await this.checkReplicationConnectivity(false))) return false;
        return await this.client.sendLocalJournal(showingNotice);
    }

    async replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        if (!(await this.checkReplicationConnectivity(false))) return false;
        return await this.client.receiveRemoteJournal(showingNotice);
    }

    async checkReplicationConnectivity(skipCheck: boolean, ignoreCleanLock = false) {
        if (!(await this.client.isAvailable())) {
            return false;
        }
        if (!skipCheck) {
            this.remoteCleaned = false;
            this.remoteLocked = false;
            this.remoteLockedAndDeviceNotAccepted = false;
            this.tweakSettingsMismatched = false;
            const ensure = await this.ensureBucketIsCompatible(this.nodeid, currentVersionRange);
            if (ensure == "INCOMPATIBLE") {
                Logger(
                    "The remote database has no compatibility with the running version. Please upgrade the plugin.",
                    LOG_LEVEL_NOTICE
                );
                return false;
            } else if (ensure == "NODE_LOCKED") {
                Logger(
                    "The remote database has been rebuilt or corrupted since we have synchronized last time. Fetch rebuilt DB, explicit unlocking or chunk clean-up is required.",
                    LOG_LEVEL_NOTICE
                );
                this.remoteLockedAndDeviceNotAccepted = true;
                this.remoteLocked = true;
                return false;
            } else if (ensure == "LOCKED") {
                this.remoteLocked = true;
            } else if (ensure == "NODE_CLEANED") {
                if (ignoreCleanLock) {
                    this.remoteLocked = true;
                } else {
                    Logger(
                        "The remote database has been cleaned up. Fetch rebuilt DB, explicit unlocking or chunk clean-up is required.",
                        LOG_LEVEL_NOTICE
                    );
                    this.remoteLockedAndDeviceNotAccepted = true;
                    this.remoteLocked = true;
                    this.remoteCleaned = true;
                    return false;
                }
            } else if (ensure == "OK") {
                /* NO OP FOR NARROWING */
            } else if (ensure[0] == "MISMATCHED") {
                Logger(
                    `Configuration mismatching between the clients has been detected. This can be harmful or extra capacity consumption. We have to make these value unified.`,
                    LOG_LEVEL_NOTICE
                );
                this.tweakSettingsMismatched = true;
                this.preferredTweakValue = ensure[1];
                return false;
            }
        }
        return true;
    }
    // eslint-disable-next-line require-await
    async fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]> {
        return Promise.resolve([]);
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
            clearHandlers();
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
        clearHandlers();
        await this.ensurePBKDF2Salt(setting, true, false);
        return await Promise.resolve();
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean) {
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: (new Date() as any) / 1,
            locked: locked,
            cleaned: lockByClean,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange },
            node_info: {},
            tweak_values: {},
        };

        const remoteMilestone: EntryMilestoneInfo = {
            ...defInitPoint,
            ...((await this.client.downloadJson(MILSTONE_DOCID)) || {}),
        };
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
            node_chunk_info: { [this.nodeid]: currentVersionRange },
            node_info: {},
            tweak_values: {},
        };

        const remoteMilestone: EntryMilestoneInfo = {
            ...defInitPoint,
            ...((await this.client.downloadJson(MILSTONE_DOCID)) || {}),
        };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = Array.from(new Set([...remoteMilestone.accepted_nodes, this.nodeid]));
        Logger("Mark this device as 'resolved'.", LOG_LEVEL_NOTICE);
        await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
    }

    async tryConnectRemote(setting: RemoteDBSettings, showResult: boolean = true): Promise<boolean> {
        const endpoint = setting.endpoint;
        const testClient = new JournalSyncMinio(setting, this.simpleStore, this.env);
        try {
            await testClient.listFiles("", 1);
            Logger(`Connected to ${endpoint} successfully!`, LOG_LEVEL_NOTICE);
            return true;
        } catch (ex) {
            Logger(`Error! Could not connected to ${endpoint}\n${(ex as Error).message}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
            return false;
        }
    }

    async resetRemoteTweakSettings(setting: RemoteDBSettings) {
        try {
            const remoteMilestone = await this.client.downloadJson<EntryMilestoneInfo>(MILSTONE_DOCID);
            if (!remoteMilestone) {
                throw new Error("Missing remote milestone");
            }
            remoteMilestone.tweak_values = {};
            Logger(`tweak values on the remote database have been cleared`, LOG_LEVEL_VERBOSE);
            await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
        } catch (ex) {
            Logger(`Could not retrieve remote milestone`, LOG_LEVEL_NOTICE);
            throw ex;
        }
    }

    async setPreferredRemoteTweakSettings(setting: RemoteDBSettings): Promise<void> {
        try {
            const remoteMilestone = await this.client.downloadJson<EntryMilestoneInfo>(MILSTONE_DOCID);
            if (!remoteMilestone) {
                throw new Error("Missing remote milestone");
            }
            remoteMilestone.tweak_values[DEVICE_ID_PREFERRED] = extractObject(TweakValuesTemplate, { ...setting });
            Logger(`tweak values on the remote database have been cleared`, LOG_LEVEL_VERBOSE);
            await this.client.uploadJson(MILSTONE_DOCID, remoteMilestone);
        } catch (ex) {
            Logger(`Could not retrieve remote milestone`, LOG_LEVEL_NOTICE);
            throw ex;
        }
    }

    async getRemotePreferredTweakValues(setting: RemoteDBSettings): Promise<false | TweakValues> {
        try {
            const remoteMilestone = await this.client.downloadJson<EntryMilestoneInfo>(MILSTONE_DOCID);
            if (!remoteMilestone) {
                throw new Error("Missing remote milestone");
            }
            return remoteMilestone?.tweak_values?.[DEVICE_ID_PREFERRED] || false;
        } catch (ex) {
            Logger(`Could not retrieve remote milestone`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async getRemoteStatus(setting: RemoteDBSettings): Promise<false | RemoteDBStatus> {
        const testClient = new JournalSyncMinio(setting, this.simpleStore, this.env);
        return await testClient.getUsage();
    }

    countCompromisedChunks(): Promise<number> {
        Logger(`Bucket Sync Replicator cannot count compromised chunks`, LOG_LEVEL_VERBOSE);
        return Promise.resolve(0);
    }
    getConnectedDeviceList(
        setting?: RemoteDBSettings
    ): Promise<false | { node_info: Record<string, NodeData>; accepted_nodes: string[] }> {
        return Promise.resolve(false);
    }
}
