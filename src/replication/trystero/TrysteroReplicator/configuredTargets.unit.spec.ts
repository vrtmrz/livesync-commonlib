import { describe, expect, it, vi } from "vitest";
import type { P2PSyncSetting } from "@lib/common/types";
import type { MessageTranslator } from "@lib/services/base/MessageTranslator";
import type { P2PPeerAcceptance } from "../TrysteroReplicatorP2PServer";
import type { Advertisement } from "../types";
import type { TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import {
    createConfiguredTargets,
    type ConfiguredTargetsDependencies,
    type P2PConfiguredReplicationResult,
} from "./configuredTargets";
import type { P2PReplicationResult } from "./transfers";

const completed: P2PReplicationResult = { status: "completed", ok: true };

function settings(names: string, enabled = true): P2PSyncSetting {
    return {
        P2P_Enabled: enabled,
        P2P_SyncOnReplication: names,
    } as P2PSyncSetting;
}

interface PendingTimeout {
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
}

function createHarness(
    options: {
        names?: string;
        enabled?: boolean;
        advertisements?: readonly Advertisement[];
    } = {}
) {
    let currentAdvertisements = [...(options.advertisements ?? [])];
    const listeners = new Set<() => void>();
    const pendingTimeouts: PendingTimeout[] = [];
    const subscriptions: ReturnType<typeof vi.fn<() => void>>[] = [];
    const currentSettings = vi.fn(() => settings(options.names ?? "peer-a", options.enabled));
    const advertisements = vi.fn(() => currentAdvertisements);
    const evaluatePeerAcceptance = vi.fn<ConfiguredTargetsDependencies["evaluatePeerAcceptance"]>(
        async () => "accepted"
    );
    const runBaseline = vi.fn<ConfiguredTargetsDependencies["runBaseline"]>(async (_peerName, task) => await task());
    const sync = vi.fn<ConfiguredTargetsDependencies["sync"]>(async () => completed);
    const onAdvertisement = vi.fn<ConfiguredTargetsDependencies["onAdvertisement"]>((listener) => {
        listeners.add(listener);
        const detach = vi.fn(() => {
            listeners.delete(listener);
        });
        subscriptions.push(detach);
        return detach;
    });
    const scheduleTimeout = vi.fn<TimeoutScheduler>((callback, delayMs) => {
        const timeout = { callback, delayMs, cancelled: false };
        pendingTimeouts.push(timeout);
        return () => {
            timeout.cancelled = true;
        };
    });
    const translate = vi.fn<MessageTranslator>((key) => key);
    const deps: ConfiguredTargetsDependencies = {
        currentSettings,
        advertisements,
        evaluatePeerAcceptance,
        runBaseline,
        sync,
        onAdvertisement,
        scheduleTimeout,
        translate,
    };

    return {
        target: createConfiguredTargets(deps),
        currentSettings,
        advertisements,
        evaluatePeerAcceptance,
        runBaseline,
        sync,
        onAdvertisement,
        scheduleTimeout,
        translate,
        pendingTimeouts,
        subscriptions,
        replaceAdvertisements(next: readonly Advertisement[]) {
            currentAdvertisements = [...next];
        },
        emitAdvertisement() {
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
}

function advertised(name: string): Advertisement {
    return { peerId: `id-${name}`, name, platform: "test" };
}

describe("createConfiguredTargets", () => {
    it("does not read settings or start discovery while constructing the operation", () => {
        const harness = createHarness();

        expect(harness.currentSettings).not.toHaveBeenCalled();
        expect(harness.advertisements).not.toHaveBeenCalled();
        expect(harness.onAdvertisement).not.toHaveBeenCalled();
        expect(harness.scheduleTimeout).not.toHaveBeenCalled();
    });

    it("reads current enablement and target policy separately, then fixes the target-name snapshot", async () => {
        const peer = advertised("peer-a");
        const harness = createHarness({ advertisements: [peer] });
        harness.currentSettings
            .mockImplementationOnce(() => settings("unused"))
            .mockImplementationOnce(() => settings(" peer-a , peer-a, ,peer-b "));

        const operation = harness.target.replicateFromCommand(true, 0);
        harness.currentSettings.mockImplementation(() => settings("peer-c"));
        harness.replaceAdvertisements([peer, advertised("peer-b")]);

        const result = await operation;

        expect(harness.currentSettings).toHaveBeenCalledTimes(2);
        expect(harness.evaluatePeerAcceptance).toHaveBeenCalledTimes(2);
        expect(harness.sync).toHaveBeenNthCalledWith(1, "id-peer-a", true, undefined);
        expect(harness.sync).toHaveBeenNthCalledWith(2, "id-peer-b", true, undefined);
        expect(result).toEqual({
            status: "completed",
            targets: [
                { name: "peer-a", peerId: "id-peer-a", status: "completed" },
                { name: "peer-b", peerId: "id-peer-b", status: "completed" },
            ],
        });
    });

    it("does not wait when every configured advertisement is already present or the timeout is non-positive", async () => {
        const cases = [
            {
                name: "advertisements are already present",
                ads: [advertised("peer-a")],
                timeoutMs: 5000,
            },
            { name: "the timeout is non-positive", ads: [], timeoutMs: 0 },
        ] as const;

        for (const testCase of cases) {
            const harness = createHarness({ advertisements: testCase.ads });
            const result = await harness.target.replicateFromCommand(false, testCase.timeoutMs);

            expect(harness.onAdvertisement, testCase.name).not.toHaveBeenCalled();
            expect(harness.scheduleTimeout, testCase.name).not.toHaveBeenCalled();
            expect(result.status).toBe(testCase.ads.length > 0 ? "completed" : "partial");
        }
    });

    it("registers before waiting and removes the event, abort, and timeout hooks before continuing", async () => {
        const peer = advertised("peer-a");
        const harness = createHarness({ advertisements: [] });
        const controller = new AbortController();
        const addAbort = vi.spyOn(controller.signal, "addEventListener");
        const removeAbort = vi.spyOn(controller.signal, "removeEventListener");

        const operation = harness.target.replicateFromCommand(true, 125, controller.signal);
        expect(harness.onAdvertisement).toHaveBeenCalledOnce();
        expect(harness.scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 125);
        expect(addAbort).toHaveBeenCalledWith("abort", expect.any(Function), {
            once: true,
        });

        harness.replaceAdvertisements([peer]);
        harness.emitAdvertisement();

        await expect(operation).resolves.toEqual({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "id-peer-a", status: "completed" }],
        });
        expect(harness.subscriptions[0]).toHaveBeenCalledOnce();
        expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(harness.pendingTimeouts[0]?.cancelled).toBe(true);
        expect(harness.subscriptions[0]?.mock.invocationCallOrder[0]).toBeLessThan(
            harness.evaluatePeerAcceptance.mock.invocationCallOrder[0]!
        );
    });

    it("rechecks after subscription so a synchronous advertisement cannot leak its listener", async () => {
        const peer = advertised("peer-a");
        const harness = createHarness({ advertisements: [] });
        const detach = vi.fn();
        harness.onAdvertisement.mockImplementation((listener) => {
            harness.replaceAdvertisements([peer]);
            listener();
            return detach;
        });

        await expect(harness.target.replicateFromCommand(false, 5000)).resolves.toMatchObject({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "id-peer-a", status: "completed" }],
        });
        expect(harness.scheduleTimeout).toHaveBeenCalledOnce();
        expect(detach).toHaveBeenCalledOnce();
        expect(harness.pendingTimeouts[0]?.cancelled).toBe(true);
        expect(detach.mock.invocationCallOrder[0]).toBeLessThan(
            harness.evaluatePeerAcceptance.mock.invocationCallOrder[0]!
        );
    });

    it("classifies remaining targets after discovery times out", async () => {
        const harness = createHarness({
            names: "peer-a,peer-b",
            advertisements: [],
        });
        const operation = harness.target.replicateFromCommand(false, 50);

        harness.pendingTimeouts[0]?.callback();

        await expect(operation).resolves.toEqual({
            status: "partial",
            targets: [
                { name: "peer-a", status: "missing" },
                { name: "peer-b", status: "missing" },
            ],
        });
        expect(harness.pendingTimeouts[0]?.cancelled).toBe(true);
    });

    it("returns one cancelled target for each configured name when the caller aborts during discovery", async () => {
        const harness = createHarness({
            names: "peer-a,peer-b",
            advertisements: [],
        });
        const controller = new AbortController();
        const operation = harness.target.replicateFromCommand(false, 5000, controller.signal);

        controller.abort();

        await expect(operation).resolves.toEqual({
            status: "cancelled",
            targets: [
                { name: "peer-a", status: "cancelled" },
                { name: "peer-b", status: "cancelled" },
            ],
        });
        expect(harness.pendingTimeouts[0]?.cancelled).toBe(true);
        expect(harness.evaluatePeerAcceptance).not.toHaveBeenCalled();
    });

    it("runs admitted targets sequentially through the baseline owner and forwards the original signal", async () => {
        const peers = [advertised("peer-a"), advertised("peer-b")];
        const harness = createHarness({
            names: "peer-a,peer-b",
            advertisements: peers,
        });
        const controller = new AbortController();
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        harness.sync.mockImplementation(async (peerId, showResult, signal) => {
            if (peerId === "id-peer-a") {
                markFirstStarted();
                expect(showResult).toBe(true);
                expect(signal).toBe(controller.signal);
                await firstGate;
            }
            return completed;
        });

        const operation = harness.target.replicateFromCommand(true, 0, controller.signal);
        await firstStarted;

        expect(harness.evaluatePeerAcceptance).toHaveBeenCalledTimes(1);
        expect(harness.runBaseline).toHaveBeenCalledTimes(1);
        expect(harness.sync).toHaveBeenCalledTimes(1);
        expect(harness.runBaseline.mock.calls[0]?.[0]).toBe("peer-a");

        releaseFirst();
        await expect(operation).resolves.toMatchObject({
            status: "completed",
            targets: [
                { name: "peer-a", status: "completed" },
                { name: "peer-b", status: "completed" },
            ],
        });
        expect(harness.runBaseline.mock.calls.map(([name]) => name)).toEqual(["peer-a", "peer-b"]);
        expect(harness.sync.mock.calls.map(([peerId]) => peerId)).toEqual(["id-peer-a", "id-peer-b"]);
    });

    it("returns partial when cancellation follows one completed target", async () => {
        const peers = [advertised("peer-a"), advertised("peer-b")];
        const harness = createHarness({
            names: "peer-a,peer-b",
            advertisements: peers,
        });
        const controller = new AbortController();
        harness.sync.mockImplementation(async (peerId) => {
            if (peerId === "id-peer-a") {
                controller.abort();
            }
            return completed;
        });

        await expect(harness.target.replicateFromCommand(false, 0, controller.signal)).resolves.toEqual({
            status: "partial",
            targets: [
                { name: "peer-a", peerId: "id-peer-a", status: "completed" },
                { name: "peer-b", status: "cancelled" },
            ],
        });
        expect(harness.evaluatePeerAcceptance).toHaveBeenCalledOnce();
    });

    it("preserves missing, denied, undecided, failed, and cancelled target outcomes", async () => {
        const names = ["completed", "failed", "cancelled", "offline", "rejected", "undecided", "unknown"];
        const peers = names.filter((name) => name !== "offline").map(advertised);
        const harness = createHarness({
            names: names.join(","),
            advertisements: peers,
        });
        const decisions: Record<string, P2PPeerAcceptance | undefined> = {
            "id-rejected": "rejected",
            "id-undecided": "undecided",
            "id-unknown": undefined,
        };
        harness.evaluatePeerAcceptance.mockImplementation(async (peerId) => {
            if (peerId in decisions) {
                return decisions[peerId];
            }
            return "accepted";
        });
        const failure = new Error("pull failed");
        harness.sync.mockImplementation(async (peerId) => {
            if (peerId === "id-failed") {
                return { status: "failed", error: failure };
            }
            if (peerId === "id-cancelled") {
                return { status: "cancelled" };
            }
            return completed;
        });

        const result = await harness.target.replicateFromCommand(false, 0);

        expect(result).toEqual({
            status: "partial",
            targets: [
                { name: "completed", peerId: "id-completed", status: "completed" },
                {
                    name: "failed",
                    peerId: "id-failed",
                    status: "failed",
                    error: failure,
                },
                { name: "cancelled", peerId: "id-cancelled", status: "cancelled" },
                { name: "offline", status: "missing" },
                { name: "rejected", peerId: "id-rejected", status: "rejected" },
                { name: "undecided", peerId: "id-undecided", status: "undecided" },
                { name: "unknown", peerId: "id-unknown", status: "missing" },
            ],
        });
        expect(harness.sync).toHaveBeenCalledTimes(3);
    });

    it("returns blocked when P2P is disabled without reading target policy", async () => {
        const harness = createHarness({ enabled: false, names: "peer-a" });

        const result = await harness.target.replicateFromCommand(true);

        expect(result).toEqual({
            status: "blocked",
            reason: "no-targets",
            targets: [],
        });
        expect(harness.currentSettings).toHaveBeenCalledOnce();
        expect(harness.onAdvertisement).not.toHaveBeenCalled();
        expect(harness.translate).toHaveBeenCalledWith("P2P.NotEnabled");
    });

    it("propagates admission and baseline errors unchanged", async () => {
        const peer = advertised("peer-a");
        const harness = createHarness({ advertisements: [peer] });
        const failure = new Error("admission failed");
        harness.evaluatePeerAcceptance.mockRejectedValueOnce(failure);

        await expect(harness.target.replicateFromCommand(false, 0)).rejects.toBe(failure);
        expect(harness.sync).not.toHaveBeenCalled();

        const baselineFailure = new Error("sync failed");
        harness.evaluatePeerAcceptance.mockResolvedValue("accepted");
        harness.sync.mockRejectedValue(baselineFailure);

        await expect(harness.target.replicateFromCommand(false, 0)).rejects.toBe(baselineFailure);
    });
});
