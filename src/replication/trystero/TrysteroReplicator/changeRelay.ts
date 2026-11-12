import type PouchDB from "pouchdb-core";
import type { EntryDoc } from "@lib/common/types";
import type { P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import { bindContext } from "octagonal-wheels/context";
import { serialized } from "octagonal-wheels/concurrency/lock_v2";
import { fireAndForget } from "octagonal-wheels/promises";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { notificationFailureDiagnostic } from "../p2pReplicationDiagnostics";

/**
 * One host/room binding captured before admission is awaited.
 * isCurrent must still identify that binding when admission settles; a
 * replacement room must not receive work authorised for the previous room.
 */
export interface PeerNotificationTarget {
    isAccepted(): Promise<boolean>;
    isCurrent(): boolean;
    send(): Promise<void>;
}

/**
 * Capabilities supplied by the replicator. The relay owns notification policy
 * and feed state; the host retains the database, transport, and transfer lifetime.
 */
export interface ChangeRelayDependencies<TPullResult> {
    /** Open the database feed using the relay's existing selection policy. */
    createChangesFeed(options: PouchDB.Core.ChangesOptions): PouchDB.Core.Changes<EntryDoc>;
    hasHost(): boolean;
    peerIds(): readonly string[];
    /** Capture identity and operations together, before asynchronous admission. */
    captureNotificationTarget(peerId: string): PeerNotificationTarget | undefined;
    isDisposed(): boolean;
    /** Retain the host notification entry point, including overrides and observers. */
    announceChanges(): void | Promise<void>;
    /** Run a pull through the host's existing finite-operation owner. */
    pullPeer(peerId: string): Promise<TPullResult>;
    dispatchStatus(): void;
    reportDiagnostic(input: P2PDiagnosticInput): void;
}

interface ChangeRelayState {
    /** The feed handle remains here until its terminal cleanup clears it. */
    changes: PouchDB.Core.Changes<EntryDoc> | undefined;
    /** Local announcement policy, rather than evidence of peer delivery. */
    isBroadcasting: boolean;
    /** Sources whose progress notifications may start a pull. */
    watchingPeers: Set<string>;
    /** Opaque database sequence; the relay records it without ordering it. */
    lastSeq: string | number;
}

/** Change-relay state exposed through the existing replicator facade. */
export interface ChangeRelay<TPullResult> extends ChangeRelayState {
    enableBroadcastChanges(): void;
    disableBroadcastChanges(): void;
    notifyProgress(excludePeerId?: string): Promise<void> | undefined;
    watchPeer(peerId: string): void;
    unwatchPeer(peerId: string): void;
    onUpdateDatabase(peerId: string): Promise<TPullResult | false>;
}

type OnChangeContext = {
    deps: Pick<ChangeRelayDependencies<unknown>, "announceChanges">;
    relay: Pick<ChangeRelayState, "lastSeq">;
};

type CloseChangesContext = {
    deps: Pick<ChangeRelayDependencies<unknown>, "dispatchStatus" | "reportDiagnostic">;
    relay: Pick<ChangeRelayState, "changes" | "isBroadcasting">;
};

type DisableBroadcastChangesContext = CloseChangesContext;

type EnableBroadcastChangesContext = {
    deps: Pick<
        ChangeRelayDependencies<unknown>,
        "createChangesFeed" | "dispatchStatus" | "reportDiagnostic" | "announceChanges"
    >;
    relay: Pick<ChangeRelayState, "changes" | "isBroadcasting">;
    onChange(change: PouchDB.Core.ChangesResponseChange<EntryDoc>): Promise<void>;
    closeChanges(reason?: unknown): void;
};

type NotifyProgressContext = {
    deps: Pick<ChangeRelayDependencies<unknown>, "hasHost" | "peerIds">;
    relay: Pick<ChangeRelayState, "isBroadcasting">;
    notifyPeerProgress(peerId: string): Promise<void>;
};

type NotifyPeerProgressContext = {
    deps: Pick<ChangeRelayDependencies<unknown>, "captureNotificationTarget" | "isDisposed" | "reportDiagnostic">;
    relay: Pick<ChangeRelayState, "isBroadcasting">;
};

type WatchPeerContext = {
    deps: Pick<ChangeRelayDependencies<unknown>, "dispatchStatus" | "reportDiagnostic">;
    relay: Pick<ChangeRelayState, "watchingPeers">;
};

type UnwatchPeerContext = WatchPeerContext;

type OnUpdateDatabaseContext<TPullResult> = {
    deps: Pick<ChangeRelayDependencies<TPullResult>, "pullPeer" | "reportDiagnostic">;
    relay: Pick<ChangeRelayState, "watchingPeers">;
};

/**
 * Record a feed sequence before forwarding the host's existing notification
 * entry point. The sequence is opaque and is not compared or normalised.
 */
export async function onChange(
    { deps, relay }: OnChangeContext,
    change: Pick<PouchDB.Core.ChangesResponseChange<EntryDoc>, "seq">
): Promise<void> {
    relay.lastSeq = change.seq;
    await deps.announceChanges();
}

/**
 * Close a completed or failed changes feed and report its terminal transition.
 * Feed errors retain their existing diagnostic and log classification.
 */
export function closeChanges({ deps, relay }: CloseChangesContext, reason?: unknown): void {
    const wasBroadcasting = relay.isBroadcasting;
    if (reason) {
        if (reason instanceof Error) {
            Logger("Error while broadcasting the changes", LOG_LEVEL_INFO);
            Logger(reason, LOG_LEVEL_VERBOSE);
        } else {
            Logger("Broadcasting the changes has been finished", LOG_LEVEL_INFO);
            Logger(reason, LOG_LEVEL_VERBOSE);
        }
    }
    void relay.changes?.cancel();
    void relay.changes?.removeAllListeners();
    relay.changes = undefined;
    relay.isBroadcasting = false;
    deps.dispatchStatus();
    if (wasBroadcasting) {
        deps.reportDiagnostic({
            category: "sync",
            code: "broadcast-disabled",
            ...(reason instanceof Error ? { reason: "replication-error" as const } : {}),
        });
    }
}

/**
 * Stop announcements immediately and request cancellation of the live feed.
 * A synchronous completion callback may already have reported the transition.
 */
export function disableBroadcastChanges({ deps, relay }: DisableBroadcastChangesContext): void {
    const wasBroadcasting = relay.isBroadcasting;
    relay.changes?.cancel();
    // PouchDB may emit completion inside cancel(), lowering the flag itself.
    const needsDiagnostic = wasBroadcasting && relay.isBroadcasting;
    relay.isBroadcasting = false;
    deps.dispatchStatus();
    if (needsDiagnostic) {
        deps.reportDiagnostic({ category: "sync", code: "broadcast-disabled" });
    }
}

/**
 * Enable one live feed and announce its start through the host entry point.
 * Repeated enable calls retain the current feed. Feed callbacks are composed
 * from the separately testable change and close operations.
 */
export function enableBroadcastChanges({
    deps,
    relay,
    onChange: handleChange,
    closeChanges: handleClose,
}: EnableBroadcastChangesContext): void {
    if (relay.isBroadcasting) {
        return;
    }
    relay.isBroadcasting = true;
    deps.dispatchStatus();
    if (relay.changes) {
        void relay.changes.cancel();
        void relay.changes.removeAllListeners();
    }
    relay.changes = deps.createChangesFeed({
        since: "now",
        live: true,
        include_docs: false,
        selector: { _id: { $gt: "_local/" } },
    });
    void relay.changes.on("change", handleChange);
    // Failure and normal completion share the same feed cleanup and status path.
    void relay.changes.on("error", handleClose);
    void relay.changes.on("complete", handleClose);
    deps.reportDiagnostic({ category: "sync", code: "broadcast-enabled" });
    fireAndForget(async () => await deps.announceChanges());
}

/**
 * Schedule notifications using the existing per-peer serialisation keys.
 * The returned promise means scheduling finished; it does not await peer sends
 * or remote acquisition. Disabled broadcasting or a missing host returns early.
 */
export function notifyProgress(
    { deps, relay, notifyPeerProgress: notifyPeer }: NotifyProgressContext,
    excludePeerId?: string
): Promise<void> | undefined {
    if (!relay.isBroadcasting || !deps.hasHost()) {
        return;
    }
    for (const peerId of deps.peerIds()) {
        if (peerId === excludePeerId) {
            continue;
        }
        void serialized("notifyProgress-" + peerId, () => notifyPeer(peerId));
    }
    return Promise.resolve();
}

/** Send only while the captured host/room remains usable after admission. */
export async function notifyPeerProgress({ deps, relay }: NotifyPeerProgressContext, peerId: string): Promise<void> {
    const target = deps.captureNotificationTarget(peerId);
    if (!target || deps.isDisposed() || !relay.isBroadcasting) {
        return;
    }
    // Admission may finish after broadcasting stops or the host changes room.
    const isAcceptable = await target.isAccepted();
    if (!isAcceptable) {
        deps.reportDiagnostic({
            category: "sync",
            code: "change-notification-ignored",
            peerId,
            reason: "not-accepted",
        });
        Logger("Peer " + peerId + " is not acceptable to notify progress", LOG_LEVEL_VERBOSE);
        return;
    }
    try {
        if (deps.isDisposed() || !relay.isBroadcasting || !target.isCurrent()) {
            return;
        }
        await target.send();
        deps.reportDiagnostic({ category: "sync", code: "change-notification-sent", peerId });
    } catch (error) {
        deps.reportDiagnostic(notificationFailureDiagnostic(peerId, error));
        Logger("Error while notifying progress to " + peerId, LOG_LEVEL_VERBOSE);
        Logger(error, LOG_LEVEL_VERBOSE);
    }
}

/** Enable pulls from this source; repeated calls still refresh host status. */
export function watchPeer({ deps, relay }: WatchPeerContext, peerId: string): void {
    const watchingPeers = relay.watchingPeers;
    if (!watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "watch-enabled", peerId });
    }
    watchingPeers.add(peerId);
    deps.dispatchStatus();
}

