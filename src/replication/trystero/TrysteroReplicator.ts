import { createConfigurationExchange } from "./TrysteroReplicator/configurationExchange";
import { createPeerAgreement, type PeerAgreement, type PeerTweakSettings } from "./TrysteroReplicator/peerAgreement";
import { createChangeRelay, type ChangeRelay } from "./TrysteroReplicator/changeRelay";
import { reportP2PDiagnostic, type P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import { pullResultDiagnostic, pullFailureDiagnostic } from "./p2pReplicationDiagnostics";
import {
    projectDirectionProgress,
    projectAcknowledgedAttempt,
    type ProgressAcknowledgement,
    type AcknowledgedProgressAttempt,
} from "./p2pReplicationProgress";
import { parsePeerPatterns } from "./peerPatterns";
import type PouchDB from "pouchdb-core";
import { type EntryDoc, type ObsidianLiveSyncSettings } from "@lib/common/types";
import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    Logger,
    type LOG_LEVEL,
} from "octagonal-wheels/common/logger";
import { replicateShim, type ProgressInfo, type ReplicationStatistics } from "@lib/pouchdb/ReplicatorShim";
import type { Confirm } from "@lib/interfaces/Confirm";
import { resolveCurrentP2PSettings, type Advertisement, type ReplicatorHostEnv } from "./types";
import { scheduleOnceIfDuplicated, skipIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import { delay } from "octagonal-wheels/promises";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REPLICATOR_STATUS,
    P2PHost,
    type P2PPeerAcceptance,
} from "./TrysteroReplicatorP2PServer";
import { getRelaySockets, pauseRelayReconnection, resumeRelayReconnection } from "@trystero-p2p/nostr";
import type { P2PFiniteOperationOwner } from "./P2PRoomSession";
import { P2PAutomationCoordinator } from "./P2PAutomationCoordinator";
import { compatGlobal, type CompatTimeoutHandle } from "@lib/common/coreEnvFunctions";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import { readLocalP2PPathIdentity, readRemoteP2PPathIdentity } from "./TrysteroReplicator.pathIdentity.ts";
import { assertDatabasePathIdentity } from "@lib/pouchdb/pathIdentityCompatibility.ts";
import {
    fromP2PReplicationWireResult,
    toP2PReplicationWireResult,
    toP2PWireError,
    type P2PReplicationWireResult,
} from "./P2PReplicationWire";

export type P2PReplicatorStatus = {
    isBroadcasting: boolean;
    replicatingTo: string[];
    replicatingFrom: string[];
    watchingPeers: string[];
};
/** Sequence progress retained for compatibility, with independently observed work counts. */
export type P2PReplicationDirectionProgress = {
    max: number;
    current: number;
    isActive: boolean;
    statistics?: ReplicationStatistics;
};

export type P2PReplicationProgress = {
    peerId: string;
    peerName: string;
    fetching: P2PReplicationDirectionProgress;
    sending: P2PReplicationDirectionProgress;
};
export type P2PReplicationReport = {
    peerId: string;
    peerName: string;
} & ({ fetching: P2PReplicationDirectionProgress } | { sending: P2PReplicationDirectionProgress });

// Trystero's default peer ID lives for this module realm. Keep attempts ordered
// across room replacement, without adding persistent state or a clock dependency.
let nextProgressAttempt = 0;

/**
 * In-process outcome of one P2P replication request.
 *
 * The failed variant deliberately retains an `Error`-compatible value for
 * local callers. RPC handlers must convert it to `P2PReplicationWireResult`,
 * because native `Error` properties do not survive JSON serialisation.
 */
export type P2PReplicationResult =
    | { readonly status: "completed"; readonly ok: true; readonly error?: never }
    | { readonly status: "cancelled"; readonly ok?: false; readonly error?: never }
    | { readonly status: "failed"; readonly ok?: false; readonly error: unknown };

export type P2PConfiguredTargetResult = {
    readonly name: string;
    readonly peerId?: string;
} & (
    | { readonly status: "completed" }
    | { readonly status: "cancelled" }
    | { readonly status: "missing" }
    | { readonly status: "rejected" }
    | { readonly status: "undecided" }
    | { readonly status: "failed"; readonly error: unknown }
);

/** Explicit result of configured, unattended P2P target synchronisation. */
export type P2PConfiguredReplicationResult =
    | { readonly status: "completed"; readonly targets: readonly P2PConfiguredTargetResult[] }
    | { readonly status: "cancelled"; readonly targets: readonly P2PConfiguredTargetResult[] }
    | { readonly status: "blocked"; readonly reason: "no-targets"; readonly targets: readonly [] }
    | { readonly status: "partial"; readonly targets: readonly P2PConfiguredTargetResult[] };

const P2P_REPLICATION_COMPLETED = Object.freeze({ status: "completed", ok: true } as const);
const P2P_REPLICATION_CANCELLED = Object.freeze({ status: "cancelled" } as const);

