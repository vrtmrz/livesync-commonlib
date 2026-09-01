import {
    type EntryMilestoneInfo,
    type RemoteDBSettings,
    LOG_LEVEL_NOTICE,
    type ChunkVersionRange,
    type DocumentID,
    LOG_LEVEL_VERBOSE,
    DEVICE_ID_PREFERRED,
    TweakValuesTemplate,
    type TweakValues,
    type NodeData,
    RemotePreferredTweakNotConfiguredReasons,
    type RemotePreferredTweakResult,
    RemotePreferredTweakStatuses,
} from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";

import { JournalSyncCore } from "./JournalSyncCore.ts";
import { MinioStorageAdapter } from "./objectstore/MinioStorageAdapter.ts";

import { LiveSyncAbstractReplicator, type RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import { ensureRemoteIsCompatible, type ENSURE_DB_RESULT } from "@lib/pouchdb/LiveSyncDBFunctions.ts";
import type { CheckPointInfo } from "./JournalSyncTypes.ts";
import type { SimpleStore } from "@lib/common/utils.ts";

import { extractObject } from "@lib/common/utils.ts";
import { clearHandlers } from "@lib/replication/SyncParamsHandler.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import { JournalStorageReadStatuses } from "./objectstore/JournalStorageAdapter.ts";
import {
    CENTRAL_COMPATIBILITY_ACCEPTED,
    CENTRAL_COMPATIBILITY_NOT_ASSESSED,
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRejected,
    centralCompatibilityRecoveryHint,
    type CentralCompatibilityDecision,
    type CentralCompatibilityDecisionRecorder,
} from "@lib/replication/CentralCompatibility.ts";
import {
    outcomeFromFiniteOpenReplication,
    replicationFailed,
    type ReplicationOutcome,
} from "@lib/replication/ReplicatorProvider.ts";

const MILSTONE_DOCID = "_00000000-milestone.json";

type JournalMilestoneReadClient = Pick<JournalSyncCore, "downloadJsonWithResult">;

/** Read a central milestone without converting remote uncertainty into absence. */
async function readRemoteMilestone(client: JournalMilestoneReadClient): Promise<EntryMilestoneInfo | undefined> {
    const result = await client.downloadJsonWithResult<EntryMilestoneInfo>(MILSTONE_DOCID);
    if (result.status === JournalStorageReadStatuses.AVAILABLE) return result.value;
    if (result.status === JournalStorageReadStatuses.NOT_FOUND) return undefined;
    throw result.error;
}

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
};

export class LiveSyncJournalReplicator extends LiveSyncAbstractReplicator {
    declare env: LiveSyncJournalReplicatorEnv;

    get client() {
        return this.setupJournalSyncClient();
    }

    get simpleStore() {
        return this.env.services.keyValueDB.simpleStore as SimpleStore<CheckPointInfo>;
    }
    _client?: JournalSyncCore;
    /** Whether this instance has entered a Journal transfer since its last close. */
    private hasEnteredReplication = false;
    /** Transfers whose settlement must be observed by an admitted Stop request. */
    private activeJournalTransfers?: Set<Promise<boolean>>;
    /** Shared settlement for repeated Stop requests at the same boundary. */
    private journalTransferStopSettlement?: Promise<void>;
    /** Monotonic fence which prevents a preflight crossing a later Stop boundary. */
    private journalTransferStopGeneration = 0;

    async getReplicationPBKDF2Salt(setting: RemoteDBSettings, refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return await this.setupJournalSyncClient(setting).getReplicationPBKDF2Salt(refresh);
    }

    setupJournalSyncClient(settings: RemoteDBSettings = this.currentSettings) {
        if (this._client) {
            this._client.applyNewConfig(settings, this.simpleStore, this.env);
        } else {
            this._client = new JournalSyncCore(
                settings,
                this.simpleStore,
                this.env,
                new MinioStorageAdapter(settings, this.env)
            );
        }
        return this._client;
    }

