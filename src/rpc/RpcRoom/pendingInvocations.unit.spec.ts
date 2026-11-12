import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    cancelPendingInvocation,
    closePendingInvocations,
    createPendingInvocations,
    invokePendingInvocation,
    notifyRemoteCancellation,
    receivePendingResponse,
    registerPendingWait,
    rejectPending,
    rejectPendingForPeerDeparture,
    removePending,
} from "./pendingInvocations";
import { RpcError } from "../errors";
import type { TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import type { JsonLike, RpcEnvelope } from "../types";

type PendingInvocation = NonNullable<ReturnType<typeof removePending>>;

type SentEnvelope = {
    envelope: RpcEnvelope;
    peerId: string;
};

const scheduleTimeout: TimeoutScheduler = (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(handle);
};

function createHarness() {
    const sent: SentEnvelope[] = [];
    const warnings: Array<{ message: string; peerId: string }> = [];
    let requestCompletion: Promise<void> | undefined;
    let cancelFailure: unknown;
    let nextId = 0;
    const invocations = createPendingInvocations({
        sendEnvelope: async (peerId, envelope) => {
            sent.push({ envelope, peerId });
            if (envelope.kind === "request" && requestCompletion) {
                await requestCompletion;
            }
            if (envelope.kind === "cancel" && cancelFailure !== undefined) {
                throw cancelFailure;
            }
        },
        createRequestId: () => `req-${++nextId}`,
        scheduleTimeout,
        onProtocolWarning: (message, peerId) => warnings.push({ message, peerId }),
    });

    function request(index = 0) {
        const entry = sent.filter(({ envelope }) => envelope.kind === "request")[index];
        if (!entry || entry.envelope.kind !== "request") {
            throw new Error("Expected a request envelope");
        }
        return { ...entry.envelope, peerId: entry.peerId };
    }

    return {
        invocations,
        sent,
        warnings,
        request,
        setRequestCompletion: (completion: Promise<void>) => {
            requestCompletion = completion;
        },
        setCancelFailure: (failure: unknown) => {
            cancelFailure = failure;
        },
    };
}

const endings = [
    "response",
    "remote-error",
    "timeout",
    "abort",
    "cancel",
    "send-failure",
    "peer-leave",
    "close",
] as const;

function createPendingRecord(overrides: Partial<PendingInvocation> = {}): PendingInvocation {
    return {
        peerId: "peer-a",
        resolve: (_value: JsonLike) => undefined,
        reject: (_reason?: unknown) => undefined,
        releaseWait: () => undefined,
        requestSent: false,
        cancelRequested: false,
        ...overrides,
    };
}

describe("pending invocation operations", () => {
    it("removes and releases one wait when called directly with only pending state", () => {
        const releaseWait = vi.fn();
        const record = createPendingRecord({ releaseWait });
        const pending = new Map([["req-1", record]]);

        expect(removePending({ pending }, "req-1")).toBe(record);
        expect(pending.has("req-1")).toBe(false);
        expect(releaseWait).toHaveBeenCalledOnce();
        expect(removePending({ pending }, "missing")).toBeUndefined();
    });

    it("sends direct cancellation and reports background send failures using only sender capabilities", async () => {
        const failure = new Error("Cancel failed");
        const sent: SentEnvelope[] = [];
        const warnings: Array<{ message: string; peerId: string }> = [];
        const sendEnvelope = async (peerId: string, envelope: RpcEnvelope) => {
            sent.push({ peerId, envelope });
            throw failure;
        };
        const onProtocolWarning = (message: string, peerId: string) => warnings.push({ message, peerId });

        notifyRemoteCancellation({ sendEnvelope, onProtocolWarning }, "peer-a", "req-1");
        await Promise.resolve();

        expect(sent).toEqual([{ peerId: "peer-a", envelope: { kind: "cancel", requestId: "req-1" } }]);
        expect(warnings).toEqual([
            { message: "Failed to send RPC cancellation: Error: Cancel failed", peerId: "peer-a" },
        ]);
    });

    it("releases and rejects before directly notifying the remote peer", () => {
        const order: string[] = [];
        const record = createPendingRecord({
            requestSent: true,
            releaseWait: () => {
                order.push("release");
            },
            reject: () => {
                order.push("reject");
            },
        });
        const pending = new Map([["req-1", record]]);
        const removeOperation: Parameters<typeof rejectPending>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);
        const notifyOperation: Parameters<typeof rejectPending>[0]["notifyRemoteCancellation"] = (
            peerId,
            requestId
        ) => {
            order.push("cancel:" + peerId + ":" + requestId);
        };

        rejectPending(
            { pending, removePending: removeOperation, notifyRemoteCancellation: notifyOperation },
            "req-1",
            new RpcError("CANCELLED", "Invocation cancelled"),
            true
        );

        expect(record.cancelRequested).toBe(true);
        expect(pending.size).toBe(0);
        expect(order).toEqual(["release", "reject", "cancel:peer-a:req-1"]);
    });

    it("registers a wait and its abort listener directly from its minimal context", () => {
        const controller = new AbortController();
        const pending = new Map<string, PendingInvocation>();
        const timeoutRelease = vi.fn();
        const scheduledDelays: number[] = [];
        const rejectionCalls: Array<{ requestId: string; error: RpcError; notifyRemote?: boolean }> = [];
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const removeOperation: Parameters<typeof rejectPending>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);
        const notifyOperation: Parameters<typeof rejectPending>[0]["notifyRemoteCancellation"] = () => undefined;
        const rejectOperation: Parameters<typeof registerPendingWait>[0]["rejectPending"] = (
            requestId,
            error,
            notifyRemote
        ) => {
            rejectionCalls.push({ requestId, error, notifyRemote });
            rejectPending(
                { pending, removePending: removeOperation, notifyRemoteCancellation: notifyOperation },
                requestId,
                error,
                notifyRemote
            );
        };
        const created: PendingInvocation[] = [];
        const scheduler: TimeoutScheduler = (callback, delayMs) => {
            expect(created).toHaveLength(1);
            scheduledDelays.push(delayMs);
            return timeoutRelease;
        };

        registerPendingWait(
            { pending, scheduleTimeout: scheduler, rejectPending: rejectOperation },
            "req-1",
            "peer-a",
            "job.run",
            { signal: controller.signal },
            25,
            (invocation) => {
                expect(pending.has("req-1")).toBe(false);
                created.push(invocation);
            },
            () => undefined,
            () => undefined
        );

        expect(pending.get("req-1")).toBe(created[0]);
        expect(scheduledDelays).toEqual([25]);
        controller.abort();
        expect(rejectionCalls).toHaveLength(1);
        expect(rejectionCalls[0]).toMatchObject({
            requestId: "req-1",
            error: { code: "CANCELLED" },
            notifyRemote: true,
        });
        expect(pending.size).toBe(0);
        expect(removed).toHaveBeenCalledOnce();
        expect(timeoutRelease).toHaveBeenCalledOnce();
    });

    it("invokes directly with pending state and callback capabilities", async () => {
        const pending = new Map<string, PendingInvocation>();
        const sent: SentEnvelope[] = [];
        const sendEnvelope = async (peerId: string, envelope: RpcEnvelope) => {
            sent.push({ peerId, envelope });
        };
        const scheduleTimeout: TimeoutScheduler = (_callback, _delayMs) => () => undefined;
        const removeOperation: Parameters<typeof rejectPending>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);
        const notifications: string[] = [];
        const notifyOperation: Parameters<typeof rejectPending>[0]["notifyRemoteCancellation"] = (
            peerId,
            requestId
        ) => {
            notifications.push(peerId + ":" + requestId);
        };
        const rejectOperation: Parameters<typeof registerPendingWait>[0]["rejectPending"] = (
            requestId,
            error,
            notifyRemote
        ) => {
            rejectPending(
                { pending, removePending: removeOperation, notifyRemoteCancellation: notifyOperation },
                requestId,
                error,
                notifyRemote
            );
        };
        const registerOperation: Parameters<typeof invokePendingInvocation>[0]["registerPendingWait"] = (
            requestId,
            peerId,
            method,
            options,
            timeoutMs,
            onInvocationCreated,
            resolve,
            reject
        ) => {
            registerPendingWait(
                { pending, scheduleTimeout, rejectPending: rejectOperation },
                requestId,
                peerId,
                method,
                options,
                timeoutMs,
                onInvocationCreated,
                resolve,
                reject
            );
        };

        const result = invokePendingInvocation(
            {
                pending,
                sendEnvelope,
                createRequestId: () => "req-direct",
                registerPendingWait: registerOperation,
                removePending: removeOperation,
                notifyRemoteCancellation: notifyOperation,
            },
            "peer-a",
            "job.run",
            [],
            0
        );

        expect(sent).toEqual([
            {
                peerId: "peer-a",
                envelope: { kind: "request", requestId: "req-direct", method: "job.run", args: [] },
            },
        ]);
        await Promise.resolve();
        expect(pending.get("req-direct")?.requestSent).toBe(true);
        receivePendingResponse(
            { removePending: removeOperation },
            { kind: "response", requestId: "req-direct", ok: true, data: "done" }
        );
        await expect(result).resolves.toBe("done");
        expect(pending.size).toBe(0);
        expect(notifications).toEqual([]);
    });

    it("cancels a matching unsent invocation locally and sends unknown or mismatched IDs directly", async () => {
        const localRejection = vi.fn();
        const owned = createPendingRecord({ reject: localRejection });
        const mismatched = createPendingRecord();
        const pending = new Map([
            ["req-owned", owned],
            ["req-other-peer", mismatched],
        ]);
        const sent: SentEnvelope[] = [];
        const sendEnvelope = async (peerId: string, envelope: RpcEnvelope) => {
            sent.push({ peerId, envelope });
        };
        const removeOperation: Parameters<typeof rejectPending>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);
        const notifyOperation: Parameters<typeof rejectPending>[0]["notifyRemoteCancellation"] = () => undefined;
        const rejectOperation: Parameters<typeof cancelPendingInvocation>[0]["rejectPending"] = (
            requestId,
            error,
            notifyRemote
        ) => {
            rejectPending(
                { pending, removePending: removeOperation, notifyRemoteCancellation: notifyOperation },
                requestId,
                error,
                notifyRemote
            );
        };
        const context = { pending, sendEnvelope, rejectPending: rejectOperation };

        await cancelPendingInvocation(context, "peer-a", "req-owned");
        await cancelPendingInvocation(context, "peer-b", "req-other-peer");
        await cancelPendingInvocation(context, "peer-c", "missing");

        expect(owned.cancelRequested).toBe(true);
        expect(localRejection).toHaveBeenCalledWith(expect.objectContaining({ code: "CANCELLED" }));
        expect(pending.has("req-owned")).toBe(false);
        expect(pending.get("req-other-peer")).toBe(mismatched);
        expect(sent).toEqual([
            { peerId: "peer-b", envelope: { kind: "cancel", requestId: "req-other-peer" } },
            { peerId: "peer-c", envelope: { kind: "cancel", requestId: "missing" } },
        ]);
    });

    it("settles a response directly and ignores an unknown ID", () => {
        const resolved: JsonLike[] = [];
        const record = createPendingRecord({ resolve: (value) => resolved.push(value) });
        const pending = new Map([["req-1", record]]);
        const removeOperation: Parameters<typeof receivePendingResponse>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);

        receivePendingResponse(
            { removePending: removeOperation },
            { kind: "response", requestId: "unknown", ok: true, data: "ignored" }
        );
        receivePendingResponse(
            { removePending: removeOperation },
            { kind: "response", requestId: "req-1", ok: true, data: "done" }
        );

        expect(resolved).toEqual(["done"]);
        expect(pending.size).toBe(0);
    });

    it("handles peer departure and close directly with their distinct cancellation rules", () => {
        const peerARejections: unknown[] = [];
        const peerBRejections: unknown[] = [];
        const peerCRejections: unknown[] = [];
        const peerA = createPendingRecord({ reject: (error) => peerARejections.push(error) });
        const peerB = createPendingRecord({ peerId: "peer-b", reject: (error) => peerBRejections.push(error) });
        const peerC = createPendingRecord({ peerId: "peer-c", reject: (error) => peerCRejections.push(error) });
        const pending = new Map([
            ["req-a", peerA],
            ["req-b", peerB],
            ["req-c", peerC],
        ]);
        const sentCancellations: string[] = [];
        const removeOperation: Parameters<typeof rejectPending>[0]["removePending"] = (requestId) =>
            removePending({ pending }, requestId);
        const notifyOperation: Parameters<typeof rejectPending>[0]["notifyRemoteCancellation"] = (
            peerId,
            requestId
        ) => {
            sentCancellations.push(peerId + ":" + requestId);
        };
        const rejectOperation: Parameters<typeof rejectPendingForPeerDeparture>[0]["rejectPending"] = (
            requestId,
            error,
            notifyRemote
        ) => {
            rejectPending(
                { pending, removePending: removeOperation, notifyRemoteCancellation: notifyOperation },
                requestId,
                error,
                notifyRemote
            );
        };

        rejectPendingForPeerDeparture({ pending, rejectPending: rejectOperation }, "peer-a");

        expect(pending.has("req-a")).toBe(false);
        expect(pending.get("req-b")).toBe(peerB);
        expect(peerARejections).toHaveLength(1);
        expect(peerARejections[0]).toMatchObject({ code: "NOT_CONNECTED" });
        expect(peerBRejections).toEqual([]);
        expect(sentCancellations).toEqual([]);

        peerB.requestSent = true;
        closePendingInvocations({ pending, rejectPending: rejectOperation });

        expect(pending.size).toBe(0);
        expect(peerBRejections).toHaveLength(1);
        expect(peerBRejections[0]).toMatchObject({ code: "NOT_CONNECTED" });
        expect(peerB.cancelRequested).toBe(true);
        expect(peerCRejections).toHaveLength(1);
        expect(peerCRejections[0]).toMatchObject({ code: "NOT_CONNECTED" });
        expect(peerC.cancelRequested).toBe(true);
        expect(sentCancellations).toEqual(["peer-b:req-b"]);
    });
});

