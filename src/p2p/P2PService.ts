import type { ObsidianLiveSyncSettings, RemoteDBSettings } from "@lib/common/types";
import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance.ts";
import type { DiagRTCPeerConnectionMetrics } from "@lib/rpc/transports/DiagRTCPeerConnections.types";
import { getPeerConnectionStats } from "@lib/rpc/transports/DiagRTCPeerConnections.utils";
import {
    LiveSyncTrysteroReplicator,
    type LiveSyncTrysteroReplicatorEnv,
} from "@lib/replication/trystero/LiveSyncTrysteroReplicator";
import type { P2PReplicationResult } from "@lib/replication/trystero/TrysteroReplicator";
import type {
    AcceptanceDecision,
    RevokeAcceptanceDecision,
} from "@lib/replication/trystero/TrysteroReplicatorP2PServer";
import type { Advertisement } from "@lib/replication/trystero/types";
import type { P2PRoomSession } from "@lib/replication/trystero/P2PRoomSession";
import { P2PRoomSessionOwner, type P2PRoomSessionAccess } from "@lib/replication/trystero/P2PRoomSessionOwner";
import { compatGlobal, type CompatTimeoutHandle } from "@lib/common/coreEnvFunctions";
import {
    REPLICATION_CANCELLED,
    REPLICATION_COMPLETED,
    replicationBlocked,
    replicationFailed,
    type ReplicationOutcome,
} from "@lib/replication/ReplicatorProvider";

/** Candidate details projected from browser RTC statistics. */
export interface P2PCandidateSummary {
    readonly id: string;
    readonly candidateType: string;
    readonly protocol: string;
    readonly relayProtocol: string;
}

/**
 * Current peer-connection metrics without a raw RTC report or peer handle.
 *
 * Missing numeric values use the existing `unknown` sentinel so maintained
 * diagnostic output can distinguish absence from zero.
 */
export interface P2PPeerConnectionMetrics {
    readonly selectedPairPresent: boolean;
    readonly selectedPairId: string;
    readonly state: string;
    readonly currentRoundTripTime: number | "unknown";
    readonly totalRoundTripTime: number | "unknown";
    readonly requestsSent: number | "unknown";
    readonly responsesReceived: number | "unknown";
    readonly packetsDiscardedOnSend: number | "unknown";
    readonly bytesSent: number | "unknown";
    readonly bytesReceived: number | "unknown";
    readonly localCandidate?: P2PCandidateSummary;
    readonly remoteCandidate?: P2PCandidateSummary;
}