function p2pReplicationFailed(error: unknown): P2PReplicationResult {
    return { status: "failed", error };
}

function isP2PReplicationCancelled(result: P2PReplicationResult): boolean {
    return result.status === "cancelled";
}

declare global {
    interface LSEvents {
        [EVENT_P2P_REPLICATOR_STATUS]: P2PReplicatorStatus;
        [EVENT_P2P_REPLICATOR_PROGRESS]: P2PReplicationReport;
    }
}

export type AllReplicationClientStatus = {
    [peerId: string]: {
        isReplicatingTo: boolean;
        isReplicatingFrom: boolean;
        isWatching: boolean;
        stats: P2PReplicationProgress;
    };
};

/**
 * Connect room-facing commands and replication policy to the existing host.
 *
 * Change relay, peer agreement, and configuration exchange provide narrower
 * operations. This facade retains public dispatch, session integration, and
 * transfer/progress coordination so those owners are not duplicated.
 */
export class TrysteroReplicator {
    _env: ReplicatorHostEnv;
    private readonly finiteOperationOwner?: P2PFiniteOperationOwner;
    private disposed = false;
    private readonly acknowledgedAttempts = new Map<string, AcknowledgedProgressAttempt>();
    private readonly fallbackAutomationCoordinator = new P2PAutomationCoordinator();

    server?: P2PHost;
    // Assembly keeps room identity in the host while agreement operations receive
    // only the connection, settings, and validation capabilities they use.
    private readonly peerAgreement: PeerAgreement = createPeerAgreement({
        host: () => {
            const server = this.server;
            if (!server) {
                return undefined;
            }
            return {
                peerPlatform: (peerId) => server.knownAdvertisements.find((peer) => peer.peerId == peerId)?.platform,
                connection: (peerId) => {
                    const connection = server.getConnection(peerId);
                    return {
                        requestAuthentication: (timeoutMs, signal) =>
                            connection.invokeRemoteObjectFunction<ReturnType<typeof this.getCommands>, "!reqAuth">(
                                "!reqAuth",
                                [server.serverPeerId],
                                timeoutMs,
                                signal
                            ),
                        requestTweakSettings: (challenge, timeoutMs, signal) =>
                            connection.invokeRemoteObjectFunction<
                                ReturnType<typeof this.getCommands>,
                                "getTweakSettings"
                            >("getTweakSettings", [challenge], timeoutMs, signal),
                    };
                },
            };
        },
        settings: () => this.settings,
        currentSettings: () => this.currentSettings,
        platform: () => this.platform,
        assertPathIdentity: async (settings) => {
            await assertDatabasePathIdentity(this.db, settings, true);
        },
        localTweakSettings: (challenge) => this.getTweakSettings(challenge),
        reportDiagnostic: (input) => this.reportDiagnostic(input),
    });
    private readonly configurationExchange: ReturnType<typeof createConfigurationExchange> =
        createConfigurationExchange({
            isSetup: () => this._onSetup,
            settings: () => this.settings,
            // Resolve the current host services at use time and retain Confirm's receiver.
            askString: (...args) => this.confirm.askString(...args),
            translate: (key) => this.translate(key),
            host: () => {
                const server = this.server;
                if (!server) {
                    return undefined;
                }
                return {
                    requestConfiguration: (peerId, timeoutMs) => {
                        const connection = server.getConnection(peerId);
                        return connection.invokeRemoteFunction("getAllConfig", [server.serverPeerId], timeoutMs);
                    },
                };
            },
        });
    private readonly changeRelay: ChangeRelay<P2PReplicationResult> = createChangeRelay<P2PReplicationResult>({
        createChangesFeed: (options) => this.db.changes(options),
        hasHost: () => Boolean(this.server),
        peerIds: () => this.server?.knownAdvertisements.map(({ peerId }) => peerId) ?? [],
        captureNotificationTarget: (peerId) => {
            const server = this.server;
            const room = server?.rpcRoom;
            if (!server || !room) {
                return undefined;
            }
            return {
                isAccepted: () => server.isAcceptablePeer(peerId),
                isCurrent: () => this.server === server && server.rpcRoom === room,
                send: () => server.getConnection(peerId).notifyRemoteFunction("onProgress", [server.serverPeerId]),
            };
        },
        isDisposed: () => this.disposed,
        announceChanges: () => this.notifyProgress(),
        pullPeer: (peerId) => this.runFiniteReplicationActivity(() => this.replicateFrom(peerId)),
        dispatchStatus: () => this.dispatchStatus(),
        reportDiagnostic: (input) => this.reportDiagnostic(input),
    });
    replicationStatus() {
        return {};
    }

    private reportDiagnostic(input: P2PDiagnosticInput): void {
        if (!this.disposed) {
            reportP2PDiagnostic(this._env.reportDiagnostic, input);
        }
    }

