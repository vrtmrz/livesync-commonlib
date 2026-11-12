import { EventEmitter } from "node:events";
import type PouchDB from "pouchdb-core";
import { describe, expect, it, vi } from "vitest";
import type { EntryDoc } from "@lib/common/types";
import {
    closeChanges,
    createChangeRelay,
    disableBroadcastChanges,
    enableBroadcastChanges,
    notifyPeerProgress,
    notifyProgress,
    onChange,
    onUpdateDatabase,
    unwatchPeer,
    watchPeer,
    type PeerNotificationTarget,
} from "./changeRelay";

function createHarness() {
    const emitter = new EventEmitter();
    const feed = Object.assign(emitter, { cancel: vi.fn() });
    const createChangesFeed = vi.fn(() => feed as unknown as PouchDB.Core.Changes<EntryDoc>);
    const announceChanges = vi.fn(async () => {});
    const result = { status: "completed" };
    const pullPeer = vi.fn(async (_peerId: string) => result);
    const dispatchStatus = vi.fn();
    const reportDiagnostic = vi.fn();
    const targets = new Map<string, PeerNotificationTarget>();
    let disposed = false;
    const relay = createChangeRelay({
        createChangesFeed,
        announceChanges,
        pullPeer,
        dispatchStatus,
        reportDiagnostic,
        hasHost: () => true,
        peerIds: () => [...targets.keys()],
        captureNotificationTarget: (peerId) => targets.get(peerId),
        isDisposed: () => disposed,
    });
    return {
        relay,
        feed,
        targets,
        createChangesFeed,
        announceChanges,
        pullPeer,
        result,
        dispatchStatus,
        reportDiagnostic,
        dispose: () => {
            disposed = true;
        },
    };
}

function target(): PeerNotificationTarget {
    return { isAccepted: vi.fn(async () => true), isCurrent: vi.fn(() => true), send: vi.fn(async () => {}) };
}