    async ensureBucketIsCompatible(
        deviceNodeID: string,
        currentVersionRange: ChunkVersionRange,
        setting: RemoteDBSettings = this.currentSettings,
        client: Pick<
            JournalSyncCore,
            "downloadJsonWithResult" | "getCheckpointInfo" | "uploadJson"
        > = this.setupJournalSyncClient(setting)
    ): Promise<ENSURE_DB_RESULT> {
        const milestoneResult = await client.downloadJsonWithResult<EntryMilestoneInfo>(MILSTONE_DOCID);
        if (milestoneResult.status === JournalStorageReadStatuses.UNAVAILABLE) {
            throw milestoneResult.error;
        }
        const downloadedMilestone =
            milestoneResult.status === JournalStorageReadStatuses.AVAILABLE ? milestoneResult.value : false;
        const cPointInfo = await client.getCheckpointInfo();
        const progress = [...(cPointInfo?.receivedFiles || [])].sort().pop() || "";
        return await ensureRemoteIsCompatible(
            downloadedMilestone,
            setting,
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
                if (!(await client.uploadJson(MILSTONE_DOCID, info))) {
                    throw new Error("Could not upload remote milestone");
                }
            }
        );
    }

    constructor(env: LiveSyncJournalReplicatorEnv) {
        super(env);
        this.env = env;
    }

    async migrate(from: number, to: number): Promise<boolean> {
        Logger(`Database updated from ${from} to ${to}`, LOG_LEVEL_NOTICE);
        // no op now,
        return Promise.resolve(true);
    }

    /**
     * Run one Replicator-owned Journal transfer after any earlier Stop boundary.
     *
     * The client owns transfer mechanics, while this Replicator owns the
     * settlement required by its active-transfer cancellation contract.
     */
    private runJournalTransfer(run: (stopGeneration: number) => Promise<boolean>): Promise<boolean> {
        const stopGeneration = this.journalTransferStopGeneration;
        let resolveTask!: (value: boolean | PromiseLike<boolean>) => void;
        let rejectTask!: (reason?: unknown) => void;
        const task = new Promise<boolean>((resolve, reject) => {
            resolveTask = resolve;
            rejectTask = reject;
        });
        const activeTransfers = (this.activeJournalTransfers ??= new Set());
        activeTransfers.add(task);
        const release = () => activeTransfers.delete(task);
        void task.then(release, release);

        // Register settlement before starting setup: a synchronous client hook
        // may re-enter Stop, which must still observe this admitted transfer.
        void (async () => {
            const stopping = this.journalTransferStopSettlement;
            if (stopping) {
                await stopping;
            }
            return await run(stopGeneration);
        })().then(resolveTask, rejectTask);
        return task;
    }

    /** Request client cancellation and await the transfers admitted before this Stop boundary. */
    terminateSync(): Promise<void> {
        // Stop is a control over existing work. It must not acquire the lazy
        // Journal client merely because an unused publication is retiring.
        this.journalTransferStopGeneration += 1;
        const client = this._client;
        client?.requestStop();
        if (this.journalTransferStopSettlement) {
            return this.journalTransferStopSettlement;
        }
        const activeTransfers = [...(this.activeJournalTransfers ?? [])];
        if (activeTransfers.length === 0) return Promise.resolve();

        let settlement!: Promise<void>;
        settlement = Promise.allSettled(activeTransfers).then(() => {
            if (this.journalTransferStopSettlement === settlement) {
                this.journalTransferStopSettlement = undefined;
            }
        });
        this.journalTransferStopSettlement = settlement;
        return settlement;
    }

    async openReplication(
        setting: RemoteDBSettings,
        _: boolean,
        showResult: boolean,
        ignoreCleanLock = false,
        recordCompatibilityDecision?: CentralCompatibilityDecisionRecorder
    ) {
        return await this.runJournalTransfer(async (stopGeneration) => {
            const client = this.setupJournalSyncClient(setting);
            // Setup may synchronously re-enter Stop while admitting the client.
            // The cancellation fence starts when this attempt enters its
            // connectivity preflight, not while that client is being obtained.
            stopGeneration = this.journalTransferStopGeneration;
            if (
                !(await this.checkReplicationConnectivity(
                    false,
                    ignoreCleanLock,
                    showResult,
                    setting,
                    client,
                    recordCompatibilityDecision
                ))
            ) {
                return false;
            }
            if (stopGeneration !== this.journalTransferStopGeneration) return false;
            this.hasEnteredReplication = true;
            return await client.sync(showResult);
        });
    }

    /**
     * Run one finite Journal attempt against one settings-bound borrowed client.
     *
     * Only a rejection observed by this attempt is projected into recovery;
     * unavailable storage and later transport failures do not reuse old state.
     */
    async openOneShotReplicationWithOutcome(
        setting: RemoteDBSettings,
        showResult: boolean,
        ignoreCleanLock = false
    ): Promise<ReplicationOutcome> {
        let decision: CentralCompatibilityDecision = CENTRAL_COMPATIBILITY_NOT_ASSESSED;
        const recordDecision: CentralCompatibilityDecisionRecorder = (next) => {
            decision = next;
        };
        try {
            const result = await this.openReplication(setting, false, showResult, ignoreCleanLock, recordDecision);
            return outcomeFromFiniteOpenReplication(result, centralCompatibilityRecoveryHint(decision));
        } catch (error) {
            return replicationFailed(error, centralCompatibilityRecoveryHint(decision));
        }
    }

    private async runDirectionalReplication(
        setting: RemoteDBSettings,
        showingNotice: boolean | undefined,
        transfer: (client: JournalSyncCore) => Promise<boolean>,
        recordCompatibilityDecision?: CentralCompatibilityDecisionRecorder
    ): Promise<boolean> {
        return await this.runJournalTransfer(async (stopGeneration) => {
            const client = this.setupJournalSyncClient(setting);
            stopGeneration = this.journalTransferStopGeneration;
            if (
                !(await this.checkReplicationConnectivity(
                    false,
                    false,
                    !!showingNotice,
                    setting,
                    client,
                    recordCompatibilityDecision
                ))
            ) {
                return false;
            }
            if (stopGeneration !== this.journalTransferStopGeneration) return false;
            this.hasEnteredReplication = true;
            return await transfer(client);
        });
    }

    /** Capture only the compatibility decision made by this exact borrowed client. */
    private async runDirectionalReplicationWithOutcome(
        setting: RemoteDBSettings,
        showingNotice: boolean | undefined,
        transfer: (client: JournalSyncCore) => Promise<boolean>
    ): Promise<ReplicationOutcome> {
        let decision: CentralCompatibilityDecision = CENTRAL_COMPATIBILITY_NOT_ASSESSED;
        const recordDecision: CentralCompatibilityDecisionRecorder = (next) => {
            decision = next;
        };
        try {
            const result = await this.runDirectionalReplication(setting, showingNotice, transfer, recordDecision);
            return outcomeFromFiniteOpenReplication(result, centralCompatibilityRecoveryHint(decision));
        } catch (error) {
            return replicationFailed(error, centralCompatibilityRecoveryHint(decision));
        }
    }

    async replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return await this.runDirectionalReplication(setting, showingNotice, (client) =>
            client.sendLocalJournal(showingNotice)
        );
    }

    async replicateAllToServerWithOutcome(setting: RemoteDBSettings, showingNotice?: boolean) {
        return await this.runDirectionalReplicationWithOutcome(setting, showingNotice, (client) =>
            client.sendLocalJournal(showingNotice)
        );
    }

    async replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean) {
        return await this.runDirectionalReplication(setting, showingNotice, (client) =>
            client.receiveRemoteJournal(showingNotice)
        );
    }

    async replicateAllFromServerWithOutcome(setting: RemoteDBSettings, showingNotice?: boolean) {
        return await this.runDirectionalReplicationWithOutcome(setting, showingNotice, (client) =>
            client.receiveRemoteJournal(showingNotice)
        );
    }

    async checkReplicationConnectivity(
        skipCheck: boolean,
        ignoreCleanLock = false,
        showMessage = false,
        setting: RemoteDBSettings = this.currentSettings,
        client: JournalSyncCore = this.setupJournalSyncClient(setting),
        recordCompatibilityDecision?: CentralCompatibilityDecisionRecorder
    ) {
        recordCompatibilityDecision?.(CENTRAL_COMPATIBILITY_NOT_ASSESSED);
        if (!(await client.isAvailable())) {
            return false;
        }
        if (!skipCheck) {
            // Keep compatibility result semantics strict: epoch/cache policy is handled as a separate preflight.
            await client.ensureCheckpointCachesAreFresh();
            this.remoteCleaned = false;
            this.remoteLocked = false;
            this.remoteLockedAndDeviceNotAccepted = false;
            this.tweakSettingsMismatched = false;
            this.preferredTweakValue = undefined;
            const ensure = await this.ensureBucketIsCompatible(this.nodeid, currentVersionRange, setting, client);
            if (ensure == "INCOMPATIBLE") {
                recordCompatibilityDecision?.(
                    centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.INCOMPATIBLE_VERSION)
                );
                Logger(
                    "The remote database has no compatibility with the running version. Please upgrade the plugin.",
                    LOG_LEVEL_NOTICE
                );
                return false;
            } else if (ensure == "NODE_LOCKED") {
                recordCompatibilityDecision?.(
                    centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED)
                );
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
                    recordCompatibilityDecision?.(
                        centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_CLEANED)
                    );
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
                recordCompatibilityDecision?.(
                    centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH, ensure[1])
                );
                Logger(this.translate("liveSyncReplicator.mismatchedTweakDetected"), LOG_LEVEL_NOTICE);
                this.tweakSettingsMismatched = true;
                this.preferredTweakValue = ensure[1];
                return false;
            }
            recordCompatibilityDecision?.(CENTRAL_COMPATIBILITY_ACCEPTED);
        }
        return true;
    }
    closeReplication() {
        // A never-used trial Replicator owns no Journal client. Closing it must
        // not construct the resource which this method is meant to release.
        const reportClosure = this.hasEnteredReplication;
        this.hasEnteredReplication = false;
        const client = this._client;
        // Detach before disposal so a later lazy access cannot reconfigure and
        // reuse a client whose storage adapter has already been retired.
        this._client = undefined;
        client?.dispose();
        this.syncStatus = "CLOSED";
        if (reportClosure) {
            Logger("Replication closed");
        }
        this.updateInfo();
    }

    async tryResetRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        try {
            if (!(await this.client.resetBucket())) {
                throw new Error("Could not reset remote bucket");
            }
            clearHandlers();
            Logger("Remote Bucket Cleared", LOG_LEVEL_NOTICE);
            await this.tryCreateRemoteDatabase(setting);
        } catch (ex) {
            Logger("Something happened on Remote Bucket Clear", LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
            throw ex;
        }
    }

    async tryCreateRemoteDatabase(setting: RemoteDBSettings) {
        this.closeReplication();
        Logger("Remote Database Created or Connected", LOG_LEVEL_NOTICE);
        clearHandlers();
        if (!(await this.ensurePBKDF2Salt(setting, true, false))) {
            throw new Error("Could not ensure PBKDF2 salt (Security Seed)");
        }
        return await Promise.resolve();
    }
    async markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean) {
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: Date.now(),
            locked: locked,
            cleaned: lockByClean,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange },
            node_info: {},
            tweak_values: {},
        };

        const client = this.setupJournalSyncClient(setting);
        const remoteMilestone: EntryMilestoneInfo = {
            ...defInitPoint,
            ...((await readRemoteMilestone(client)) ?? {}),
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
        if (!(await client.uploadJson(MILSTONE_DOCID, remoteMilestone))) {
            throw new Error("Could not upload remote milestone");
        }
    }
    async markRemoteResolved(setting: RemoteDBSettings) {
        const defInitPoint: EntryMilestoneInfo = {
            _id: MILSTONE_DOCID as DocumentID,
            type: "milestoneinfo",
            created: Date.now(),
            locked: false,
            accepted_nodes: [this.nodeid],
            node_chunk_info: { [this.nodeid]: currentVersionRange },
            node_info: {},
            tweak_values: {},
        };

        const client = this.setupJournalSyncClient(setting);
        const remoteMilestone: EntryMilestoneInfo = {
            ...defInitPoint,
            ...((await readRemoteMilestone(client)) ?? {}),
        };
        remoteMilestone.node_chunk_info = { ...defInitPoint.node_chunk_info, ...remoteMilestone.node_chunk_info };
        remoteMilestone.accepted_nodes = Array.from(new Set([...remoteMilestone.accepted_nodes, this.nodeid]));
        Logger("Mark this device as 'resolved'.", LOG_LEVEL_NOTICE);
        if (!(await client.uploadJson(MILSTONE_DOCID, remoteMilestone))) {
            throw new Error("Could not upload remote milestone");
        }
    }

    async tryConnectRemote(setting: RemoteDBSettings, showResult: boolean = true): Promise<boolean> {
        const endpoint = setting.endpoint;
        const testClient = new MinioStorageAdapter(setting, this.env);
        try {
            await testClient.listFiles("", 1);
            Logger(`Connected to ${endpoint} successfully!`, LOG_LEVEL_NOTICE);
            return true;
        } catch (ex) {
            Logger(`Error! Could not connected to ${endpoint}\n${(ex as Error).message}`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
            return false;
        } finally {
            testClient.dispose();
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
        // Preferred-tweak writes are finite trial-settings operations. Do not
        // borrow or reconfigure the active Journal client.
        const trialClient = new JournalSyncCore(
            setting,
            this.simpleStore,
            this.env,
            new MinioStorageAdapter(setting, this.env)
        );
        try {
            const remoteMilestone = await trialClient.downloadJson<EntryMilestoneInfo>(MILSTONE_DOCID);
            if (!remoteMilestone) {
                throw new Error("Missing remote milestone");
            }
            remoteMilestone.tweak_values[DEVICE_ID_PREFERRED] = extractObject(TweakValuesTemplate, {
                ...setting,
            }) satisfies TweakValues;
            Logger(`Preferred tweak values have been registered`, LOG_LEVEL_VERBOSE);
            if (!(await trialClient.uploadJson(MILSTONE_DOCID, remoteMilestone))) {
                throw new Error("Could not upload remote milestone");
            }
        } catch (ex) {
            Logger(`Could not update remote preferred tweak values`, LOG_LEVEL_NOTICE);
            throw ex;
        } finally {
            trialClient.dispose();
        }
    }

    async getRemotePreferredTweakValues(setting: RemoteDBSettings): Promise<RemotePreferredTweakResult> {
        // Preferred-tweak inspection is a finite trial-settings operation. Do
        // not borrow or reconfigure the active Journal client.
        const trialClient = new JournalSyncCore(
            setting,
            this.simpleStore,
            this.env,
            new MinioStorageAdapter(setting, this.env)
        );
        try {
            const result = await trialClient.downloadJsonWithResult<EntryMilestoneInfo>(MILSTONE_DOCID);
            if (result.status === JournalStorageReadStatuses.NOT_FOUND) {
                return {
                    status: RemotePreferredTweakStatuses.NOT_CONFIGURED,
                    reason: RemotePreferredTweakNotConfiguredReasons.MILESTONE_MISSING,
                };
            }
            if (result.status === JournalStorageReadStatuses.UNAVAILABLE) {
                return {
                    status: RemotePreferredTweakStatuses.UNAVAILABLE,
                    error: result.error,
                };
            }
            const preferred = result.value.tweak_values?.[DEVICE_ID_PREFERRED];
            if (!preferred) {
                return {
                    status: RemotePreferredTweakStatuses.NOT_CONFIGURED,
                    reason: RemotePreferredTweakNotConfiguredReasons.PREFERRED_VALUES_MISSING,
                };
            }
            return {
                status: RemotePreferredTweakStatuses.AVAILABLE,
                values: preferred,
            };
        } finally {
            trialClient.dispose();
        }
    }

    async getRemoteStatus(setting: RemoteDBSettings): Promise<false | RemoteDBStatus> {
        const testClient = new MinioStorageAdapter(setting, this.env);
        try {
            return await testClient.getUsage();
        } finally {
            testClient.dispose();
        }
    }

    getConnectedDeviceList(
        setting?: RemoteDBSettings
    ): Promise<false | { node_info: Record<string, NodeData>; accepted_nodes: string[] }> {
        return Promise.resolve(false);
    }
}
