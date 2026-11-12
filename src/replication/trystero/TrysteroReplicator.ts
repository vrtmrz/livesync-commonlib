import { createReplicationProgress } from "./TrysteroReplicator/progress";
import { createTransfers, p2pReplicationFailed, type Transfers } from "./TrysteroReplicator/transfers";
import { createConfiguredTargets } from "./TrysteroReplicator/configuredTargets";
import type {
    P2PReplicationProgress,
    P2PReplicationReport,
    P2PReplicationResult,
    P2PConfiguredReplicationResult,
    ProgressAcknowledgement,
} from "./replicationTypes";
export type {
    P2PReplicationDirectionProgress,
    P2PReplicationProgress,
    P2PReplicationReport,
    P2PReplicationResult,
    P2PConfiguredTargetResult,
    P2PConfiguredReplicationResult,
} from "./replicationTypes";
import { createConfigurationExchange } from "./TrysteroReplicator/configurationExchange";
import { createPeerAgreement, type PeerAgreement, type PeerTweakSettings } from "./TrysteroReplicator/peerAgreement";
import { createChangeRelay, type ChangeRelay } from "./TrysteroReplicator/changeRelay";
import { reportP2PDiagnostic, type P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import { parsePeerPatterns } from "./peerPatterns";
import type PouchDB from "pouchdb-core";
import { type EntryDoc, type ObsidianLiveSyncSettings } from "@lib/common/types";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, Logger, type LOG_LEVEL } from "octagonal-wheels/common/logger";
import { replicateShim, type ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import type { Confirm } from "@lib/interfaces/Confirm";
import { resolveCurrentP2PSettings, type Advertisement, type ReplicatorHostEnv } from "./types";
import { skipIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REPLICATOR_STATUS,
    P2PHost,
} from "./TrysteroReplicatorP2PServer";
import { defaultRelayControl, disconnectRelay, type RelayControl } from "./TrysteroReplicator/relayControl";
import type { P2PFiniteOperationOwner } from "./P2PRoomSession";
import { P2PAutomationCoordinator } from "./P2PAutomationCoordinator";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { assertDatabasePathIdentity } from "@lib/pouchdb/pathIdentityCompatibility.ts";
import { toP2PReplicationWireResult, toP2PWireError, type P2PReplicationWireResult } from "./P2PReplicationWire";

export type P2PReplicatorStatus = {
    isBroadcasting: boolean;
    replicatingTo: string[];
    replicatingFrom: string[];
    watchingPeers: string[];
};
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

/** Optional transport controls preserve the existing finite-operation owner argument. */
export interface TrysteroReplicatorOptions {
    relayControl?: RelayControl;
}

/**
 * Connect room-facing commands and replication policy to the existing host.
 *
 * Change relay, agreement, configuration, progress, target selection, and transfers provide narrower
 * operations. This facade retains public dispatch, session integration, and
 * lifecycle coordination so those owners are not duplicated.
 */
export class TrysteroReplicator {
    _env: ReplicatorHostEnv;
    private readonly finiteOperationOwner?: P2PFiniteOperationOwner;
    private readonly relayControl: RelayControl;
    private disposed = false;
    private readonly fallbackAutomationCoordinator = new P2PAutomationCoordinator();

    server?: P2PHost;
    private readonly replicationProgress: ReturnType<typeof createReplicationProgress> = createReplicationProgress({
        isDisposed: () => this.disposed,
        peerName: (peerId) => this.server?._knownAdvertisements?.get(peerId)?.name,
        emitProgress: (report) => this._env.events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, report),
        captureAcknowledgementTarget: (peerId) => {
            const server = this.server;
            if (!server) {
                return undefined;
            }
            return {
                send: (info, acknowledgement) =>
                    server
                        .getConnection(peerId)
                        .invokeRemoteFunction(
                            "onProgressAcknowledged",
                            [server.serverPeerId, info, acknowledgement],
                            500
                        ),
            };
        },
    });
    private readonly transfers: Transfers = createTransfers({
        host: () => {
            const server = this.server;
            if (!server) {
                return undefined;
            }
            return {
                connection: (peerId) => {
                    const connection = server.getConnection(peerId);
                    return {
                        requestSynchronisation: (timeoutMs, signal) =>
                            connection.invokeRemoteFunction<[string], P2PReplicationWireResult>(
                                "reqSync",
                                [server.serverPeerId],
                                timeoutMs,
                                signal
                            ),
                        getRemoteDB: (signal) => connection.getRemoteDB(signal),
                    };
                },
            };
        },
        database: () => this.db,
        currentSettings: () => this.currentSettings,
        replicate: replicateShim,
        processReplicatedDocs: (docs) => this._env.processReplicatedDocs(docs),
        canStartOrdinaryReplication: (...args) => this.canStartOrdinaryReplication(...args),
        requestAuthenticate: (...args) => this.requestAuthenticate(...args),
        checkTweakValues: (...args) => this.checkTweakValues(...args),
        replicateFrom: (...args) => this.replicateFrom(...args),
        requestSynchroniseToPeer: (...args) => this.requestSynchroniseToPeer(...args),
        dispatchStatus: () => this.dispatchStatus(),
        dispatchReplicationProgress: (...args) => this.dispatchReplicationProgress(...args),
        acknowledgeProgress: (...args) => this.acknowledgeProgress(...args),
        beginProgressAttempt: () => this.replicationProgress.beginAttempt(),
        reportDiagnostic: (input) => this.reportDiagnostic(input),
        notifyProgress: (...args) => this.notifyProgress(...args),
    });
    private readonly configuredTargets: ReturnType<typeof createConfiguredTargets> = createConfiguredTargets({
        currentSettings: () => this.currentSettings,
        advertisements: () => this.knownAdvertisements,
        evaluatePeerAcceptance: (peerId) => this.server?.evaluatePeerAcceptance(peerId) ?? Promise.resolve(undefined),
        runBaseline: (...args) => this.automationCoordinator.runBaseline(...args),
        sync: (...args) => this.sync(...args),
        onAdvertisement: (listener) => this._env.events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, listener),
        scheduleTimeout: (callback, delayMs) => {
            const handle = compatGlobal.setTimeout(callback, delayMs);
            return () => compatGlobal.clearTimeout(handle);
        },
        translate: (...args) => this.translate(...args),
    });
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

    constructor(
        env: ReplicatorHostEnv,
        server?: P2PHost,
        finiteOperationOwner?: P2PFiniteOperationOwner,
        options: TrysteroReplicatorOptions = {}
    ) {
        this._env = env;
        this.finiteOperationOwner = finiteOperationOwner;
        this.relayControl = options.relayControl ?? defaultRelayControl;
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
        this.replicationProgress.clear();
        this.transfers.clearActivePeers();
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
        this.replicationProgress.peerLeft(peerId);
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
            async (signal) => await this.transfers.requestSynchroniseToPeer(peerId, signal),
            callerSignal
        );
    }

    async requestSynchroniseToAllAvailablePeers() {
        return await this.transfers.requestSynchroniseToAllAvailablePeers();
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
    get availableReplicationPairs(): Set<string> {
        return this.transfers.availableReplicationPairs;
    }
    set availableReplicationPairs(peers: Set<string>) {
        this.transfers.availableReplicationPairs = peers;
    }

    async sync(
        remotePeer: string,
        showNotice: boolean = false,
        callerSignal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) => await this.transfers.sync(remotePeer, showNotice, signal),
            callerSignal
        );
    }

    /** Existing public sets refer to the transfer component's single state owner. */
    get _replicateToPeers(): Set<string> {
        return this.transfers.replicateToPeers;
    }
    set _replicateToPeers(peers: Set<string>) {
        this.transfers.replicateToPeers = peers;
    }
    get _replicateFromPeers(): Set<string> {
        return this.transfers.replicateFromPeers;
    }
    set _replicateFromPeers(peers: Set<string>) {
        this.transfers.replicateFromPeers = peers;
    }

    dispatchReplicationProgress(peerId: string, info?: ProgressInfo) {
        this.onReplicationProgress(peerId, info);
    }
    onReplicationProgress(peerId: string, info?: ProgressInfo) {
        return this.replicationProgress.onReplicationProgress(peerId, info);
    }

    onProgressAcknowledged(peerId: string, info?: ProgressInfo | null, acknowledgement?: ProgressAcknowledgement) {
        return this.replicationProgress.onProgressAcknowledged(peerId, info, acknowledgement);
    }

    /** Report progress without awaiting the reporting RPC's response. */
    acknowledgeProgress(peerId: string, info?: ProgressInfo, acknowledgement?: ProgressAcknowledgement) {
        this.replicationProgress.acknowledgeProgress(peerId, info, acknowledgement);
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
                await this.transfers.replicateFrom(
                    remotePeer,
                    showNotice,
                    fromStart,
                    skipOrdinaryReplicationPolicy,
                    signal
                ),
            callerSignal
        );
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

    /** Synchronise configured targets through their own discovery and aggregation workflow. */
    async replicateFromCommand(
        showResult: boolean = false,
        discoveryTimeoutMs: number = 5000,
        callerSignal?: AbortSignal
    ): Promise<P2PConfiguredReplicationResult> {
        return await this.configuredTargets.replicateFromCommand(showResult, discoveryTimeoutMs, callerSignal);
    }

    /** Stop the current relay snapshot and retain the public asynchronous host-stop dispatch. */
    disconnectFromServer() {
        disconnectRelay({ relay: this.relayControl, pauseServe: () => this.pauseServe() });
    }
    async pauseServe() {
        await this.server?.close();
        await this.server?.dispatchConnectionStatus();
    }
    allowReconnection() {
        this.relayControl.resumeReconnection();
    }
}