describe("standalone change relay operations", () => {
    it("records an opaque change sequence and closes the feed through narrow capabilities", async () => {
        const announceChanges = vi.fn(async () => {});
        const relay = { lastSeq: "" as string | number };
        await onChange({ deps: { announceChanges }, relay }, { seq: "opaque-sequence" });
        expect(relay.lastSeq).toBe("opaque-sequence");
        expect(announceChanges).toHaveBeenCalledOnce();

        const emitter = new EventEmitter();
        const feed = Object.assign(emitter, { cancel: vi.fn() });
        const dispatchStatus = vi.fn();
        const reportDiagnostic = vi.fn();
        const closeState = { changes: feed as unknown as PouchDB.Core.Changes<EntryDoc>, isBroadcasting: true };
        closeChanges({ deps: { dispatchStatus, reportDiagnostic }, relay: closeState }, new Error("feed failed"));

        expect(feed.cancel).toHaveBeenCalledOnce();
        expect(feed.listenerCount("change")).toBe(0);
        expect(closeState).toMatchObject({ changes: undefined, isBroadcasting: false });
        expect(dispatchStatus).toHaveBeenCalledOnce();
        expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
            category: "sync",
            code: "broadcast-disabled",
            reason: "replication-error",
        });
    });

    it("disables broadcasting directly while retaining synchronous completion deduplication", () => {
        const emitter = new EventEmitter();
        const feed = Object.assign(emitter, { cancel: vi.fn() });
        const dispatchStatus = vi.fn();
        const reportDiagnostic = vi.fn();
        const relay = { changes: feed as unknown as PouchDB.Core.Changes<EntryDoc>, isBroadcasting: true };
        feed.cancel.mockImplementation(() => {
            relay.isBroadcasting = false;
        });

        disableBroadcastChanges({ deps: { dispatchStatus, reportDiagnostic }, relay });

        expect(feed.cancel).toHaveBeenCalledOnce();
        expect(relay.isBroadcasting).toBe(false);
        expect(dispatchStatus).toHaveBeenCalledOnce();
        expect(reportDiagnostic).not.toHaveBeenCalled();
    });

    it.each([
        { name: "broadcasting is stopped", isBroadcasting: false, hostAvailable: true, hostChecks: 0 },
        { name: "the host is unavailable", isBroadcasting: true, hostAvailable: false, hostChecks: 1 },
    ])("does not schedule notifications when $name", ({ isBroadcasting, hostAvailable, hostChecks }) => {
        const hasHost = vi.fn(() => hostAvailable);
        const peerIds = vi.fn(() => ["peer"]);
        const notifyPeer = vi.fn(async () => {});

        const result = notifyProgress(
            { deps: { hasHost, peerIds }, relay: { isBroadcasting }, notifyPeerProgress: notifyPeer },
            "excluded-peer"
        );

        expect(result).toBeUndefined();
        expect(hasHost).toHaveBeenCalledTimes(hostChecks);
        expect(peerIds).not.toHaveBeenCalled();
        expect(notifyPeer).not.toHaveBeenCalled();
    });

    it("enables a feed by composing the standalone change and close operations", async () => {
        const emitter = new EventEmitter();
        const feed = Object.assign(emitter, { cancel: vi.fn() });
        const announceChanges = vi.fn(async () => {});
        const dispatchStatus = vi.fn();
        const reportDiagnostic = vi.fn();
        const relay = {
            changes: undefined as PouchDB.Core.Changes<EntryDoc> | undefined,
            isBroadcasting: false,
            lastSeq: "",
        };
        const deps = {
            createChangesFeed: vi.fn(() => feed as unknown as PouchDB.Core.Changes<EntryDoc>),
            dispatchStatus,
            reportDiagnostic,
            announceChanges,
        };

        enableBroadcastChanges({
            deps,
            relay,
            onChange: (change) => onChange({ deps: { announceChanges }, relay }, change),
            closeChanges: (reason) => closeChanges({ deps: { dispatchStatus, reportDiagnostic }, relay }, reason),
        });
        await vi.waitFor(() => expect(announceChanges).toHaveBeenCalledTimes(1));
        feed.emit("change", { seq: "direct-sequence" });
        await vi.waitFor(() => expect(announceChanges).toHaveBeenCalledTimes(2));
        expect(relay.lastSeq).toBe("direct-sequence");
        feed.emit("complete");
        expect(relay).toMatchObject({ changes: undefined, isBroadcasting: false });
        expect(reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
            "broadcast-enabled",
            "broadcast-disabled",
        ]);
    });

    it("schedules peer notification through the bound operation and sends with only target capabilities", async () => {
        const notifyPeer = vi.fn(async (_peerId: string) => {});
        const scheduled = notifyProgress(
            {
                deps: { hasHost: () => true, peerIds: () => ["standalone-excluded", "standalone-sent"] },
                relay: { isBroadcasting: true },
                notifyPeerProgress: notifyPeer,
            },
            "standalone-excluded"
        );

        expect(scheduled).toBeInstanceOf(Promise);
        await scheduled;
        await vi.waitFor(() => expect(notifyPeer).toHaveBeenCalledExactlyOnceWith("standalone-sent"));

        const peer = target();
        const reportDiagnostic = vi.fn();
        const dependencies = {
            captureNotificationTarget: vi.fn(() => peer),
            isDisposed: vi.fn(() => false),
            reportDiagnostic,
        };
        await notifyPeerProgress({ deps: dependencies, relay: { isBroadcasting: true } }, "standalone-sent");
        expect(peer.send).toHaveBeenCalledOnce();
        expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith({
            category: "sync",
            code: "change-notification-sent",
            peerId: "standalone-sent",
        });
    });

    it("uses only the watched set and operation-specific capabilities for pulls", async () => {
        const watchingPeers = new Set<string>();
        const dispatchStatus = vi.fn();
        const reportDiagnostic = vi.fn();
        const watchDeps = { dispatchStatus, reportDiagnostic };
        watchPeer({ deps: watchDeps, relay: { watchingPeers } }, "standalone-watched");

        const result = { status: "completed" };
        const pullPeer = vi.fn(async () => result);
        const pullDeps = { pullPeer, reportDiagnostic };
        expect(await onUpdateDatabase({ deps: pullDeps, relay: { watchingPeers } }, "standalone-watched")).toBe(result);
        unwatchPeer({ deps: watchDeps, relay: { watchingPeers } }, "standalone-watched");
        expect(await onUpdateDatabase({ deps: pullDeps, relay: { watchingPeers } }, "standalone-watched")).toBe(false);

        expect(pullPeer).toHaveBeenCalledExactlyOnceWith("standalone-watched");
        expect(dispatchStatus).toHaveBeenCalledTimes(2);
        expect(reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
            "watch-enabled",
            "change-notification-received",
            "watch-disabled",
            "change-notification-ignored",
        ]);
    });
});

