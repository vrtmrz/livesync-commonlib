import { bindContext } from "octagonal-wheels/context";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, Logger } from "octagonal-wheels/common/logger";
import type { TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import type { P2PSyncSetting } from "@lib/common/types";
import type { MessageTranslator } from "@lib/services/base/MessageTranslator";
import type { Advertisement } from "../types";
import type {
    P2PPeerAcceptance,
    P2PReplicationResult,
    P2PConfiguredTargetResult,
    P2PConfiguredReplicationResult,
} from "../replicationTypes";

export type { P2PConfiguredTargetResult, P2PConfiguredReplicationResult } from "../replicationTypes";

/** Narrow host capabilities used to synchronise the configured peer list. */
export interface ConfiguredTargetsDependencies {
    /** Read current settings; enablement and configured names are read separately. */
    currentSettings(): P2PSyncSetting;
    /** Return the advertisements currently known to the room. */
    advertisements(): readonly Advertisement[];
    /** Evaluate current admission policy without opening any user interface. */
    evaluatePeerAcceptance(peerId: string): Promise<P2PPeerAcceptance | undefined>;
    /** Preserve the host's existing baseline-work deduplication and ordering. */
    runBaseline(peerName: string, task: () => Promise<P2PReplicationResult>): Promise<P2PReplicationResult>;
    /** Preserve dynamic host sync dispatch, result presentation, and cancellation. */
    sync(peerId: string, showResult: boolean, signal?: AbortSignal): Promise<P2PReplicationResult>;
    /** Subscribe to advertisement changes and return the synchronous detacher. */
    onAdvertisement(listener: () => void): () => void;
    /** Schedule a timeout and return its matching cancellation function. */
    scheduleTimeout: TimeoutScheduler;
    /** Translate the existing configured-sync log messages. */
    translate: MessageTranslator;
}

/** Configured-target operation exposed by the existing replicator facade. */
export interface ConfiguredTargets {
    replicateFromCommand(
        showResult?: boolean,
        discoveryTimeoutMs?: number,
        callerSignal?: AbortSignal
    ): Promise<P2PConfiguredReplicationResult>;
}

/** Only discovery capabilities are needed while waiting for advertisements. */
export type AdvertisementWaitContext = {
    deps: Pick<ConfiguredTargetsDependencies, "advertisements" | "onAdvertisement" | "scheduleTimeout">;
};

/** The workflow consumes a composed wait operation, not its timer or subscription dependencies. */
export type ConfiguredSyncContext = {
    deps: Pick<
        ConfiguredTargetsDependencies,
        "currentSettings" | "advertisements" | "evaluatePeerAcceptance" | "runBaseline" | "sync" | "translate"
    >;
    waitForConfiguredAdvertisements(
        peerNames: readonly string[],
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<void>;
};

/** Resources acquired for one discovery wait; no state is shared between waits. */
export type AdvertisementWaitState = {
    signal: AbortSignal | undefined;
    resolve(): void;
    detachAdvertisement(): void;
    cancelTimeout: (() => void) | undefined;
};

/** Construct bindings without reading settings, subscribing, scheduling, or starting replication. */
export function createConfiguredTargets(deps: ConfiguredTargetsDependencies): ConfiguredTargets {
    const wait = bindContext({ deps }, waitForConfiguredAdvertisements);
    return {
        replicateFromCommand: bindContext({ deps, waitForConfiguredAdvertisements: wait }, replicateFromCommand),
    };
}

/** Read, trim, and de-duplicate the already selected policy string. */
export function configuredPeerNames(names: string): string[] {
    return [...new Set(names.split(",").map((name) => name.trim()))].filter(Boolean);
}

/** Find a peer in the advertisement snapshot supplied by the caller. */
export function findAdvertisement(
    advertisements: readonly Advertisement[],
    peerName: string
): Advertisement | undefined {
    return advertisements.find((advertisement) => advertisement.name === peerName);
}

/** Re-read advertisements for each configured name, preserving the existing discovery predicate. */
export function areConfiguredPeersPresent(
    deps: Pick<ConfiguredTargetsDependencies, "advertisements">,
    peerNames: readonly string[]
): boolean {
    return peerNames.every((name) => findAdvertisement(deps.advertisements(), name) !== undefined);
}

/** Release event, abort, and timeout hooks synchronously before completing the wait. */
export function finishAdvertisementWait(state: AdvertisementWaitState, abortListener: () => void): void {
    const { detachAdvertisement, signal, cancelTimeout, resolve } = state;
    detachAdvertisement();
    signal?.removeEventListener("abort", abortListener);
    cancelTimeout?.();
    resolve();
}

/** Finish discovery only after its captured set of names is currently present. */
export function finishIfConfiguredPeersPresent(
    deps: Pick<ConfiguredTargetsDependencies, "advertisements">,
    peerNames: readonly string[],
    finish: () => void
): void {
    if (areConfiguredPeersPresent(deps, peerNames)) {
        finish();
    }
}

/**
 * Register one event-driven discovery wait. The Promise adapter supplies resolve;
 * this function needs only advertisements, subscription, and timing capabilities.
 * Registration order and the final recheck preserve the existing handling of
 * advertisements and aborts delivered during setup. Setup errors propagate to
 * the adapter's executor, which turns them into promise rejection.
 */
export function registerAdvertisementWait(
    { deps }: AdvertisementWaitContext,
    peerNames: readonly string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    resolve: () => void
): void {
    if (areConfiguredPeersPresent(deps, peerNames) || timeoutMs <= 0 || signal?.aborted) {
        resolve();
        return;
    }
    const state: AdvertisementWaitState = {
        signal,
        resolve,
        detachAdvertisement: () => undefined,
        cancelTimeout: undefined,
    };
    // This adapter retains the exact listener identity for removal, including
    // callbacks delivered synchronously before subscription registration returns.
    const finish = () => finishAdvertisementWait(state, finish);
    state.detachAdvertisement = deps.onAdvertisement(() => finishIfConfiguredPeersPresent(deps, peerNames, finish));
    signal?.addEventListener("abort", finish, { once: true });
    state.cancelTimeout = deps.scheduleTimeout(finish, timeoutMs);
    if (areConfiguredPeersPresent(deps, peerNames) || signal?.aborted) {
        finish();
    }
}

/**
 * Adapt advertisement events, timeout, and abort to one promise without an outer
 * async/await wrapper. Initial checks also run inside the executor, so their
 * exceptions remain rejections. Timeout and cancellation end discovery waiting;
 * target processing still classifies each target separately.
 */
export function waitForConfiguredAdvertisements(
    context: AdvertisementWaitContext,
    peerNames: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal
): Promise<void> {
    return new Promise<void>((resolve) => registerAdvertisementWait(context, peerNames, timeoutMs, signal, resolve));
}

/** Keep the target-level outcome mapping used by the facade. */
export function configuredTargetResult(
    name: string,
    peerId: string,
    result: P2PReplicationResult
): P2PConfiguredTargetResult {
    if (result.status === "completed") {
        return { name, peerId, status: "completed" };
    }
    if (result.status === "cancelled") {
        return { name, peerId, status: "cancelled" };
    }
    return { name, peerId, status: "failed", error: result.error };
}

/**
 * Synchronise configured peers sequentially without opening peer-selection UI.
 *
 * The configured-name list is fixed for this invocation, while advertisement
 * identity and admission are re-read for each target. A returned failed sync
 * becomes a failed target; thrown settings, admission, baseline, timer, or sync
 * errors propagate to the caller unchanged.
 */
export async function replicateFromCommand(
    { deps, waitForConfiguredAdvertisements }: ConfiguredSyncContext,
    showResult: boolean = false,
    discoveryTimeoutMs: number = 5000,
    callerSignal?: AbortSignal
): Promise<P2PConfiguredReplicationResult> {
    const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
    if (!deps.currentSettings().P2P_Enabled) {
        Logger(deps.translate("P2P.NotEnabled"), logLevel);
        return { status: "blocked", reason: "no-targets", targets: [] };
    }

    // Keep enablement and target policy as separate current-settings reads.
    const peerNames = configuredPeerNames(deps.currentSettings().P2P_SyncOnReplication);
    if (peerNames.length === 0) {
        Logger(deps.translate("P2P.NoAutoSyncPeers"), logLevel);
        return { status: "blocked", reason: "no-targets", targets: [] };
    }

    // Discovery waits only for the configured-name snapshot. Timeout or abort
    // allows the ordered pass below to classify every target independently.
    await waitForConfiguredAdvertisements(peerNames, discoveryTimeoutMs, callerSignal);

    const targets: P2PConfiguredTargetResult[] = [];
    for (const peerName of peerNames) {
        if (callerSignal?.aborted) {
            targets.push({ name: peerName, status: "cancelled" });
            continue;
        }

        const advertisement = findAdvertisement(deps.advertisements(), peerName);
        if (!advertisement) {
            Logger(deps.translate("P2P.SeemsOffline", { name: peerName }), logLevel);
            targets.push({ name: peerName, status: "missing" });
            continue;
        }

        const acceptance: P2PPeerAcceptance = (await deps.evaluatePeerAcceptance(advertisement.peerId)) ?? "unknown";
        if (acceptance !== "accepted") {
            targets.push({
                name: peerName,
                peerId: advertisement.peerId,
                status: acceptance === "rejected" ? "rejected" : acceptance === "undecided" ? "undecided" : "missing",
            });
            continue;
        }

        Logger(deps.translate("P2P.SyncStartedWith", { name: peerName }), logLevel);
        const result = await deps.runBaseline(peerName, () =>
            deps.sync(advertisement.peerId, showResult, callerSignal)
        );
        targets.push(configuredTargetResult(peerName, advertisement.peerId, result));
    }

    // A result is complete only if every configured target completed. Cancellation
    // remains a whole-operation result only when every target was cancelled.
    if (targets.every((target) => target.status === "completed")) {
        Logger(deps.translate("P2P.SyncCompleted"), logLevel);
        return { status: "completed", targets };
    }
    if (targets.every((target) => target.status === "cancelled")) {
        return { status: "cancelled", targets };
    }
    return { status: "partial", targets };
}
