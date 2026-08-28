import type {
    EntryLeaf,
    NodeData,
    ObsidianLiveSyncSettings,
    RemoteDBSettings,
    RemotePreferredTweakResult,
} from "@lib/common/types";
import { LiveSyncAbstractReplicator, type RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator";
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

function projectCandidate(reports: readonly unknown[], candidateId: string): P2PCandidateSummary | undefined {
    if (candidateId === "unknown") return undefined;
    const report = reports.map((value) => value as Record<string, unknown>).find((value) => value.id === candidateId);
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

/** Seven narrow contract views backed by one stable P2P state owner. */
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
 * Stable P2P service owner composed by a host.
 *
 * Every view returns this same object. The compatibility Replicator remains a
 * temporary migration surface, while active Replicator adapters are separate,
 * non-owning handles over this service.
 */
export class LiveSyncP2PService
    implements
        P2PServiceViews,
        P2PTransportLifecycle,
        P2PPeerDirectory,
        P2PPeerAdmission,
        P2PTargetedTransfer,
        P2PChangeRelay,
        P2PConfigurationExchange,
        P2PDiagnostics
{
    readonly compatibilityReplicator: LiveSyncTrysteroReplicator;
    private readonly roomSessionOwner: P2PRoomSessionOwner;
    private explicitDisconnectVeto = false;
    private lifecycleGeneration = 0;
    private delayedAutoStart: CompatTimeoutHandle | undefined;

    constructor(private readonly env: LiveSyncTrysteroReplicatorEnv) {
        this.roomSessionOwner = new P2PRoomSessionOwner(env);
        this.compatibilityReplicator = new LiveSyncTrysteroReplicator(env, this.createCompatibilitySessionAccess());
    }

    /** Keep legacy open and close calls within the stable service's intent policy. */
    private createCompatibilitySessionAccess(): P2PRoomSessionAccess {
        const owner = this.roomSessionOwner;
        return {
            get currentSession() {
                return owner.currentSession;
            },
            get isConnected() {
                return owner.isConnected;
            },
            cancelActiveTransfers: () => owner.cancelActiveTransfers(),
            open: () => this.connect(),
            close: () => this.disconnect(),
        };
    }

    get transportLifecycle(): P2PTransportLifecycle {
        return this;
    }

    get peerDirectory(): P2PPeerDirectory {
        return this;
    }

    get peerAdmission(): P2PPeerAdmission {
        return this;
    }

    get targetedTransfer(): P2PTargetedTransfer {
        return this;
    }

    get changeRelay(): P2PChangeRelay {
        return this;
    }

    get configurationExchange(): P2PConfigurationExchange {
        return this;
    }

    get diagnostics(): P2PDiagnostics {
        return this;
    }

    get isConnected(): boolean {
        return this.roomSessionOwner.isConnected;
    }

    connect(): Promise<void> {
        this.explicitDisconnectVeto = false;
        return this.roomSessionOwner.setPersistentDemand("explicit", true);
    }

    disconnect(): Promise<void> {
        this.explicitDisconnectVeto = true;
        this.cancelDelayedAutomation();
        return this.roomSessionOwner.close();
    }

    /** Reopen after a rebuild which already owns that lifecycle continuation. */
    openAfterDatabaseRebuild(): Promise<void> {
        return this.roomSessionOwner.setPersistentDemand("rebuild-continuation", true);
    }

    /** Retire the current room without changing explicit user intent. */
    closeForLifecycle(): Promise<void> {
        this.cancelDelayedAutomation();
        return this.roomSessionOwner.close();
    }

    /** Apply the persisted AutoStart policy without overriding an explicit disconnect. */
    reconcileAutoStart(settings: Pick<ObsidianLiveSyncSettings, "P2P_Enabled" | "P2P_AutoStart">): Promise<void> {
        if (!settings.P2P_Enabled || !settings.P2P_AutoStart) {
            return this.roomSessionOwner.setPersistentDemand("automatic", false);
        }
        if (this.explicitDisconnectVeto) {
            return Promise.resolve();
        }
        return this.roomSessionOwner.setPersistentDemand("automatic", true);
    }

    /** Schedule AutoStart work within the current application lifecycle generation. */
    scheduleAutoStart(delayMs: number = 100): void {
        this.clearDelayedAutoStart();
        const generation = this.lifecycleGeneration;
        this.delayedAutoStart = compatGlobal.setTimeout(() => {
            this.delayedAutoStart = undefined;
            if (generation !== this.lifecycleGeneration) return;
            const settings = this.env.services.setting.currentSettings();
            void this.reconcileAutoStart(settings);
        }, delayMs);
    }

    /** Invalidate delayed automatic work scheduled by an earlier lifecycle. */
    cancelDelayedAutomation(): void {
        this.lifecycleGeneration += 1;
        this.roomSessionOwner.beginAutomationLifecycle();
        this.clearDelayedAutoStart();
    }

    private clearDelayedAutoStart(): void {
        if (this.delayedAutoStart !== undefined) {
            compatGlobal.clearTimeout(this.delayedAutoStart);
            this.delayedAutoStart = undefined;
        }
    }

    private runWithFiniteRoomDemand<T>(task: (session: P2PRoomSession) => T | PromiseLike<T>): Promise<T> {
        if (this.explicitDisconnectVeto) {
            return Promise.reject(new Error("The P2P room was explicitly disconnected."));
        }
        return this.roomSessionOwner.runWithFiniteDemand(task);
    }

    /** Run the configured unattended P2P target set without peer-selection UI. */
    async synchroniseConfiguredTargets(): Promise<ReplicationOutcome> {
        if (this.explicitDisconnectVeto) return replicationBlocked("not-ready");
        try {
            const result = await this.roomSessionOwner.runWithFiniteDemand((session) =>
                session.runFiniteOperation((signal) =>
                    session.replicator.replicateFromCommand(false, undefined, signal)
                )
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

    getPeers(): readonly Advertisement[] {
        return this.compatibilityReplicator.knownAdvertisements;
    }

    async makeDecision(decision: AcceptanceDecision): Promise<void> {
        await this.compatibilityReplicator.makeDecision(decision);
    }

    async revokeDecision(decision: RevokeAcceptanceDecision): Promise<void> {
        await this.compatibilityReplicator.revokeDecision(decision);
    }

    pullFromPeer(
        peerId: string,
        options: { readonly showNotice?: boolean; readonly skipOrdinaryReplicationPolicy?: boolean } = {}
    ): Promise<P2PReplicationResult> {
        return this.runWithFiniteRoomDemand((session) =>
            this.env.services.replicator.runFiniteReplicationActivity(
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

    requestPushToPeer(peerId: string): Promise<P2PReplicationResult> {
        return this.runWithFiniteRoomDemand((session) =>
            this.env.services.replicator.runBoundedRemoteActivity(
                () => session.replicator.requestSynchroniseToPeer(peerId),
                { label: "replication" }
            )
        );
    }

    synchroniseWithPeer(peerId: string, showNotice: boolean = false): Promise<P2PReplicationResult> {
        return this.runWithFiniteRoomDemand((session) =>
            this.env.services.replicator.runFiniteReplicationActivity(
                () => session.replicator.sync(peerId, showNotice),
                { label: "replication" }
            )
        );
    }

    watchPeer(peerId: string): void {
        this.compatibilityReplicator.watchPeer(peerId);
    }

    unwatchPeer(peerId: string): void {
        this.compatibilityReplicator.unwatchPeer(peerId);
    }

    enableBroadcastChanges(): void {
        this.compatibilityReplicator.enableBroadcastChanges();
    }

    disableBroadcastChanges(): void {
        this.compatibilityReplicator.disableBroadcastChanges();
    }

    getRemoteConfiguration(peerId: string): Promise<ObsidianLiveSyncSettings | false> {
        return this.compatibilityReplicator.getRemoteConfig(peerId);
    }

    requestStatus(): void {
        this.compatibilityReplicator.requestStatus();
    }

    async getPeerConnectionMetrics(peerId: string): Promise<P2PPeerConnectionMetrics | undefined> {
        const peerConnection = this.compatibilityReplicator.rawHost?.room?.getPeers()[peerId];
        if (!peerConnection) return undefined;
        const metrics = await getPeerConnectionStats(`p2p-service-${peerId}`, peerConnection);
        return metrics ? projectP2PPeerConnectionMetrics(metrics) : undefined;
    }

    /** Create a fresh active handle which cannot retire this service's room. */
    createActiveReplicator(): LiveSyncAbstractReplicator {
        return new P2PActiveReplicatorAdapter(this.env, this.compatibilityReplicator);
    }
}

/** Active-provider adapter over the stable P2P service compatibility surface. */
class P2PActiveReplicatorAdapter extends LiveSyncAbstractReplicator {
    constructor(
        env: LiveSyncTrysteroReplicatorEnv,
        private readonly delegate: LiveSyncTrysteroReplicator
    ) {
        super(env);
    }

    getReplicationPBKDF2Salt(setting: RemoteDBSettings, refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return this.delegate.getReplicationPBKDF2Salt(setting, refresh);
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

    tryConnectRemote(setting: RemoteDBSettings, showResult?: boolean): Promise<boolean> {
        return this.delegate.tryConnectRemote(setting, showResult);
    }

    replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean> {
        return this.delegate.replicateAllToServer(setting, showingNotice);
    }

    replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean> {
        return this.delegate.replicateAllFromServer(setting, showingNotice);
    }

    closeReplication(): void {
        // The active-provider adapter does not own the service room. Releasing
        // this adapter therefore cannot close the room, relay sockets, or the
        // service's finite-operation registry.
    }

    tryResetRemoteDatabase(setting: RemoteDBSettings): Promise<void> {
        return this.delegate.tryResetRemoteDatabase(setting);
    }

    tryCreateRemoteDatabase(setting: RemoteDBSettings): Promise<void> {
        return this.delegate.tryCreateRemoteDatabase(setting);
    }

    markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean): Promise<void> {
        return this.delegate.markRemoteLocked(setting, locked, lockByClean);
    }

    markRemoteResolved(setting: RemoteDBSettings): Promise<void> {
        return this.delegate.markRemoteResolved(setting);
    }

    resetRemoteTweakSettings(setting: RemoteDBSettings): Promise<void> {
        return this.delegate.resetRemoteTweakSettings(setting);
    }

    setPreferredRemoteTweakSettings(setting: RemoteDBSettings): Promise<void> {
        return this.delegate.setPreferredRemoteTweakSettings(setting);
    }

    fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]> {
        return this.delegate.fetchRemoteChunks(missingChunks, showResult);
    }

    getRemoteStatus(setting: RemoteDBSettings): Promise<false | RemoteDBStatus> {
        return this.delegate.getRemoteStatus(setting);
    }

    getRemotePreferredTweakValues(setting: RemoteDBSettings): Promise<RemotePreferredTweakResult> {
        return this.delegate.getRemotePreferredTweakValues(setting);
    }

    countCompromisedChunks(_setting?: RemoteDBSettings): Promise<number | boolean> {
        return this.delegate.countCompromisedChunks();
    }

    getConnectedDeviceList(
        setting?: RemoteDBSettings
    ): Promise<false | { node_info: Record<string, NodeData>; accepted_nodes: string[] }> {
        return this.delegate.getConnectedDeviceList(setting);
    }
}
