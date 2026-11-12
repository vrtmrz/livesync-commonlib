import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingInvocations } from "./pendingInvocations";
import type { TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import type { RpcEnvelope } from "../types";

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