    /** Immutable room settings used for transport binding and shared configuration. */
    get settings() {
        return this._env.settings;
    }
    /** Latest room-local policy settings supplied by the owning host. */
    get currentSettings() {
        return resolveCurrentP2PSettings(this._env);
    }
    get db(): PouchDB.Database<EntryDoc> {
        return this._env.db;
    }
    get deviceName(): string {
        return this._env.deviceName;
    }
    get platform(): string {
        return this._env.platform;
    }
    get confirm(): Confirm {
        return this._env.confirm;
    }
    get translate() {
        return this._env.translate;
    }

    private get automationCoordinator(): P2PAutomationCoordinator {
        return this._env.automationCoordinator ?? this.fallbackAutomationCoordinator;
    }

    private async runFiniteReplicationActivity<T>(task: () => T | PromiseLike<T>): Promise<T> {
        if (this._env.runFiniteReplicationActivity) {
            return await this._env.runFiniteReplicationActivity(task, { label: "replication" });
        }
        return await task();
    }

    private async canStartOrdinaryReplication(showMessage: boolean = false): Promise<boolean> {
        return this._env.canStartOrdinaryReplication ? await this._env.canStartOrdinaryReplication(showMessage) : true;
    }

    constructor(env: ReplicatorHostEnv, server?: P2PHost, finiteOperationOwner?: P2PFiniteOperationOwner) {
        this._env = env;
        this.finiteOperationOwner = finiteOperationOwner;
        if (server) {
            this.server = server;
            return;
        }
        try {
            if (!this.settings.P2P_Enabled) {
                Logger("P2P is not enabled", LOG_LEVEL_VERBOSE);
                return;
            }
            if (!this.settings.P2P_AppID) {
                throw new Error("P2P App ID is not provided. We need it to establish the P2P connection");
            }
            if (!this.settings.P2P_roomID || !this.settings.P2P_passphrase) {
                throw new Error(
                    "Room ID and/or P2P Passphrase have not provided. We need them to establish the P2P connection"
                );
            }
            if (!this.settings.P2P_relays || this.settings.P2P_relays.length === 0) {
                throw new Error("No relay URIs provided. We need them to establish the P2P connection");
            }
            this.server = new P2PHost(env);
        } catch (e) {
            Logger(e instanceof Error ? e.message : "Error while creating TrysteroReplicator", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            throw e;
        }
    }

    /** Borrow the session owner's cancellation scope; legacy direct hosts use the caller signal. */
    private async runSessionFiniteOperation<T>(
        task: (signal?: AbortSignal) => T | PromiseLike<T>,
        callerSignal?: AbortSignal
    ): Promise<T> {
        if (this.finiteOperationOwner) {
            return await this.finiteOperationOwner.runFiniteOperation(task, callerSignal);
        }
        return await task(callerSignal);
    }

    async close() {
        this.requestStatus();
        await this.server?.shutdown();
        this.acknowledgedAttempts.clear();
        this._replicateFromPeers.clear();
        this._replicateToPeers.clear();
        this._watchingPeers.clear();
        this.requestStatus();
        this.disconnectFromServer();
    }

    /** Close the transport and release resources owned for this object's lifetime. */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        try {
            await this.close();
        } finally {
            this.server?.dispose();
        }
    }

    async open() {
        if (this.disposed) {
            throw new Error("The P2P Replicator has been disposed.");
        }
        this.allowReconnection();
        const commands = this.getCommands();
        await this.server?.start([commands], () =>
            this.server?.serveCancellationAwareFunction<[string], P2PReplicationWireResult>(
                "reqSync",
                async ({ signal }, _peerId, fromPeerId) =>
                    toP2PReplicationWireResult(await this.handleSynchronisationRequest(fromPeerId, signal))
            )
        );
        this.dispatchStatus();
        this.reconcileAutoBroadcast(this.currentSettings.P2P_AutoBroadcast);
    }
    async makeSureOpened() {
        if (!this.server?.isServing) {
            await this.open();
        }
    }
    get autoSyncPeers() {
        return parsePeerPatterns(this.currentSettings.P2P_AutoSyncPeers);
    }
    get autoWatchPeers() {
        return parsePeerPatterns(this.currentSettings.P2P_AutoWatchPeers);
    }
    async onNewPeer(peer: Advertisement) {
        const peerName = peer.name;
        const shouldAutoSync = this.autoSyncPeers.some((e) => e.test(peerName));
        const shouldAutoWatch = this.autoWatchPeers.some((e) => e.test(peerName));
        if (!shouldAutoSync && !shouldAutoWatch) {
            return;
        }

        const acceptance = await this.server?.evaluatePeerAcceptance(peer.peerId);
        if (acceptance !== "accepted") {
            if (shouldAutoWatch) {
                this.reportDiagnostic({
                    category: "sync",
                    code: "watch-skipped",
                    peerId: peer.peerId,
                    reason: "not-accepted",
                });
            }
            return;
        }

        if (shouldAutoSync) {
            await this.automationCoordinator.runBaseline(peerName, () =>
                this.runFiniteReplicationActivity(() => this.sync(peer.peerId))
            );
        }
        if (shouldAutoWatch) {
            await this.watchBroadcastingPeer(peer.peerId);
        }
    }