/** Refuse new progress-triggered pulls without changing an active transfer. */
export function unwatchPeer({ deps, relay }: UnwatchPeerContext, peerId: string): void {
    const watchingPeers = relay.watchingPeers;
    if (watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "watch-disabled", peerId });
    }
    watchingPeers.delete(peerId);
    deps.dispatchStatus();
}

/**
 * Admit a watched source to the existing serial pull path and retain its result.
 * Follow policy is checked before queueing, as in the replicator facade. The
 * host owns transfer cancellation; removing Follow does not cancel queued work.
 * An unwatched source returns false without starting a pull.
 */
export async function onUpdateDatabase<TPullResult>(
    { deps, relay }: OnUpdateDatabaseContext<TPullResult>,
    peerId: string
): Promise<TPullResult | false> {
    const watchingPeers = relay.watchingPeers;
    if (watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "change-notification-received", peerId });
        Logger("Progress notification from " + peerId, LOG_LEVEL_VERBOSE);
        return await serialized("onProgress-" + peerId, async () => await deps.pullPeer(peerId));
    }
    deps.reportDiagnostic({
        category: "sync",
        code: "change-notification-ignored",
        peerId,
        reason: "not-watching",
    });
    return false;
}

/**
 * Construct one relay without opening a feed or starting transport work.
 *
 * The returned facade and the bound operations share one state object. Existing
 * replicator accessors may replace its fields without creating a second owner.
 * The feed outlives each synchronous operation and closes at an explicit stop
 * or terminal feed event; it does not belong to a short asynchronous scope.
 */
