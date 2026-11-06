import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import { createP2PDiagnosticStore, reportP2PDiagnostic, EVENT_P2P_DIAGNOSTIC } from "./p2pDiagnostics";

afterEach(() => vi.restoreAllMocks());

describe("context-owned P2P diagnostics", () => {
    it("distinguishes unobserved categories and retains a departed peer without a peer row", () => {
        const events = createLiveSyncEventHub();
        const store = createP2PDiagnosticStore(events);
        expect(store.getSnapshot()).toEqual({});
        const observer = vi.fn();
        const channel = vi.fn();
        store.subscribe(observer);
        events.onEvent(EVENT_P2P_DIAGNOSTIC, channel);
        const event = { category: "peer", code: "peer-left", peerId: "peer-a", timestamp: 0 } as const;
        store.record(event);
        expect(store.getSnapshot()).toEqual({ peer: event });
        expect(observer).toHaveBeenCalledExactlyOnceWith(event);
        expect(channel).toHaveBeenCalledExactlyOnceWith(event);
        expect(Object.isFrozen(store.getSnapshot())).toBe(true);
        expect(Object.isFrozen(store.getSnapshot().peer)).toBe(true);
        store.dispose();
    });

    it("isolates contexts, projects only safe event fields, and contains subscriber failures", () => {
        const events = createLiveSyncEventHub();
        const otherEvents = createLiveSyncEventHub();
        const store = createP2PDiagnosticStore(events);
        const otherStore = createP2PDiagnosticStore(otherEvents);
        store.subscribe(() => {
            throw new Error("observer failed");
        });
        const observer = vi.fn();
        store.subscribe(observer);
        const otherChannel = vi.fn();
        otherEvents.onEvent(EVENT_P2P_DIAGNOSTIC, otherChannel);
        expect(() =>
            store.record({
                category: "relay",
                code: "room-opened",
                timestamp: 50,
                reason: "relay-details-unobserved",
                settings: { secret: "private" },
                message: "raw error",
            } as any)
        ).not.toThrow();
        expect(observer).toHaveBeenCalledOnce();
        expect(store.getSnapshot()).toEqual({
            relay: {
                category: "relay",
                code: "room-opened",
                timestamp: 50,
                reason: "relay-details-unobserved",
            },
        });
        expect(otherStore.getSnapshot()).toEqual({});
        expect(otherChannel).not.toHaveBeenCalled();
        store.dispose();
        otherStore.dispose();
    });

    it("unsubscribes independently and disposes collection on platform unload", () => {
        const events = createLiveSyncEventHub();
        const store = createP2PDiagnosticStore(events);
        const observer = vi.fn();
        const channel = vi.fn();
        const unsubscribe = store.subscribe(observer);
        events.onEvent(EVENT_P2P_DIAGNOSTIC, channel);
        unsubscribe();
        store.record({ category: "sync", code: "pull-completed", timestamp: 1 });
        expect(observer).not.toHaveBeenCalled();
        expect(channel).toHaveBeenCalledOnce();
        events.emitEvent(EVENT_PLATFORM_UNLOADED);
        const snapshot = store.getSnapshot();
        store.record({ category: "peer", code: "peer-left", timestamp: 2 });
        expect(store.getSnapshot()).toBe(snapshot);
        expect(channel).toHaveBeenCalledOnce();
    });

    it("captures timestamps at source and contains a throwing reporter", () => {
        vi.spyOn(Date, "now").mockReturnValue(1234);
        const report = vi.fn();
        reportP2PDiagnostic(report, { category: "sync", code: "pull-started", peerId: "peer-a" });
        expect(report).toHaveBeenCalledExactlyOnceWith({
            category: "sync",
            code: "pull-started",
            peerId: "peer-a",
            timestamp: 1234,
        });
        expect(() =>
            reportP2PDiagnostic(
                () => {
                    throw new Error("observer failed");
                },
                {
                    category: "sync",
                    code: "pull-started",
                }
            )
        ).not.toThrow();
    });
});
