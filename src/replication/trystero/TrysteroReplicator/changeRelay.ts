import type PouchDB from "pouchdb-core";
import type { EntryDoc } from "@lib/common/types";
import type { P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import { bindContext } from "octagonal-wheels/context";
import { serialized } from "octagonal-wheels/concurrency/lock_v2";
import { fireAndForget } from "octagonal-wheels/promises";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { notificationFailureDiagnostic } from "../p2pReplicationDiagnostics";

/** A notification target captured before asynchronous admission is evaluated. */
export interface PeerNotificationTarget {
    isAccepted(): Promise<boolean>;
    isCurrent(): boolean;
    send(): Promise<void>;
}

export interface ChangeRelayDependencies<TPullResult> {
    createChangesFeed(options: PouchDB.Core.ChangesOptions): PouchDB.Core.Changes<EntryDoc>;
    hasHost(): boolean;
    peerIds(): readonly string[];
    captureNotificationTarget(peerId: string): PeerNotificationTarget | undefined;
    isDisposed(): boolean;
    announceChanges(): void | Promise<void>;
    pullPeer(peerId: string): Promise<TPullResult>;
    dispatchStatus(): void;
    reportDiagnostic(input: P2PDiagnosticInput): void;
}

interface ChangeRelayState {
    changes: PouchDB.Core.Changes<EntryDoc> | undefined;
    isBroadcasting: boolean;
    watchingPeers: Set<string>;
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

interface ChangeRelayContext<TPullResult> {
    deps: ChangeRelayDependencies<TPullResult>;
    relay: ChangeRelayState;
}

/** Own the changes feed and follow policy without owning transport or transfers. */
export function createChangeRelay<TPullResult>(deps: ChangeRelayDependencies<TPullResult>): ChangeRelay<TPullResult> {
    const relay: ChangeRelayState = {
        changes: undefined,
        isBroadcasting: false,
        watchingPeers: new Set<string>(),
        lastSeq: "",
    };
    const context: ChangeRelayContext<TPullResult> = { deps, relay };
    return Object.assign(relay, {
        enableBroadcastChanges: bindContext(context, enableBroadcastChanges),
        disableBroadcastChanges: bindContext(context, disableBroadcastChanges),
        notifyProgress: bindContext(context, notifyProgress),
        watchPeer: bindContext(context, watchPeer),
        unwatchPeer: bindContext(context, unwatchPeer),
        onUpdateDatabase: bindContext(context, onUpdateDatabase<TPullResult>),
    });
}

function disableBroadcastChanges({ deps, relay }: ChangeRelayContext<unknown>): void {
    const wasBroadcasting = relay.isBroadcasting;
    relay.changes?.cancel();
    const needsDiagnostic = wasBroadcasting && relay.isBroadcasting;
    relay.isBroadcasting = false;
    deps.dispatchStatus();
    if (needsDiagnostic) {
        deps.reportDiagnostic({ category: "sync", code: "broadcast-disabled" });
    }
}

function enableBroadcastChanges({ deps, relay }: ChangeRelayContext<unknown>): void {
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
    void relay.changes.on("change", async (change) => {
        relay.lastSeq = change.seq;
        await deps.announceChanges();
    });
    const closeChanges = (reason?: unknown) => {
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
    };
    void relay.changes.on("error", closeChanges);
    void relay.changes.on("complete", closeChanges);
    deps.reportDiagnostic({ category: "sync", code: "broadcast-enabled" });
    fireAndForget(async () => await deps.announceChanges());
}

function notifyProgress(context: ChangeRelayContext<unknown>, excludePeerId?: string): Promise<void> | undefined {
    const { deps, relay } = context;
    if (!relay.isBroadcasting || !deps.hasHost()) {
        return;
    }
    for (const peerId of deps.peerIds()) {
        if (peerId === excludePeerId) {
            continue;
        }
        void serialized(`notifyProgress-${peerId}`, () => notifyPeerProgress(context, peerId));
    }
    return Promise.resolve();
}

async function notifyPeerProgress({ deps, relay }: ChangeRelayContext<unknown>, peerId: string): Promise<void> {
    const target = deps.captureNotificationTarget(peerId);
    if (!target || deps.isDisposed() || !relay.isBroadcasting) {
        return;
    }
    const isAcceptable = await target.isAccepted();
    if (!isAcceptable) {
        deps.reportDiagnostic({
            category: "sync",
            code: "change-notification-ignored",
            peerId,
            reason: "not-accepted",
        });
        Logger(`Peer ${peerId} is not acceptable to notify progress`, LOG_LEVEL_VERBOSE);
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
        Logger(`Error while notifying progress to ${peerId}`, LOG_LEVEL_VERBOSE);
        Logger(error, LOG_LEVEL_VERBOSE);
    }
}

function watchPeer({ deps, relay }: ChangeRelayContext<unknown>, peerId: string): void {
    if (!relay.watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "watch-enabled", peerId });
    }
    relay.watchingPeers.add(peerId);
    deps.dispatchStatus();
}

function unwatchPeer({ deps, relay }: ChangeRelayContext<unknown>, peerId: string): void {
    if (relay.watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "watch-disabled", peerId });
    }
    relay.watchingPeers.delete(peerId);
    deps.dispatchStatus();
}

async function onUpdateDatabase<TPullResult>(
    { deps, relay }: ChangeRelayContext<TPullResult>,
    peerId: string
): Promise<TPullResult | false> {
    if (relay.watchingPeers.has(peerId)) {
        deps.reportDiagnostic({ category: "sync", code: "change-notification-received", peerId });
        Logger(`Progress notification from ${peerId}`, LOG_LEVEL_VERBOSE);
        return await serialized(`onProgress-${peerId}`, async () => await deps.pullPeer(peerId));
    }
    deps.reportDiagnostic({
        category: "sync",
        code: "change-notification-ignored",
        peerId,
        reason: "not-watching",
    });
    return false;
}
