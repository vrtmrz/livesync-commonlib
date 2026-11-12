import { EventEmitter } from "node:events";
import type PouchDB from "pouchdb-core";
import { describe, expect, it, vi } from "vitest";
import type { EntryDoc } from "@lib/common/types";
import { createChangeRelay, type PeerNotificationTarget } from "./changeRelay";

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

describe("room-local change relay", () => {
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