function getReportValue(report: Record<string, unknown> | undefined, key: string): string {
    const value = report?.[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : "unknown";
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function projectCandidate(reports: readonly unknown[], candidateId: string): P2PCandidateSummary | undefined {
    if (candidateId === "unknown") return undefined;
    const report = reports.filter(isUnknownRecord).find((value) => value.id === candidateId);
    if (!report) return undefined;
    return {
        id: candidateId,
        candidateType: getReportValue(report, "candidateType"),
        protocol: getReportValue(report, "protocol"),
        relayProtocol: getReportValue(report, "relayProtocol"),
    };
}

/** Project low-level RTC statistics into the focused P2P diagnostic contract. */
export function projectP2PPeerConnectionMetrics(metrics: DiagRTCPeerConnectionMetrics): P2PPeerConnectionMetrics {
    return {
        selectedPairPresent: metrics.selectedPair !== undefined,
        selectedPairId: metrics.selectedPairId,
        state: metrics.state,
        currentRoundTripTime: metrics.currentRoundTripTime,
        totalRoundTripTime: metrics.totalRoundTripTime,
        requestsSent: metrics.requestsSent,
        responsesReceived: metrics.responsesReceived,
        packetsDiscardedOnSend: metrics.packetsDiscardedOnSend,
        bytesSent: metrics.bytesSent,
        bytesReceived: metrics.bytesReceived,
        localCandidate: projectCandidate(metrics.reports, metrics.localCandidateId),
        remoteCandidate: projectCandidate(metrics.reports, metrics.remoteCandidateId),
    };
}

/** Observes and explicitly controls the room transport owned by the P2P service. */
export interface P2PTransportLifecycle {
    readonly isConnected: boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
}

/** Supplies a current peer snapshot without exposing the underlying room. */
export interface P2PPeerDirectory {
    getPeers(): readonly Advertisement[];
}

/** Administers temporary and persisted peer acceptance decisions. */
export interface P2PPeerAdmission {
    makeDecision(decision: AcceptanceDecision): Promise<void>;
    revokeDecision(decision: RevokeAcceptanceDecision): Promise<void>;
}

/** Performs finite transfer operations against an explicitly selected peer. */
export interface P2PTargetedTransfer {
    pullFromPeer(
        peerId: string,
        options?: { readonly showNotice?: boolean; readonly skipOrdinaryReplicationPolicy?: boolean }
    ): Promise<P2PReplicationResult>;
    requestPushToPeer(peerId: string): Promise<P2PReplicationResult>;
    synchroniseWithPeer(peerId: string, showNotice?: boolean): Promise<P2PReplicationResult>;
    /** Synchronise the persisted target set without interactive peer selection. */
    synchroniseConfiguredTargets(): Promise<ReplicationOutcome>;
}

/** Controls watch and broadcast behaviour attached to the current room session. */
export interface P2PChangeRelay {
    watchPeer(peerId: string): void;
    unwatchPeer(peerId: string): void;
    enableBroadcastChanges(): void;
    disableBroadcastChanges(): void;
}

/** Exchanges configuration with one explicitly selected peer. */
export interface P2PConfigurationExchange {
    getRemoteConfiguration(peerId: string): Promise<ObsidianLiveSyncSettings | false>;
}

/** Supplies transport diagnostics without exposing a room or peer connection. */
export interface P2PDiagnostics {
    requestStatus(): void;
    getPeerConnectionMetrics(peerId: string): Promise<P2PPeerConnectionMetrics | undefined>;
}

/** Seven narrow contract views backed by one private P2P service context. */
export interface P2PServiceViews {
    readonly transportLifecycle: P2PTransportLifecycle;
    readonly peerDirectory: P2PPeerDirectory;
    readonly peerAdmission: P2PPeerAdmission;
    readonly targetedTransfer: P2PTargetedTransfer;
    readonly changeRelay: P2PChangeRelay;
    readonly configurationExchange: P2PConfigurationExchange;
    readonly diagnostics: P2PDiagnostics;
}

/**
 * Host-only lifecycle operations which are deliberately absent from ordinary
 * P2P capability views.
 */
export interface P2PServiceLifecycle {
    requestStatus(): void;
    openAfterDatabaseRebuild(): Promise<void>;
    closeForLifecycle(): Promise<void>;
    /** Reconcile the automatic room demand; the room owner also reapplies current room-local policy. */
    reconcileAutoStart(settings: Pick<ObsidianLiveSyncSettings, "P2P_Enabled" | "P2P_AutoStart">): Promise<void>;
    scheduleAutoStart(delayMs?: number): void;
}

/** Host composition result. Ordinary consumers receive only `views`. */
export interface P2PServiceComposition {
    /** Deprecated compatibility surface for consumers which still require it. */
    readonly compatibilityReplicator: LiveSyncTrysteroReplicator;
    /** Stable capability projections over the private service context. */
    readonly views: P2PServiceViews;
    /** Host lifecycle operations which are not ordinary P2P capabilities. */
    readonly lifecycle: P2PServiceLifecycle;
    /** Create a non-owning adapter for the active Replicator selection. */
    createActiveReplicator(): ReplicatorInstance;
}

interface P2PServiceState {
    explicitDisconnectVeto: boolean;
    lifecycleGeneration: number;
    delayedAutoStart: CompatTimeoutHandle | undefined;
}

/** Private state and resource references shared by every stable view. */
interface P2PServiceContext {
    readonly env: LiveSyncTrysteroReplicatorEnv;
    readonly roomSessionOwner: P2PRoomSessionOwner;
    readonly compatibilityReplicator: LiveSyncTrysteroReplicator;
    readonly state: P2PServiceState;
}

function connect(owner: P2PRoomSessionOwner, state: P2PServiceState): Promise<void> {
    state.explicitDisconnectVeto = false;
    return owner.setPersistentDemand("explicit", true);
}

function clearDelayedAutoStart(state: P2PServiceState): void {
    if (state.delayedAutoStart !== undefined) {
        compatGlobal.clearTimeout(state.delayedAutoStart);
        state.delayedAutoStart = undefined;
    }
}

function cancelDelayedAutomation(owner: P2PRoomSessionOwner, state: P2PServiceState): void {
    state.lifecycleGeneration += 1;
    owner.beginAutomationLifecycle();
    clearDelayedAutoStart(state);
}

function disconnect(owner: P2PRoomSessionOwner, state: P2PServiceState): Promise<void> {
    state.explicitDisconnectVeto = true;
    cancelDelayedAutomation(owner, state);
    return owner.close();
}

function openAfterDatabaseRebuild(owner: P2PRoomSessionOwner): Promise<void> {
    return owner.setPersistentDemand("rebuild-continuation", true);
}

function closeForLifecycle(owner: P2PRoomSessionOwner, state: P2PServiceState): Promise<void> {
    cancelDelayedAutomation(owner, state);
    return owner.close();
}

function reconcileAutoStart(
    context: P2PServiceContext,
    settings: Pick<ObsidianLiveSyncSettings, "P2P_Enabled" | "P2P_AutoStart">
): Promise<void> {
    if (!settings.P2P_Enabled || !settings.P2P_AutoStart) {
        return context.roomSessionOwner.setPersistentDemand("automatic", false);
    }
    if (context.state.explicitDisconnectVeto) return Promise.resolve();
    return context.roomSessionOwner.setPersistentDemand("automatic", true);
}

function scheduleAutoStart(context: P2PServiceContext, delayMs: number = 100): void {
    clearDelayedAutoStart(context.state);
    const generation = context.state.lifecycleGeneration;
    context.state.delayedAutoStart = compatGlobal.setTimeout(() => {
        context.state.delayedAutoStart = undefined;
        if (generation !== context.state.lifecycleGeneration) return;
        void reconcileAutoStart(context, context.env.services.setting.currentSettings());
    }, delayMs);
}

function runWithFiniteRoomDemand<T>(
    context: P2PServiceContext,
    task: (session: P2PRoomSession) => T | PromiseLike<T>
): Promise<T> {
    if (context.state.explicitDisconnectVeto) {
        return Promise.reject(new Error("The P2P room was explicitly disconnected."));
    }
    return context.roomSessionOwner.runWithFiniteDemand(task);
}

async function synchroniseConfiguredTargets(context: P2PServiceContext): Promise<ReplicationOutcome> {
    if (context.state.explicitDisconnectVeto) return replicationBlocked("not-ready");
    try {
        const result = await context.roomSessionOwner.runWithFiniteDemand((session) =>
            session.runFiniteOperation((signal) => session.replicator.replicateFromCommand(false, undefined, signal))
        );
        if (result.status === "completed") return REPLICATION_COMPLETED;
        if (result.status === "cancelled") return REPLICATION_CANCELLED;
        if (result.status === "blocked") return replicationBlocked("provider-not-configured");
        return {
            status: "partial",
            detail: { kind: "p2p-configured-targets", targets: result.targets },
        };
    } catch (error) {
        return replicationFailed(error);
    }
}

function pullFromPeer(
    context: P2PServiceContext,
    peerId: string,
    options: { readonly showNotice?: boolean; readonly skipOrdinaryReplicationPolicy?: boolean } = {}
): Promise<P2PReplicationResult> {
    return runWithFiniteRoomDemand(context, (session) =>
        context.env.services.replicator.runFiniteReplicationActivity(
            () =>
                session.replicator.replicateFrom(
                    peerId,
                    options.showNotice ?? false,
                    false,
                    options.skipOrdinaryReplicationPolicy ?? false
                ),
            { label: "replication" }
        )
    );
}

function requestPushToPeer(context: P2PServiceContext, peerId: string): Promise<P2PReplicationResult> {
    return runWithFiniteRoomDemand(context, (session) =>
        context.env.services.replicator.runBoundedRemoteActivity(
            () => session.replicator.requestSynchroniseToPeer(peerId),
            { label: "replication" }
        )
    );
}

function synchroniseWithPeer(
    context: P2PServiceContext,
    peerId: string,
    showNotice: boolean = false
): Promise<P2PReplicationResult> {
    return runWithFiniteRoomDemand(context, (session) =>
        context.env.services.replicator.runFiniteReplicationActivity(
            () => session.replicator.sync(peerId, showNotice),
            { label: "replication" }
        )
    );
}

async function getPeerConnectionMetrics(
    context: P2PServiceContext,
    peerId: string
): Promise<P2PPeerConnectionMetrics | undefined> {
    const peerConnection = context.compatibilityReplicator.rawHost?.room?.getPeers()[peerId];
    if (!peerConnection) return undefined;
    const metrics = await getPeerConnectionStats(`p2p-service-${peerId}`, peerConnection);
    return metrics ? projectP2PPeerConnectionMetrics(metrics) : undefined;
}

function createCompatibilitySessionAccess(owner: P2PRoomSessionOwner, state: P2PServiceState): P2PRoomSessionAccess {
    return {
        get currentSession() {
            return owner.currentSession;
        },
        get isConnected() {
            return owner.isConnected;
        },
        cancelActiveTransfers: () => owner.cancelActiveTransfers(),
        open: () => connect(owner, state),
        close: () => disconnect(owner, state),
    };
}

function createServiceViews(context: P2PServiceContext): P2PServiceViews {
    const transportLifecycle: P2PTransportLifecycle = {
        get isConnected() {
            return context.roomSessionOwner.isConnected;
        },
        connect: () => connect(context.roomSessionOwner, context.state),
        disconnect: () => disconnect(context.roomSessionOwner, context.state),
    };
    const peerDirectory: P2PPeerDirectory = {
        getPeers: () => context.compatibilityReplicator.knownAdvertisements,
    };
    const peerAdmission: P2PPeerAdmission = {
        makeDecision: (decision) => context.compatibilityReplicator.makeDecision(decision),
        revokeDecision: (decision) => context.compatibilityReplicator.revokeDecision(decision),
    };
    const targetedTransfer: P2PTargetedTransfer = {
        pullFromPeer: (peerId, options) => pullFromPeer(context, peerId, options),
        requestPushToPeer: (peerId) => requestPushToPeer(context, peerId),
        synchroniseWithPeer: (peerId, showNotice) => synchroniseWithPeer(context, peerId, showNotice),
        synchroniseConfiguredTargets: () => synchroniseConfiguredTargets(context),
    };
    const changeRelay: P2PChangeRelay = {
        watchPeer: (peerId) => context.compatibilityReplicator.watchPeer(peerId),
        unwatchPeer: (peerId) => context.compatibilityReplicator.unwatchPeer(peerId),
        enableBroadcastChanges: () => context.compatibilityReplicator.enableBroadcastChanges(),
        disableBroadcastChanges: () => context.compatibilityReplicator.disableBroadcastChanges(),
    };
    const configurationExchange: P2PConfigurationExchange = {
        getRemoteConfiguration: (peerId) => context.compatibilityReplicator.getRemoteConfig(peerId),
    };
    const diagnostics: P2PDiagnostics = {
        requestStatus: () => context.compatibilityReplicator.requestStatus(),
        getPeerConnectionMetrics: (peerId) => getPeerConnectionMetrics(context, peerId),
    };
    return {
        transportLifecycle,
        peerDirectory,
        peerAdmission,
        targetedTransfer,
        changeRelay,
        configurationExchange,
        diagnostics,
    };
}

function createServiceLifecycle(context: P2PServiceContext): P2PServiceLifecycle {
    return {
        requestStatus: () => context.compatibilityReplicator.requestStatus(),
        openAfterDatabaseRebuild: () => openAfterDatabaseRebuild(context.roomSessionOwner),
        closeForLifecycle: () => closeForLifecycle(context.roomSessionOwner, context.state),
        reconcileAutoStart: (settings) => reconcileAutoStart(context, settings),
        scheduleAutoStart: (delayMs) => scheduleAutoStart(context, delayMs),
    };
}

/**
 * Compose stable capability views over one private P2P service context.
 *
 * `P2PRoomSessionOwner` remains the resource owner. The returned composition
 * object is host wiring, not a capability façade for ordinary consumers.
 */
export function createP2PService(env: LiveSyncTrysteroReplicatorEnv): P2PServiceComposition {
    const roomSessionOwner = new P2PRoomSessionOwner(env);
    const state: P2PServiceState = {
        explicitDisconnectVeto: false,
        lifecycleGeneration: 0,
        delayedAutoStart: undefined,
    };
    const compatibilityReplicator = new LiveSyncTrysteroReplicator(
        env,
        createCompatibilitySessionAccess(roomSessionOwner, state)
    );
    const context: P2PServiceContext = { env, roomSessionOwner, compatibilityReplicator, state };
    return {
        compatibilityReplicator,
        views: createServiceViews(context),
        lifecycle: createServiceLifecycle(context),
        createActiveReplicator: () => new P2PActiveReplicatorAdapter(compatibilityReplicator),
    };
}

/** Narrow, non-owning active-provider adapter over the stable P2P service owner. */
class P2PActiveReplicatorAdapter implements ReplicatorInstance {
    constructor(private readonly delegate: LiveSyncTrysteroReplicator) {}

    initializeDatabaseForReplication(): Promise<boolean> {
        return this.delegate.initializeDatabaseForReplication();
    }

    terminateSync(): void {
        this.delegate.terminateSync();
    }

    openReplication(
        setting: RemoteDBSettings,
        keepAlive: boolean,
        showResult: boolean,
        ignoreCleanLock: boolean
    ): Promise<void | boolean> {
        return this.delegate.openReplication(setting, keepAlive, showResult, ignoreCleanLock);
    }

    replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean> {
        return this.delegate.replicateAllFromServer(setting, showingNotice);
    }

    closeReplication(): void {
        // The active-provider adapter does not own the service room. Releasing
        // this adapter therefore cannot close the room, relay sockets, or the
        // service's finite-operation registry.
    }

}