describe("room-local change relay", () => {
    it("preserves the dependency object receiver when binding relay operations", async () => {
        const deps = {
            hostAvailable: true,
            peerIdsValue: [] as string[],
            createChangesFeed: vi.fn(() => {
                throw new Error("The changes feed is not used in this test");
            }),
            hasHost() {
                return this.hostAvailable;
            },
            peerIds() {
                return this.peerIdsValue;
            },
            captureNotificationTarget: vi.fn(() => undefined),
            isDisposed: vi.fn(() => false),
            announceChanges: vi.fn(),
            pullPeer: vi.fn(async () => undefined),
            dispatchStatus: vi.fn(),
            reportDiagnostic: vi.fn(),
        };
        const relay = createChangeRelay(deps);
        relay.isBroadcasting = true;

        const scheduled = relay.notifyProgress();

        expect(scheduled).toBeInstanceOf(Promise);
        await scheduled;
    });

    it("creates its own empty state without starting database or transport work", () => {
        const h = createHarness();
        expect(h.relay.isBroadcasting).toBe(false);
        expect(h.relay.watchingPeers.size).toBe(0);
        expect(h.relay.lastSeq).toBe("");
        expect(h.createChangesFeed).not.toHaveBeenCalled();
        expect(h.announceChanges).not.toHaveBeenCalled();
        expect(h.pullPeer).not.toHaveBeenCalled();
    });

    it("starts one feed and announces both its start and an opaque sequence change", async () => {
        const h = createHarness();
        h.relay.enableBroadcastChanges();
        h.relay.enableBroadcastChanges();
        await vi.waitFor(() => expect(h.announceChanges).toHaveBeenCalledTimes(1));
        expect(h.createChangesFeed).toHaveBeenCalledExactlyOnceWith({
            since: "now",
            live: true,
            include_docs: false,
            selector: { _id: { $gt: "_local/" } },
        });
        h.feed.emit("change", { seq: "7-opaque" });
        expect(h.relay.lastSeq).toBe("7-opaque");
        await vi.waitFor(() => expect(h.announceChanges).toHaveBeenCalledTimes(2));
        expect(h.relay.changes).toBe(h.feed);
    });

    it("cleans up a failed feed and reports one terminal transition", () => {
        const h = createHarness();
        h.relay.enableBroadcastChanges();
        const complete = h.feed.listeners("complete")[0];
        h.feed.emit("error", new Error("feed failed"));
        complete();
        expect(h.relay.changes).toBeUndefined();
        expect(h.relay.isBroadcasting).toBe(false);
        expect(h.feed.listenerCount("change")).toBe(0);
        expect(h.reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
            "broadcast-enabled",
            "broadcast-disabled",
        ]);
        expect(h.reportDiagnostic).toHaveBeenLastCalledWith({
            category: "sync",
            code: "broadcast-disabled",
            reason: "replication-error",
        });
    });

    it("cleans up a normally completed feed without reporting an error reason", () => {
        const h = createHarness();
        h.relay.enableBroadcastChanges();

        h.feed.emit("complete", { status: "complete" });

        expect(h.relay.changes).toBeUndefined();
        expect(h.relay.isBroadcasting).toBe(false);
        expect(h.feed.listenerCount("change")).toBe(0);
        expect(h.reportDiagnostic).toHaveBeenLastCalledWith({
            category: "sync",
            code: "broadcast-disabled",
        });
    });

    it("replaces a retained feed when broadcasting is enabled again", () => {
        const createFeed = () => {
            const emitter = new EventEmitter();
            return Object.assign(emitter, { cancel: vi.fn() });
        };
        const previousFeed = createFeed();
        const replacementFeed = createFeed();
        const feeds = [previousFeed, replacementFeed];
        const createChangesFeed = vi.fn(() => feeds.shift() as unknown as PouchDB.Core.Changes<EntryDoc>);
        const dispatchStatus = vi.fn();
        const reportDiagnostic = vi.fn();
        const announceChanges = vi.fn(async () => {});
        const relay = {
            changes: undefined as PouchDB.Core.Changes<EntryDoc> | undefined,
            isBroadcasting: false,
        };
        const deps = { createChangesFeed, dispatchStatus, reportDiagnostic, announceChanges };
        const enable = () =>
            enableBroadcastChanges({
                deps,
                relay,
                onChange: async () => {},
                closeChanges: () => {},
            });

        enable();
        disableBroadcastChanges({ deps, relay });
        expect(relay.changes).toBe(previousFeed);

        enable();

        expect(createChangesFeed).toHaveBeenCalledTimes(2);
        expect(previousFeed.cancel).toHaveBeenCalledTimes(2);
        expect(previousFeed.listenerCount("change")).toBe(0);
        expect(relay.changes).toBe(replacementFeed);
        expect(replacementFeed.listenerCount("change")).toBe(1);
    });

    it("does not duplicate the disable diagnostic when cancellation completes synchronously", () => {
        const h = createHarness();
        let cancelled = false;
        h.feed.cancel.mockImplementation(() => {
            if (!cancelled) {
                cancelled = true;
                h.feed.emit("complete");
            }
        });
        h.relay.enableBroadcastChanges();
        h.relay.disableBroadcastChanges();
        expect(h.relay.isBroadcasting).toBe(false);
        expect(h.relay.changes).toBeUndefined();
        expect(h.reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
            "broadcast-enabled",
            "broadcast-disabled",
        ]);
    });

    it("only pulls watched peers and reports changes in the watch policy once", async () => {
        const h = createHarness();
        expect(await h.relay.onUpdateDatabase("not-watched")).toBe(false);
        expect(h.pullPeer).not.toHaveBeenCalled();
        h.relay.watchPeer("watched");
        h.relay.watchPeer("watched");
        expect(await h.relay.onUpdateDatabase("watched")).toBe(h.result);
        h.relay.unwatchPeer("watched");
        h.relay.unwatchPeer("watched");
        expect(h.pullPeer).toHaveBeenCalledExactlyOnceWith("watched");
        expect(h.reportDiagnostic.mock.calls.filter(([event]) => event.code === "watch-enabled")).toHaveLength(1);
        expect(h.reportDiagnostic.mock.calls.filter(([event]) => event.code === "watch-disabled")).toHaveLength(1);
    });

    it("serialises received notifications for one peer without changing their results", async () => {
        const h = createHarness();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.pullPeer.mockImplementationOnce(async () => {
            await held;
            return h.result;
        });
        h.relay.watchPeer("serial-receiver");
        const first = h.relay.onUpdateDatabase("serial-receiver");
        const second = h.relay.onUpdateDatabase("serial-receiver");
        try {
            await vi.waitFor(() => expect(h.pullPeer).toHaveBeenCalledTimes(1));
            release();
            expect(await first).toBe(h.result);
            expect(await second).toBe(h.result);
            expect(h.pullPeer).toHaveBeenCalledTimes(2);
        } finally {
            release();
            await Promise.allSettled([first, second]);
        }
    });

    it("excludes the source peer and skips an unaccepted notification target", async () => {
        const h = createHarness();
        const source = target();
        const allowed = target();
        const denied = target();
        vi.mocked(denied.isAccepted).mockResolvedValue(false);
        h.targets.set("source", source);
        h.targets.set("allowed", allowed);
        h.targets.set("denied", denied);
        h.relay.isBroadcasting = true;
        await h.relay.notifyProgress("source");
        await vi.waitFor(() => expect(allowed.send).toHaveBeenCalledTimes(1));
        expect(source.isAccepted).not.toHaveBeenCalled();
        expect(denied.send).not.toHaveBeenCalled();
        expect(h.reportDiagnostic).toHaveBeenCalledWith({
            category: "sync",
            code: "change-notification-ignored",
            peerId: "denied",
            reason: "not-accepted",
        });
    });

    it.each(["the target is missing", "the room is disposed", "broadcasting is stopped"] as const)(
        "does not admit a notification when %s",
        async (condition) => {
            const peer = target();
            const captureNotificationTarget = vi.fn(() => (condition === "the target is missing" ? undefined : peer));
            const isDisposed = vi.fn(() => condition === "the room is disposed");
            const reportDiagnostic = vi.fn();

            await notifyPeerProgress(
                {
                    deps: { captureNotificationTarget, isDisposed, reportDiagnostic },
                    relay: { isBroadcasting: condition !== "broadcasting is stopped" },
                },
                "early-return"
            );

            expect(captureNotificationTarget).toHaveBeenCalledExactlyOnceWith("early-return");
            expect(peer.isAccepted).not.toHaveBeenCalled();
            expect(peer.send).not.toHaveBeenCalled();
            expect(reportDiagnostic).not.toHaveBeenCalled();
            expect(isDisposed).toHaveBeenCalledTimes(condition === "the target is missing" ? 0 : 1);
        }
    );

    it("reports a failed send without leaking transport details", async () => {
        const h = createHarness();
        const peer = target();
        const error = new Error("private transport detail");
        vi.mocked(peer.send).mockRejectedValue(error);
        h.targets.set("failed-send", peer);
        h.relay.isBroadcasting = true;

        await h.relay.notifyProgress();
        await vi.waitFor(() =>
            expect(h.reportDiagnostic).toHaveBeenCalledWith(
                expect.objectContaining({
                    category: "sync",
                    code: "change-notification-error",
                    peerId: "failed-send",
                })
            )
        );

        expect(h.reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual(["change-notification-error"]);
        expect(JSON.stringify(h.reportDiagnostic.mock.calls)).not.toContain("private transport detail");
    });

    it.each(["broadcast", "target", "disposed"] as const)(
        "suppresses a send when %s changes during admission",
        async (change) => {
            const h = createHarness();
            const peer = target();
            let accept!: (accepted: boolean) => void;
            vi.mocked(peer.isAccepted).mockImplementation(
                () =>
                    new Promise<boolean>((resolve) => {
                        accept = resolve;
                    })
            );
            h.targets.set(`lifecycle-${change}`, peer);
            h.relay.isBroadcasting = true;
            await h.relay.notifyProgress();
            await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
            if (change === "broadcast") {
                h.relay.disableBroadcastChanges();
            }
            if (change === "target") {
                vi.mocked(peer.isCurrent).mockReturnValue(false);
            }
            if (change === "disposed") {
                h.dispose();
            }
            accept(true);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(peer.send).not.toHaveBeenCalled();
        }
    );
});

it("uses the current watching set after the facade replaces it", async () => {
    const h = createHarness();
    const previous = h.relay.watchingPeers;
    const replacement = new Set(["replacement-peer"]);
    h.relay.watchingPeers = replacement;
    expect(await h.relay.onUpdateDatabase("replacement-peer")).toBe(h.result);
    h.relay.watchPeer("added-peer");
    expect(replacement.has("added-peer")).toBe(true);
    h.relay.unwatchPeer("replacement-peer");
    expect(replacement.has("replacement-peer")).toBe(false);
    expect(previous.size).toBe(0);
});
