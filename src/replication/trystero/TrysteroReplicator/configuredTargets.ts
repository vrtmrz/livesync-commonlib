import { bindContext } from "octagonal-wheels/context";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, Logger } from "octagonal-wheels/common/logger";
import type { TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import type { P2PSyncSetting } from "@lib/common/types";
import type { MessageTranslator } from "@lib/services/base/MessageTranslator";
import type { P2PPeerAcceptance } from "../TrysteroReplicatorP2PServer";
import type { Advertisement } from "../types";
import type { P2PReplicationResult } from "./transfers";

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
    | {
          readonly status: "completed";
          readonly targets: readonly P2PConfiguredTargetResult[];
      }
    | {
          readonly status: "cancelled";
          readonly targets: readonly P2PConfiguredTargetResult[];
      }
    | {
          readonly status: "blocked";
          readonly reason: "no-targets";
          readonly targets: readonly [];
      }
    | {
          readonly status: "partial";
          readonly targets: readonly P2PConfiguredTargetResult[];
      };

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

interface ConfiguredTargetsContext {
    deps: ConfiguredTargetsDependencies;
}

/**
 * Construct the configured-target operation without reading settings, subscribing,
 * scheduling, or starting replication.
 *
 * Each invocation reads current enablement and then snapshots configured names.
 * Advertisements and admission are checked against current room state as targets
 * are processed. Baseline work and sync remain owned by the existing host.
 */
export function createConfiguredTargets(deps: ConfiguredTargetsDependencies): ConfiguredTargets {
    const context: ConfiguredTargetsContext = { deps };
    return {
        replicateFromCommand: bindContext(context, replicateFromCommand),
    };
}

/** Read, trim, and de-duplicate the configured names for one operation snapshot. */
function configuredPeerNames({ deps }: ConfiguredTargetsContext): string[] {
    return [
        ...new Set(
            deps
                .currentSettings()
                .P2P_SyncOnReplication.split(",")
                .map((name) => name.trim())
        ),
    ].filter(Boolean);
}

/** Find a peer by its current advertised name. */
function findAdvertisement({ deps }: ConfiguredTargetsContext, peerName: string): Advertisement | undefined {
    return deps.advertisements().find((advertisement) => advertisement.name === peerName);
}

/**
 * Wait for the captured set of names to appear, or for timeout or cancellation.
 *
 * The listener, any caller abort hook, and the timeout are installed before the
 * final state check so advertisements arriving during subscription are not
 * missed. Discovery cleanup detaches the event listener, removes the abort hook,
 * and cancels the timeout before the waiting operation continues into target processing.
 * Timeout and cancellation end discovery waiting; target processing still
 * reports each name as present, missing, or cancelled.
 */
async function waitForConfiguredAdvertisements(
    context: ConfiguredTargetsContext,
    peerNames: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal
): Promise<void> {
    const allPresent = () => peerNames.every((name) => findAdvertisement(context, name) !== undefined);
    if (allPresent() || timeoutMs <= 0 || signal?.aborted) {
        return;
    }

    const { deps } = context;
    await new Promise<void>((resolve) => {
        let cancelTimeout: (() => void) | undefined;
        let detachAdvertisement: () => void = () => undefined;

        const finish = () => {
            detachAdvertisement();
            signal?.removeEventListener("abort", finish);
            if (cancelTimeout !== undefined) {
                cancelTimeout();
            }
            resolve();
        };

        detachAdvertisement = deps.onAdvertisement(() => {
            if (allPresent()) {
                finish();
            }
        });
        signal?.addEventListener("abort", finish, { once: true });
        cancelTimeout = deps.scheduleTimeout(finish, timeoutMs);
        // Recheck after registration, including events delivered while subscribing.
        if (allPresent() || signal?.aborted) {
            finish();
        }
    });
}

/** Keep the target-level outcome mapping used by the facade. */
function configuredTargetResult(name: string, peerId: string, result: P2PReplicationResult): P2PConfiguredTargetResult {
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
async function replicateFromCommand(
    { deps }: ConfiguredTargetsContext,
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
    const peerNames = configuredPeerNames({ deps });
    if (peerNames.length === 0) {
        Logger(deps.translate("P2P.NoAutoSyncPeers"), logLevel);
        return { status: "blocked", reason: "no-targets", targets: [] };
    }

    // Discovery waits only for the configured-name snapshot. Timeout or abort
    // allows the ordered pass below to classify every target independently.
    await waitForConfiguredAdvertisements({ deps }, peerNames, discoveryTimeoutMs, callerSignal);

    const targets: P2PConfiguredTargetResult[] = [];
    for (const peerName of peerNames) {
        if (callerSignal?.aborted) {
            targets.push({ name: peerName, status: "cancelled" });
            continue;
        }

        const advertisement = findAdvertisement({ deps }, peerName);
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