export function createChangeRelay<TPullResult>(deps: ChangeRelayDependencies<TPullResult>): ChangeRelay<TPullResult> {
    const relay: ChangeRelayState = {
        changes: undefined,
        isBroadcasting: false,
        watchingPeers: new Set<string>(),
        lastSeq: "",
    };
    const onChangeForRelay = bindContext({ deps, relay }, onChange);
    const closeChangesForRelay = bindContext({ deps, relay }, closeChanges);
    const enableBroadcastChangesForRelay = bindContext(
        { deps, relay, onChange: onChangeForRelay, closeChanges: closeChangesForRelay },
        enableBroadcastChanges
    );
    const notifyPeerProgressForRelay = bindContext({ deps, relay }, notifyPeerProgress);
    return Object.assign(relay, {
        enableBroadcastChanges: enableBroadcastChangesForRelay,
        disableBroadcastChanges: bindContext({ deps, relay }, disableBroadcastChanges),
        notifyProgress: bindContext({ deps, relay, notifyPeerProgress: notifyPeerProgressForRelay }, notifyProgress),
        watchPeer: bindContext({ deps, relay }, watchPeer),
        unwatchPeer: bindContext({ deps, relay }, unwatchPeer),
        onUpdateDatabase: bindContext({ deps, relay }, onUpdateDatabase<TPullResult>),
    });
}
