import type PouchDB from "pouchdb-core";
import type { EntryDoc, P2PSyncSetting } from "@lib/common/types";
import type { P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import type { replicateShim, ProgressInfo, PouchDBShim, SomeDocument } from "@lib/pouchdb/ReplicatorShim";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import { bindContext } from "octagonal-wheels/context";
import { scheduleOnceIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import { delay } from "octagonal-wheels/promises";
import {
    Logger,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
} from "octagonal-wheels/common/logger";
import { readLocalP2PPathIdentity, readRemoteP2PPathIdentity } from "../TrysteroReplicator.pathIdentity.ts";
import { fromP2PReplicationWireResult, type P2PReplicationWireResult } from "../P2PReplicationWire";
import { pullResultDiagnostic, pullFailureDiagnostic } from "../p2pReplicationDiagnostics";
import type { P2PReplicationResult, ProgressAcknowledgement } from "../replicationTypes";

export type { P2PReplicationResult } from "../replicationTypes";

export const P2P_REPLICATION_COMPLETED = Object.freeze({ status: "completed", ok: true } as const);
export const P2P_REPLICATION_CANCELLED = Object.freeze({ status: "cancelled" } as const);

export function p2pReplicationFailed(error: unknown): P2PReplicationResult {
    return { status: "failed", error };
}

export function isP2PReplicationCancelled(result: P2PReplicationResult): boolean {
    return result.status === "cancelled";
}

export interface TransferConnection {
    requestSynchronisation(timeoutMs: number, signal?: AbortSignal): Promise<P2PReplicationWireResult>;
    /** Reuse the RPC database contract rather than requiring a complete PouchDB implementation. */
    getRemoteDB(signal?: AbortSignal): PouchDBShim<SomeDocument<object>>;
}

export interface TransferHost {
    connection(peerId: string): TransferConnection;
}

/** Borrowed capabilities: session lifetime and public method dispatch remain with the facade. */
export interface TransferDependencies {
    host(): TransferHost | undefined;
    database(): PouchDB.Database<EntryDoc>;
    currentSettings(): P2PSyncSetting;
    replicate: typeof replicateShim;
    processReplicatedDocs(docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>): void | Promise<void>;
    canStartOrdinaryReplication(showMessage?: boolean): Promise<boolean>;
    requestAuthenticate(peerId: string, signal?: AbortSignal): Promise<boolean | undefined>;
    checkTweakValues(peerId: string, signal?: AbortSignal, logLevel?: LOG_LEVEL): Promise<boolean>;
    replicateFrom(
        peerId: string,
        showNotice: boolean,
        fromStart: boolean,
        skipPolicy: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult>;
    requestSynchroniseToPeer(peerId: string, signal?: AbortSignal): Promise<P2PReplicationResult>;
    dispatchStatus(): void;
    dispatchReplicationProgress(peerId: string, info?: ProgressInfo): void;
    acknowledgeProgress(peerId: string, info?: ProgressInfo, acknowledgement?: ProgressAcknowledgement): void;
    beginProgressAttempt(): ProgressAcknowledgement;
    reportDiagnostic(input: P2PDiagnosticInput): void;
    notifyProgress(excludePeerId?: string): Promise<void> | undefined;
}

interface TransferState {
    availableReplicationPairs: Set<string>;
    replicateToPeers: Set<string>;
    replicateFromPeers: Set<string>;
}

export interface Transfers extends TransferState {
    requestSynchroniseToPeer(peerId: string, signal?: AbortSignal): Promise<P2PReplicationResult>;
    requestSynchroniseToAllAvailablePeers(): Promise<void>;
    sync(peerId: string, showNotice: boolean, signal?: AbortSignal): Promise<P2PReplicationResult>;
    replicateFrom(
        peerId: string,
        showNotice: boolean,
        fromStart: boolean,
        skipPolicy: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult>;
    clearActivePeers(): void;
}

/** Only policy admission and connection lookup are needed for a reverse request. */
export type RequestSynchronisationContext = {
    deps: Pick<TransferDependencies, "canStartOrdinaryReplication" | "host">;
};

export type AvailableTargetsContext = {
    deps: Pick<TransferDependencies, "requestSynchroniseToPeer">;
    state: Pick<TransferState, "availableReplicationPairs">;
};

export type BidirectionalSyncContext = {
    deps: Pick<TransferDependencies, "replicateFrom" | "requestSynchroniseToPeer">;
};

/** The observer forwards a composed pull result and only owns diagnostic reporting. */
export type ReplicationObservationContext = {
    deps: Pick<TransferDependencies, "reportDiagnostic">;
    pullFromWithinSession: Transfers["replicateFrom"];
};

export type PeerAgreementGateContext = {
    deps: Pick<TransferDependencies, "requestAuthenticate" | "checkTweakValues">;
};

export type DatabaseTransferContext = {
    deps: Pick<
        TransferDependencies,
        "host" | "database" | "currentSettings" | "replicate" | "processReplicatedDocs" | "notifyProgress"
    >;
};

/** Admission and database transfer are operations composed by the factory. */
export type PullContext = {
    deps: Pick<
        TransferDependencies,
        | "canStartOrdinaryReplication"
        | "dispatchStatus"
        | "beginProgressAttempt"
        | "dispatchReplicationProgress"
        | "acknowledgeProgress"
    >;
    state: Pick<TransferState, "replicateFromPeers">;
    checkPeerForReplication(
        peerId: string,
        logLevel: LOG_LEVEL,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult | undefined>;
    transferFromPeer(
        peerId: string,
        fromStart: boolean,
        logLevel: LOG_LEVEL,
        signal?: AbortSignal,
        onStatistics?: (info: ProgressInfo) => void
    ): Promise<P2PReplicationResult>;
};

export type ActiveTransferStateContext = {
    state: Pick<TransferState, "replicateFromPeers" | "replicateToPeers">;
};

/** Clear activity indicators without discarding the available-target set or closing borrowed resources. */
export function clearActivePeers({ state }: ActiveTransferStateContext): void {
    state.replicateFromPeers.clear();
    state.replicateToPeers.clear();
}

/**
 * Construct the transfer state owner without opening a database or starting RPC.
 * Public facade accessors and these operations share the same peer sets. The
 * containing session lends its cancellation signal; no new session owner exists.
 */
export function createTransfers(deps: TransferDependencies): Transfers {
    const state: TransferState = {
        availableReplicationPairs: new Set<string>(),
        replicateToPeers: new Set<string>(),
        replicateFromPeers: new Set<string>(),
    };
    const agreement = bindContext({ deps }, checkPeerForReplication);
    const transfer = bindContext({ deps }, transferFromPeer);
    const pull = bindContext(
        { deps, state, checkPeerForReplication: agreement, transferFromPeer: transfer },
        pullFromWithinSession
    );
    return Object.assign(state, {
        requestSynchroniseToPeer: bindContext({ deps }, requestSynchroniseToPeer),
        requestSynchroniseToAllAvailablePeers: bindContext({ deps, state }, requestSynchroniseToAllAvailablePeers),
        sync: bindContext({ deps }, sync),
        replicateFrom: bindContext({ deps, pullFromWithinSession: pull }, replicateFrom),
        clearActivePeers: bindContext({ state }, clearActivePeers),
    });
}

/**
 * Request the reverse transfer after ordinary-policy admission and the existing
 * 25 ms scheduling delay. Cancellation is checked on both sides of that delay;
 * the RPC itself retains its zero deadline and the caller's signal.
 */
export async function requestSynchroniseToPeer(
    context: RequestSynchronisationContext,
    peerId: string,
    signal?: AbortSignal
): Promise<P2PReplicationResult> {
    const { deps } = context;
    if (!(await deps.canStartOrdinaryReplication(false))) {
        return p2pReplicationFailed(new Error("Replication is not ready"));
    }
    if (signal?.aborted) {
        return P2P_REPLICATION_CANCELLED;
    }
    await delay(25);
    if (signal?.aborted) {
        return P2P_REPLICATION_CANCELLED;
    }
    const host = deps.host();
    if (!host) {
        throw new Error("Server is not available");
    }
    const conn = host.connection(peerId);
    try {
        const result = await conn.requestSynchronisation(0, signal);
        return fromP2PReplicationWireResult(result);
    } catch (error) {
        if (signal?.aborted) {
            return P2P_REPLICATION_CANCELLED;
        }
        throw error;
    }
}

/** Retain the existing shared scheduling key and fan-out to available peer IDs. */
export async function requestSynchroniseToAllAvailablePeers(context: AvailableTargetsContext) {
    const { deps, state } = context;
    await scheduleOnceIfDuplicated("requestSynchroniseToAllAvailablePeers", async () => {
        await delay(25);
        const replications = [...state.availableReplicationPairs].map((peerId) => {
            return deps.requestSynchroniseToPeer(peerId);
        });
        await Promise.all(replications);
    });
}

/** Apply the existing pull-result and cancellation gates before requesting the reverse transfer. */
export async function sync(
    context: BidirectionalSyncContext,
    remotePeer: string,
    showNotice: boolean,
    signal?: AbortSignal
): Promise<P2PReplicationResult> {
    const { deps } = context;
    const from = await deps.replicateFrom(remotePeer, showNotice, false, false, signal);
    if (isP2PReplicationCancelled(from)) {
        return from;
    }
    if (from.error) {
        Logger("Error while replicating from the remote", LOG_LEVEL_VERBOSE);
        Logger(from.error, LOG_LEVEL_VERBOSE);
        return from;
    }
    if (signal?.aborted) {
        return P2P_REPLICATION_CANCELLED;
    }
    const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
    Logger(`P2P Replication has been requested to ${remotePeer}`, logLevel, "p2p-replicator");

    const res = await deps.requestSynchroniseToPeer(remotePeer, signal);
    if (res.ok) {
        Logger("P2P Replication has been done", logLevel, "p2p-replicator");
    }
    if (res.error) {
        Logger("Error while syncing from the remote", logLevel, "p2p-replicator");
        Logger(res.error, LOG_LEVEL_VERBOSE);
    }
    return res;
}

/** Report the pull outcome without changing which failures propagate to the caller. */
export async function replicateFrom(
    context: ReplicationObservationContext,
    remotePeer: string,
    showNotice: boolean,
    fromStart: boolean,
    skipOrdinaryReplicationPolicy: boolean,
    signal?: AbortSignal
): Promise<P2PReplicationResult> {
    const { deps } = context;
    deps.reportDiagnostic({ category: "sync", code: "pull-started", peerId: remotePeer });
    try {
        const result = await context.pullFromWithinSession(
            remotePeer,
            showNotice,
            fromStart,
            skipOrdinaryReplicationPolicy,
            signal
        );
        deps.reportDiagnostic(pullResultDiagnostic(remotePeer, result.status));
        return result;
    } catch (error) {
        deps.reportDiagnostic(pullFailureDiagnostic(remotePeer, signal?.aborted ?? false));
        throw error;
    }
}

/**
 * Apply policy and agreement before registering an active pull. Preserve the
 * existing progress-start boundary and finalisation order; the session remains
 * responsible for cancellation, and these operations do not close borrowed DBs.
 */
export async function pullFromWithinSession(
    context: PullContext,
    remotePeer: string,
    showNotice: boolean,
    fromStart: boolean,
    skipOrdinaryReplicationPolicy: boolean,
    signal?: AbortSignal
): Promise<P2PReplicationResult> {
    const { deps, state } = context;
    // Explicit Fetch/Rebuild flows have their own destructive-operation
    // confirmation and must remain available while ordinary replication is paused.
    if (!skipOrdinaryReplicationPolicy && !(await deps.canStartOrdinaryReplication(showNotice))) {
        return p2pReplicationFailed(new Error("Replication is not ready"));
    }
    if (signal?.aborted) {
        return P2P_REPLICATION_CANCELLED;
    }
    const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
    const rejection = await context.checkPeerForReplication(remotePeer, logLevel, signal);
    if (rejection) {
        return rejection;
    }

    Logger(`P2P Replicating from ${remotePeer}`, logLevel, "p2p-replicator");
    if (state.replicateFromPeers.has(remotePeer)) {
        Logger(`Replication from ${remotePeer} is already in progress`, logLevel, "p2p-replicator");
        return p2pReplicationFailed(new Error("Replication from this peer is already in progress"));
    }
    // Register progress only after policy, agreement, and overlap checks.
    state.replicateFromPeers.add(remotePeer);
    deps.dispatchStatus();
    const acknowledgement = deps.beginProgressAttempt();
    let latestProgress: ProgressInfo = {
        lastSeq: 0,
        maxSeqInBatch: 0,
        statistics: { documents: 0, checkedChanges: 0 },
    };
    deps.dispatchReplicationProgress(remotePeer, latestProgress);
    deps.acknowledgeProgress(remotePeer, latestProgress, acknowledgement);

    try {
        return await context.transferFromPeer(remotePeer, fromStart, logLevel, signal, (info) => {
            latestProgress = info;
            deps.dispatchReplicationProgress(remotePeer, info);
            deps.acknowledgeProgress(remotePeer, info, acknowledgement);
        });
    } catch (e) {
        if (signal?.aborted) {
            return P2P_REPLICATION_CANCELLED;
        }
        Logger("Error while P2P replicating", logLevel, "p2p-replicator");
        Logger(e, LOG_LEVEL_VERBOSE);
        return p2pReplicationFailed(e);
    } finally {
        // End local and remote progress before releasing the active peer and status.
        deps.dispatchReplicationProgress(remotePeer);
        deps.acknowledgeProgress(remotePeer, undefined, { ...acknowledgement, finalProgress: latestProgress });
        state.replicateFromPeers.delete(remotePeer);
        deps.dispatchStatus();
    }
}

/**
 * Keep authentication and compatibility gates ahead of transfer state entry.
 * Facade dispatch preserves caller overrides; this layer alone translates
 * failed gates into the replication result and cancellation vocabulary.
 */
export async function checkPeerForReplication(
    context: PeerAgreementGateContext,
    remotePeer: string,
    logLevel: LOG_LEVEL,
    signal?: AbortSignal
): Promise<P2PReplicationResult | undefined> {
    const { deps } = context;
    Logger(`P2P Requesting Authentication to ${remotePeer}`, logLevel, "p2p-replicator");
    const authenticated = signal
        ? await deps.requestAuthenticate(remotePeer, signal)
        : await deps.requestAuthenticate(remotePeer);
    if (authenticated !== true) {
        if (signal?.aborted) {
            return P2P_REPLICATION_CANCELLED;
        }
        Logger("Peer rejected the connection", logLevel, "p2p-replicator");
        return p2pReplicationFailed(new Error("Peer rejected the connection"));
    }

    let tweaksMatched: boolean;
    try {
        tweaksMatched = signal
            ? await deps.checkTweakValues(remotePeer, signal, logLevel)
            : await deps.checkTweakValues(remotePeer, undefined, logLevel);
    } catch (error) {
        if (signal?.aborted) {
            return P2P_REPLICATION_CANCELLED;
        }
        throw error;
    }
    if (tweaksMatched !== true) {
        if (signal?.aborted) {
            return P2P_REPLICATION_CANCELLED;
        }
        Logger("Tweak values are not matched", logLevel, "p2p-replicator");
        return p2pReplicationFailed(new Error("Tweak values are not matched"));
    }
    return undefined;
}

/**
 * Validate both database identities before invoking the shared replication engine.
 * Notify other peers only after the host has processed a committed batch. The
 * engine owns checkpoint and document handling; this adapter retains its options.
 */
export async function transferFromPeer(
    context: DatabaseTransferContext,
    remotePeer: string,
    fromStart: boolean,
    logLevel: LOG_LEVEL,
    signal?: AbortSignal,
    onStatistics?: (info: ProgressInfo) => void
): Promise<P2PReplicationResult> {
    const { deps } = context;
    const host = deps.host();
    if (!host) {
        throw new Error("Server is not available");
    }
    const connection = host.connection(remotePeer);
    const remoteDB = connection.getRemoteDB(signal);
    const pathNormalizationVersion = getPathNormalizationVersion(deps.currentSettings());
    const [localPathIdentity, remotePathIdentity] = await Promise.all([
        readLocalP2PPathIdentity(deps.database(), pathNormalizationVersion),
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
    const localDBInfo = await deps.database().info();
    Logger(
        `P2P replicateFrom local DB info for ${remotePeer}: ${localDBInfo.db_name} seq=${localDBInfo.update_seq}`,
        LOG_LEVEL_VERBOSE,
        "p2p-replicator"
    );
    Logger(`P2P replicateFrom entering replicateShim for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
    const outcome = await deps.replicate(
        deps.database(),
        remoteDB,
        async (docs, info) => {
            await deps.processReplicatedDocs(docs as Array<PouchDB.Core.ExistingDocument<EntryDoc>>);
            void deps.notifyProgress(remotePeer);
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