    private async watchBroadcastingPeer(peerId: string): Promise<void> {
        const broadcasting = await this.getRemoteIsBroadcasting(peerId);
        if (broadcasting === true) {
            this.watchPeer(peerId);
            return;
        }
        this.reportDiagnostic({
            category: "sync",
            code: "watch-skipped",
            peerId,
            reason: broadcasting === false ? "peer-not-broadcasting" : "peer-broadcast-unobserved",
        });
    }
    onPeerLeaved(peerId: string) {
        this.acknowledgedAttempts.delete(peerId);
        void this.unwatchPeer(peerId);
    }
    _onSetup = false;
    setOnSetup() {
        this._onSetup = true;
    }
    clearOnSetup() {
        this._onSetup = false;
    }

    /** Build challenge-bound compatibility data without exposing local ID keys. */
    async getTweakSettings(fromPeerId: string): Promise<PeerTweakSettings> {
        return await this.peerAgreement.getTweakSettings(fromPeerId);
    }

    private async handleSynchronisationRequest(
        fromPeerId: string,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        if (this._onSetup) {
            return p2pReplicationFailed(new Error("The setup is in progress"));
        }
        return await this.runFiniteReplicationActivity(() =>
            signal ? this.replicateFrom(fromPeerId, false, false, false, signal) : this.replicateFrom(fromPeerId)
        );
    }

    /**
     * Build the existing wire command object against this facade.
     * Public method dispatch stays dynamic for host overrides; RpcRoom owns
     * serialisation, request context, and call-versus-notification responses.
     */
    getCommands() {
        return {
            // The wire-visible command deliberately accepts only serialisable
            // arguments. RpcRoom supplies cancellation context separately.
            reqSync: async (fromPeerId: string): Promise<P2PReplicationWireResult> =>
                toP2PReplicationWireResult(await this.handleSynchronisationRequest(fromPeerId)),
            // Incoming admission remains with the host's peer-acceptance policy.
            "!reqAuth": async (fromPeerId: string) => {
                return await this.server?.isAcceptablePeer(fromPeerId);
            },
            getTweakSettings: async (fromPeerId: string) => {
                return await this.getTweakSettings(fromPeerId);
            },
            // Remote acquisition runs through the relay; notification send completion
            // at the caller does not wait for this handler's pull result.
            onProgress: async (fromPeerId: string) => {
                if (this._onSetup) {
                    this.reportDiagnostic({
                        category: "sync",
                        code: "change-notification-ignored",
                        peerId: fromPeerId,
                        reason: "setup-in-progress",
                    });
                    return { error: toP2PWireError(new Error("The setup is in progress")) };
                }
                await this.onUpdateDatabase(fromPeerId);
            },
            getAllConfig: async (fromPeerId: string) => {
                return await this.configurationExchange.shareConfiguration(fromPeerId);
            },
            onProgressAcknowledged: async (
                fromPeerId: string,
                info?: ProgressInfo | null,
                acknowledgement?: ProgressAcknowledgement
            ) => {
                try {
                    await Promise.resolve(this.onProgressAcknowledged(fromPeerId, info, acknowledgement));
                } catch (e) {
                    Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
                    Logger(e, LOG_LEVEL_VERBOSE);
                }
            },
            getIsBroadcasting: () => {
                return Promise.resolve(this._isBroadcasting);
            },
            requestBroadcasting: async (peerId: string) => {
                if (this._onSetup) {
                    return { error: toP2PWireError(new Error("The setup is in progress")) };
                }
                if (this._isBroadcasting) {
                    return true;
                }
                if (
                    (await skipIfDuplicated(
                        `requested-${peerId}`,
                        async () =>
                            await this.confirm.askYesNoDialog(
                                "The remote peer requested to broadcast the changes. Do you want to allow it?",
                                { defaultOption: "No" }
                            )
                    )) === "yes"
                ) {
                    this.enableBroadcastChanges();
                }
            },
        };
    }

    /** Retain the public admission entry point and its caller cancellation signal. */
    async requestAuthenticate(peerId: string, signal?: AbortSignal): Promise<boolean | undefined> {
        return await this.peerAgreement.requestAuthenticate(peerId, signal);
    }