describe("pending RPC invocation lifetime", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(endings)("releases its deadline and abort subscription after %s", async (ending) => {
        const harness = createHarness();
        let rejectSend!: (reason: unknown) => void;
        if (ending === "send-failure") {
            harness.setRequestCompletion(
                new Promise<void>((_resolve, reject) => {
                    rejectSend = reject;
                })
            );
        }
        const controller = new AbortController();
        const added = vi.spyOn(controller.signal, "addEventListener");
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const call = harness.invocations.invoke("peer-a", "job.run", [], {
            signal: controller.signal,
            timeoutMs: 100,
        });
        const outcome = call.then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
        );

        try {
            const { requestId } = harness.request();
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(1);
            expect(added).toHaveBeenCalledOnce();
            expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });

            const sendFailure = new Error("Send failed");
            switch (ending) {
                case "response":
                    harness.invocations.receiveResponse({ kind: "response", requestId, ok: true, data: "done" });
                    break;
                case "remote-error":
                    harness.invocations.receiveResponse({
                        kind: "response",
                        requestId,
                        ok: false,
                        error: { code: "REMOTE_ERROR", message: "Remote failure", details: { stage: "handler" } },
                    });
                    break;
                case "timeout":
                    await vi.advanceTimersByTimeAsync(100);
                    break;
                case "abort":
                    controller.abort();
                    break;
                case "cancel":
                    await harness.invocations.cancel("peer-a", requestId);
                    break;
                case "send-failure":
                    rejectSend(sendFailure);
                    break;
                case "peer-leave":
                    harness.invocations.peerLeft("peer-a");
                    break;
                case "close":
                    harness.invocations.close();
                    break;
            }

            const result = await outcome;
            if (ending === "response") {
                expect(result).toEqual({ value: "done" });
            } else if (ending === "send-failure") {
                expect(result).toEqual({ error: sendFailure });
            } else {
                const code =
                    ending === "remote-error"
                        ? "REMOTE_ERROR"
                        : ending === "timeout"
                          ? "TIMEOUT"
                          : ending === "peer-leave" || ending === "close"
                            ? "NOT_CONNECTED"
                            : "CANCELLED";
                expect(result).toMatchObject({ error: { code } });
                if (ending === "remote-error") {
                    expect(result).toMatchObject({ error: { details: { stage: "handler" } } });
                }
            }

            expect(vi.getTimerCount()).toBe(0);
            expect(removed).toHaveBeenCalledExactlyOnceWith("abort", added.mock.calls[0][1]);
            const cancels = harness.sent.filter(({ envelope }) => envelope.kind === "cancel");
            expect(cancels).toEqual(
                ["timeout", "abort", "cancel", "close"].includes(ending)
                    ? [{ envelope: { kind: "cancel", requestId }, peerId: "peer-a" }]
                    : []
            );

            const sent = [...harness.sent];
            controller.abort();
            harness.invocations.close();
            await vi.runAllTimersAsync();
            expect(harness.sent).toEqual(sent);
            expect(removed).toHaveBeenCalledOnce();
        } finally {
            harness.invocations.close();
            await outcome;
        }
    });

    it.each([0, -1])("retains abort cancellation when timeoutMs=%s disables the deadline", async (timeoutMs) => {
        const harness = createHarness();
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const call = harness.invocations.invoke("peer-a", "job.run", [], { signal: controller.signal, timeoutMs });
        const rejected = expect(call).rejects.toMatchObject({ code: "CANCELLED" });
        try {
            expect(vi.getTimerCount()).toBe(0);
            controller.abort();
            await rejected;
            expect(removed).toHaveBeenCalledOnce();
        } finally {
            harness.invocations.close();
        }
    });

    it("does not acquire waiting resources or send for an already aborted signal", async () => {
        const harness = createHarness();
        const controller = new AbortController();
        controller.abort();
        const added = vi.spyOn(controller.signal, "addEventListener");
        try {
            await expect(
                harness.invocations.invoke("peer-a", "job.run", [], { signal: controller.signal })
            ).rejects.toMatchObject({ code: "CANCELLED" });
            expect(added).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(harness.sent).toEqual([]);
        } finally {
            harness.invocations.close();
        }
    });

    it("cleans up when the signal aborts while its listener is being registered", async () => {
        const harness = createHarness();
        const controller = new AbortController();
        const add = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
            add(...args);
            controller.abort();
        });
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        try {
            await expect(
                harness.invocations.invoke("peer-a", "job.run", [], { signal: controller.signal })
            ).rejects.toMatchObject({ code: "CANCELLED" });
            await vi.advanceTimersByTimeAsync(0);
            expect(removed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request", "cancel"]);
        } finally {
            harness.invocations.close();
        }
    });

    it("preserves request-before-cancel ordering when abort occurs during transport send", async () => {
        const harness = createHarness();
        let finishSend!: () => void;
        harness.setRequestCompletion(
            new Promise<void>((resolve) => {
                finishSend = resolve;
            })
        );
        const controller = new AbortController();
        const call = harness.invocations.invoke("peer-a", "job.run", [], { signal: controller.signal });
        const rejected = expect(call).rejects.toMatchObject({ code: "CANCELLED" });
        controller.abort();

        await rejected;
        expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request"]);
        finishSend();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request", "cancel"]);
        harness.invocations.close();
    });

    it("preserves request-before-cancel ordering when close occurs during transport send", async () => {
        const harness = createHarness();
        let finishSend!: () => void;
        harness.setRequestCompletion(
            new Promise<void>((resolve) => {
                finishSend = resolve;
            })
        );
        const call = harness.invocations.invoke("peer-a", "job.run", [], 0);
        harness.invocations.close();

        await expect(call).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request"]);
        finishSend();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request", "cancel"]);
        harness.invocations.close();
    });

    it("consumes a send failure that arrives after cancellation", async () => {
        const harness = createHarness();
        let failSend!: (reason: unknown) => void;
        harness.setRequestCompletion(
            new Promise<void>((_resolve, reject) => {
                failSend = reject;
            })
        );
        const controller = new AbortController();
        const call = harness.invocations.invoke("peer-a", "job.run", [], { signal: controller.signal });
        const rejected = expect(call).rejects.toMatchObject({ code: "CANCELLED" });
        controller.abort();
        await rejected;

        failSend(new Error("Late send failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.sent.map(({ envelope }) => envelope.kind)).toEqual(["request"]);
        harness.invocations.close();
    });

    it("warns when a timeout cancellation cannot be sent", async () => {
        const harness = createHarness();
        harness.setCancelFailure(new Error("Cancel failed"));
        const call = harness.invocations.invoke("peer-a", "job.run", [], 5);
        const rejected = expect(call).rejects.toMatchObject({ code: "TIMEOUT" });
        await vi.advanceTimersByTimeAsync(5);
        await rejected;
        await Promise.resolve();

        expect(harness.warnings).toEqual([
            { message: "Failed to send RPC cancellation: Error: Cancel failed", peerId: "peer-a" },
        ]);
        harness.invocations.close();
    });

    it("releases only the settled invocation when calls share an AbortSignal", async () => {
        const harness = createHarness();
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const first = harness.invocations.invoke("peer-a", "job.first", [], { signal: controller.signal });
        const second = harness.invocations.invoke("peer-b", "job.second", [], { signal: controller.signal });
        const secondRejected = expect(second).rejects.toMatchObject({ code: "CANCELLED" });

        try {
            await vi.advanceTimersByTimeAsync(0);
            const firstRequestId = harness.request(0).requestId;
            harness.invocations.receiveResponse({
                kind: "response",
                requestId: firstRequestId,
                ok: true,
                data: "first",
            });
            await expect(first).resolves.toBe("first");
            expect(removed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(1);

            controller.abort();
            await secondRejected;
            expect(removed).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
            expect(harness.sent.filter(({ envelope }) => envelope.kind === "cancel")).toEqual([
                { envelope: { kind: "cancel", requestId: harness.request(1).requestId }, peerId: "peer-b" },
            ]);
        } finally {
            harness.invocations.close();
        }
    });
});

describe("pending invocation setup boundary", () => {
    it("sends the request when deadline setup throws inside the Promise executor", async () => {
        const setupFailure = new Error("Deadline setup failed");
        const sent: SentEnvelope[] = [];
        const invocations = createPendingInvocations({
            sendEnvelope: async (peerId, envelope) => {
                sent.push({ peerId, envelope });
            },
            createRequestId: () => "req-setup-failure",
            scheduleTimeout: () => {
                throw setupFailure;
            },
        });

        await expect(invocations.invoke("peer-a", "job.run", [], 25)).rejects.toBe(setupFailure);

        expect(sent).toEqual([
            {
                peerId: "peer-a",
                envelope: {
                    kind: "request",
                    requestId: "req-setup-failure",
                    method: "job.run",
                    args: [],
                },
            },
        ]);
        invocations.close();
    });
});