    get lastSeq(): string | number {
        return this.changeRelay.lastSeq;
    }
    set lastSeq(sequence: string | number) {
        this.changeRelay.lastSeq = sequence;
    }
    async requestSynchroniseToPeer(peerId: string, callerSignal?: AbortSignal): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) => await this.requestSynchroniseToPeerWithinSession(peerId, signal),
            callerSignal
        );
    }

    private async requestSynchroniseToPeerWithinSession(
        peerId: string,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        if (!(await this.canStartOrdinaryReplication(false))) {
            return p2pReplicationFailed(new Error("Replication is not ready"));
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        await delay(25);
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        if (!this.server) throw new Error("Server is not available");
        // Logger(`P2P requesting remote sync from ${peerId}`, LOG_LEVEL_NOTICE, "p2p-replicator");
        const conn = this.server.getConnection(peerId);
        try {
            const result = await conn.invokeRemoteFunction<[string], P2PReplicationWireResult>(
                "reqSync",
                [this.server.serverPeerId],
                0,
                signal
            );
            // Logger(`P2P remote sync request returned from ${peerId}`, LOG_LEVEL_NOTICE, "p2p-replicator");
            return fromP2PReplicationWireResult(result);
        } catch (error) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            throw error;
        }
    }

    async requestSynchroniseToAllAvailablePeers() {
        await scheduleOnceIfDuplicated("requestSynchroniseToAllAvailablePeers", async () => {
            await delay(25);
            const replications = [...this.availableReplicationPairs].map((peerId) => {
                return this.requestSynchroniseToPeer(peerId);
            });
            await Promise.all(replications);
        });
    }

    dispatchStatus() {
        if (this.disposed) return;
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_STATUS, {
            isBroadcasting: this._isBroadcasting,
            replicatingTo: [...this._replicateToPeers],
            replicatingFrom: [...this._replicateFromPeers],
            watchingPeers: [...this._watchingPeers],
        });
    }
    requestStatus() {
        this.dispatchStatus();
        void this.server?.dispatchConnectionStatus();
    }

    get changes(): PouchDB.Core.Changes<EntryDoc> | undefined {
        return this.changeRelay.changes;
    }
    set changes(changes: PouchDB.Core.Changes<EntryDoc> | undefined) {
        this.changeRelay.changes = changes;
    }
    get _isBroadcasting(): boolean {
        return this.changeRelay.isBroadcasting;
    }
    set _isBroadcasting(enabled: boolean) {
        this.changeRelay.isBroadcasting = enabled;
    }
    disableBroadcastChanges() {
        this.changeRelay.disableBroadcastChanges();
    }
    enableBroadcastChanges() {
        this.changeRelay.enableBroadcastChanges();
    }

    /** Apply automatic broadcast policy without restarting this room. */
    reconcileAutoBroadcast(enabled: boolean): void {
        if (enabled === this._isBroadcasting) return;
        if (enabled) {
            this.enableBroadcastChanges();
        } else {
            this.disableBroadcastChanges();
        }
    }

    get knownAdvertisements() {
        return this.server?.knownAdvertisements ?? [];
    }
    availableReplicationPairs = new Set<string>();

    async sync(
        remotePeer: string,
        showNotice: boolean = false,
        callerSignal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) => await this.syncWithinSession(remotePeer, showNotice, signal),
            callerSignal
        );
    }

    private async syncWithinSession(
        remotePeer: string,
        showNotice: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        const from = await this.replicateFrom(remotePeer, showNotice, false, false, signal);
        if (isP2PReplicationCancelled(from)) return from;
        if (from.error) {
            Logger("Error while replicating from the remote", LOG_LEVEL_VERBOSE);
            Logger(from.error, LOG_LEVEL_VERBOSE);
            return from;
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        Logger(`P2P Replication has been requested to ${remotePeer}`, logLevel, "p2p-replicator");

        const res = await this.requestSynchroniseToPeer(remotePeer, signal);
        if (res.ok) {
            Logger("P2P Replication has been done", logLevel, "p2p-replicator");
        }
        if (res.error) {
            Logger("Error while syncing from the remote", logLevel, "p2p-replicator");
            Logger(res.error, LOG_LEVEL_VERBOSE);
        }
        // Logger(`P2P sync finished with ${remotePeer}`, LOG_LEVEL_NOTICE, "p2p-replicator");
        return res;
    }

    _replicateToPeers = new Set<string>();
    _replicateFromPeers = new Set<string>();

    dispatchReplicationProgress(peerId: string, info?: ProgressInfo) {
        this.onReplicationProgress(peerId, info);
    }
    onReplicationProgress(peerId: string, info?: ProgressInfo) {
        if (this.disposed) {
            return false;
        }
        const name = this.server?._knownAdvertisements?.get(peerId)?.name || peerId;
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId,
            peerName: name,
            fetching: projectDirectionProgress(info),
        });
        return true;
    }

    onProgressAcknowledged(peerId: string, info?: ProgressInfo | null, acknowledgement?: ProgressAcknowledgement) {
        if (this.disposed) {
            return false;
        }
        if (acknowledgement) {
            const next = projectAcknowledgedAttempt(this.acknowledgedAttempts.get(peerId), info, acknowledgement);
            if (!next) {
                return false;
            }
            this.acknowledgedAttempts.set(peerId, next);
        }
        const name = this.server?._knownAdvertisements?.get(peerId)?.name || peerId;
        const sending = projectDirectionProgress(info ?? acknowledgement?.finalProgress);
        sending.isActive = info != null;
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId,
            peerName: name,
            sending,
        });
        return true;
    }

    // Sending the progress to the remote peer.
    acknowledgeProgress(remotePeerId: string, info?: ProgressInfo, acknowledgement?: ProgressAcknowledgement) {
        if (!this.server || this.disposed) return;
        try {
            const connection = this.server.getConnection(remotePeerId);
            void connection
                .invokeRemoteFunction("onProgressAcknowledged", [this.server.serverPeerId, info, acknowledgement], 500)
                .catch((error) => {
                    Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
                    Logger(error, LOG_LEVEL_VERBOSE);
                });
        } catch (error) {
            Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
        }
    }
    async replicateFrom(
        remotePeer: string,
        showNotice: boolean = false,
        fromStart = false,
        skipOrdinaryReplicationPolicy = false,
        callerSignal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) =>
                await this.replicateFromWithinSession(
                    remotePeer,
                    showNotice,
                    fromStart,
                    skipOrdinaryReplicationPolicy,
                    signal
                ),
            callerSignal
        );
    }

    private async replicateFromWithinSession(
        remotePeer: string,
        showNotice: boolean,
        fromStart: boolean,
        skipOrdinaryReplicationPolicy: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        this.reportDiagnostic({ category: "sync", code: "pull-started", peerId: remotePeer });
        try {
            const result = await this.pullFromWithinSession(
                remotePeer,
                showNotice,
                fromStart,
                skipOrdinaryReplicationPolicy,
                signal
            );
            this.reportDiagnostic(pullResultDiagnostic(remotePeer, result.status));
            return result;
        } catch (error) {
            this.reportDiagnostic(pullFailureDiagnostic(remotePeer, signal?.aborted ?? false));
            throw error;
        }
    }

    private async pullFromWithinSession(
        remotePeer: string,
        showNotice: boolean,
        fromStart: boolean,
        skipOrdinaryReplicationPolicy: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        // Explicit Fetch/Rebuild flows have their own destructive-operation
        // confirmation and must remain available while ordinary replication is paused.
        if (!skipOrdinaryReplicationPolicy && !(await this.canStartOrdinaryReplication(showNotice))) {
            return p2pReplicationFailed(new Error("Replication is not ready"));
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        const rejection = await this.checkPeerForReplication(remotePeer, logLevel, signal);
        if (rejection) return rejection;

        Logger(`P2P Replicating from ${remotePeer}`, logLevel, "p2p-replicator");
        if (this._replicateFromPeers.has(remotePeer)) {
            Logger(`Replication from ${remotePeer} is already in progress`, logLevel, "p2p-replicator");
            return p2pReplicationFailed(new Error("Replication from this peer is already in progress"));
        }
        this._replicateFromPeers.add(remotePeer);
        this.dispatchStatus();
        const acknowledgement = { attempt: ++nextProgressAttempt };
        let latestProgress: ProgressInfo = {
            lastSeq: 0,
            maxSeqInBatch: 0,
            statistics: { documents: 0, checkedChanges: 0 },
        };
        this.dispatchReplicationProgress(remotePeer, latestProgress);
        this.acknowledgeProgress(remotePeer, latestProgress, acknowledgement);

        try {
            return await this.transferFromPeer(remotePeer, fromStart, logLevel, signal, (info) => {
                latestProgress = info;
                this.dispatchReplicationProgress(remotePeer, info);
                this.acknowledgeProgress(remotePeer, info, acknowledgement);
            });
        } catch (e) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Error while P2P replicating", logLevel, "p2p-replicator");
            Logger(e, LOG_LEVEL_VERBOSE);
            return p2pReplicationFailed(e);
        } finally {
            this.dispatchReplicationProgress(remotePeer);
            this.acknowledgeProgress(remotePeer, undefined, { ...acknowledgement, finalProgress: latestProgress });
            this._replicateFromPeers.delete(remotePeer);
            this.dispatchStatus();
        }
    }

    /**
     * Keep authentication and compatibility gates ahead of transfer state entry.
     * Facade dispatch preserves caller overrides; this layer alone translates
     * failed gates into the replication result and cancellation vocabulary.
     */
    private async checkPeerForReplication(
        remotePeer: string,
        logLevel: LOG_LEVEL,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult | undefined> {
        Logger(`P2P Requesting Authentication to ${remotePeer}`, logLevel, "p2p-replicator");
        const authenticated = signal
            ? await this.requestAuthenticate(remotePeer, signal)
            : await this.requestAuthenticate(remotePeer);
        if (authenticated !== true) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Peer rejected the connection", logLevel, "p2p-replicator");
            return p2pReplicationFailed(new Error("Peer rejected the connection"));
        }

        let tweaksMatched: boolean;
        try {
            tweaksMatched = signal
                ? await this.checkTweakValues(remotePeer, signal, logLevel)
                : await this.checkTweakValues(remotePeer, undefined, logLevel);
        } catch (error) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            throw error;
        }
        if (tweaksMatched !== true) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Tweak values are not matched", logLevel, "p2p-replicator");
            return p2pReplicationFailed(new Error("Tweak values are not matched"));
        }
        return undefined;
    }

    private async transferFromPeer(
        remotePeer: string,
        fromStart: boolean,
        logLevel: LOG_LEVEL,
        signal?: AbortSignal,
        onStatistics?: (info: ProgressInfo) => void
    ): Promise<P2PReplicationResult> {
        if (!this.server) {
            throw new Error("Server is not available");
        }
        const connection = this.server.getConnection(remotePeer);
        const remoteDB = connection.getRemoteDB(signal);
        const pathNormalizationVersion = getPathNormalizationVersion(this.currentSettings);
        const [localPathIdentity, remotePathIdentity] = await Promise.all([
            readLocalP2PPathIdentity(this.db, pathNormalizationVersion),
            readRemoteP2PPathIdentity(remoteDB, pathNormalizationVersion),
        ]);
        if (localPathIdentity !== pathNormalizationVersion || remotePathIdentity !== pathNormalizationVersion) {
            const error = new Error("P2P database path identity does not match the configured path identity.");
            Logger(error.message, logLevel, "p2p-replicator");
            return p2pReplicationFailed(error);
        }
        Logger(`P2P replicateFrom preparing remote DB info for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
        const remoteDBInfo = await remoteDB.info();
        Logger(
            `P2P replicateFrom remote DB info for ${remotePeer}: ${remoteDBInfo.db_name} seq=${remoteDBInfo.update_seq}`,
            LOG_LEVEL_VERBOSE,
            "p2p-replicator"
        );
        const localDBInfo = await this.db.info();
        Logger(
            `P2P replicateFrom local DB info for ${remotePeer}: ${localDBInfo.db_name} seq=${localDBInfo.update_seq}`,
            LOG_LEVEL_VERBOSE,
            "p2p-replicator"
        );
        Logger(`P2P replicateFrom entering replicateShim for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
        const outcome = await replicateShim(
            this.db,
            remoteDB,
            async (docs, info) => {
                await this._env.processReplicatedDocs(docs as Array<PouchDB.Core.ExistingDocument<EntryDoc>>);
                void this.notifyProgress(remotePeer);
                Logger(
                    `P2P Replication from ${remotePeer}\n${info.lastSeq} / ${info.maxSeqInBatch})`,
                    logLevel,
                    "p2p-replicator"
                );
            },
            {
                live: false,
                rewind: fromStart,
                signal,
                onStatistics,
            }
        );
        Logger(`P2P replicateFrom replicateShim returned for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
        if (outcome.status === "cancelled") {
            Logger(`P2P Replication from ${remotePeer} has been cancelled`, logLevel, "p2p-replicator");
            return P2P_REPLICATION_CANCELLED;
        }
        Logger(`P2P Replication from ${remotePeer} has been completed`, logLevel, "p2p-replicator");
        return P2P_REPLICATION_COMPLETED;
    }

    notifyProgress(excludePeerId?: string) {
        return this.changeRelay.notifyProgress(excludePeerId);
    }
    async requestBroadcastChanges(peerId: string) {
        return await this.server
            ?.getConnection(peerId)
            .invokeRemoteFunction("requestBroadcasting", [this.server.serverPeerId], 0);
    }
    async getRemoteIsBroadcasting(peerId: string) {
        try {
            return await this.server?.getConnection(peerId).invokeRemoteFunction("getIsBroadcasting", [], 0);
        } catch (e) {
            Logger("Error while getting remote is broadcasting", LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
        }
    }
    get _watchingPeers(): Set<string> {
        return this.changeRelay.watchingPeers;
    }
    set _watchingPeers(peers: Set<string>) {
        this.changeRelay.watchingPeers = peers;
    }
    watchPeer(peerId: string) {
        this.changeRelay.watchPeer(peerId);
    }
    unwatchPeer(peerId: string) {
        this.changeRelay.unwatchPeer(peerId);
    }
    async onUpdateDatabase(fromPeerId: string) {
        return await this.changeRelay.onUpdateDatabase(fromPeerId);
    }
    /** Fetch and validate shared settings; applying them remains the caller's responsibility. */
    async getRemoteConfig(peerId: string): Promise<ObsidianLiveSyncSettings | false> {
        return await this.configurationExchange.getRemoteConfig(peerId);
    }
    /** Compare peer settings without exceeding the initiating call's presentation authority. */
    async checkTweakValues(peerId: string, signal?: AbortSignal, logLevel: LOG_LEVEL = LOG_LEVEL_NOTICE) {
        return await this.peerAgreement.checkTweakValues(peerId, signal, logLevel);
    }

    private configuredPeerNames(): string[] {
        return [...new Set(this.currentSettings.P2P_SyncOnReplication.split(",").map((name) => name.trim()))].filter(
            Boolean
        );
    }

    private findAdvertisement(peerName: string): Advertisement | undefined {
        return this.knownAdvertisements.find((advertisement) => advertisement.name === peerName);
    }

    private async waitForConfiguredAdvertisements(
        peerNames: readonly string[],
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<void> {
        const allPresent = () => peerNames.every((name) => this.findAdvertisement(name) !== undefined);
        if (allPresent() || timeoutMs <= 0 || signal?.aborted) return;

        await new Promise<void>((resolve) => {
            let timeout: CompatTimeoutHandle | undefined;
            let detachAdvertisement = (): void => undefined;
            const finish = () => {
                detachAdvertisement();
                signal?.removeEventListener("abort", finish);
                if (timeout !== undefined) compatGlobal.clearTimeout(timeout);
                resolve();
            };
            detachAdvertisement = this._env.events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, () => {
                if (allPresent()) finish();
            });
            signal?.addEventListener("abort", finish, { once: true });
            timeout = compatGlobal.setTimeout(finish, timeoutMs);
            if (allPresent() || signal?.aborted) finish();
        });
    }

    private configuredTargetResult(
        name: string,
        peerId: string,
        result: P2PReplicationResult
    ): P2PConfiguredTargetResult {
        if (result.status === "completed") return { name, peerId, status: "completed" };
        if (result.status === "cancelled") return { name, peerId, status: "cancelled" };
        return { name, peerId, status: "failed", error: result.error };
    }

    /** Synchronise configured peer targets without opening peer-selection UI. */
    async replicateFromCommand(
        showResult: boolean = false,
        discoveryTimeoutMs: number = 5000,
        callerSignal?: AbortSignal
    ): Promise<P2PConfiguredReplicationResult> {
        const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        if (!this.currentSettings.P2P_Enabled) {
            Logger(this.translate("P2P.NotEnabled"), logLevel);
            return { status: "blocked", reason: "no-targets", targets: [] };
        }
        const peerNames = this.configuredPeerNames();
        if (peerNames.length === 0) {
            Logger(this.translate("P2P.NoAutoSyncPeers"), logLevel);
            return { status: "blocked", reason: "no-targets", targets: [] };
        }

        await this.waitForConfiguredAdvertisements(peerNames, discoveryTimeoutMs, callerSignal);
        const targets: P2PConfiguredTargetResult[] = [];
        for (const peerName of peerNames) {
            if (callerSignal?.aborted) {
                targets.push({ name: peerName, status: "cancelled" });
                continue;
            }
            const advertisement = this.findAdvertisement(peerName);
            if (!advertisement) {
                Logger(this.translate(`P2P.SeemsOffline`, { name: peerName }), logLevel);
                targets.push({ name: peerName, status: "missing" });
                continue;
            }

            const acceptance: P2PPeerAcceptance =
                (await this.server?.evaluatePeerAcceptance(advertisement.peerId)) ?? "unknown";
            if (acceptance !== "accepted") {
                targets.push({
                    name: peerName,
                    peerId: advertisement.peerId,
                    status:
                        acceptance === "rejected" ? "rejected" : acceptance === "undecided" ? "undecided" : "missing",
                });
                continue;
            }

            Logger(this.translate(`P2P.SyncStartedWith`, { name: peerName }), logLevel);
            const result = await this.automationCoordinator.runBaseline(peerName, () =>
                this.sync(advertisement.peerId, showResult, callerSignal)
            );
            targets.push(this.configuredTargetResult(peerName, advertisement.peerId, result));
        }

        if (targets.every((target) => target.status === "completed")) {
            Logger(this.translate("P2P.SyncCompleted"), logLevel);
            return { status: "completed", targets };
        }
        if (targets.every((target) => target.status === "cancelled")) {
            return { status: "cancelled", targets };
        }
        return { status: "partial", targets };
    }

    disconnectFromServer() {
        // Trystero does not provide typings for getRelaySockets.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const connections = getRelaySockets() as Record<string, { close: () => void }>;
        const sockets = Object.entries(connections);
        pauseRelayReconnection();
        sockets.forEach(([, s]) => {
            s.close();
        });
        void this.pauseServe();
    }
    async pauseServe() {
        await this.server?.close();
        await this.server?.dispatchConnectionStatus();
    }
    allowReconnection() {
        resumeRelayReconnection();
    }
}
