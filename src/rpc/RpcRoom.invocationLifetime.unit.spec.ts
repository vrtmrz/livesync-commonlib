import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcRoom } from "./RpcRoom";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import type { RpcEnvelope, RpcWireMessage, TransportAdapter } from "./types";

class ControlledTransport implements TransportAdapter {
    readonly sent: { envelope: RpcEnvelope; peerId: string }[] = [];
    requestCompletion: Promise<void> | undefined;
    receive: (message: RpcWireMessage, peerId: string) => void = () => undefined;
    leave: (peerId: string) => void = () => undefined;

    send(message: RpcWireMessage, peerId: string) {
        if (message.wire !== "raw") throw new Error("The fixture expects small RPC envelopes");
        const envelope = JSON.parse(message.payload) as RpcEnvelope;
        this.sent.push({ envelope, peerId });
        if (envelope.kind === "request") return this.requestCompletion;
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.receive = handler;
        return () => {
            this.receive = () => undefined;
        };
    }

    onPeerLeave(handler: (peerId: string) => void) {
        this.leave = handler;
        return () => {
            this.leave = () => undefined;
        };
    }

    request(index = 0) {
        const request = this.sent.filter(({ envelope }) => envelope.kind === "request")[index];
        if (request?.envelope.kind !== "request") throw new Error("Expected a request");
        return { ...request.envelope, peerId: request.peerId };
    }

    respond(envelope: RpcEnvelope, peerId = "peer-a") {
        this.receive({ wire: "raw", payload: JSON.stringify(envelope) }, peerId);
    }
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

describe("RPC invocation waiting lifetime", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(endings)("releases the deadline and abort subscription after %s", async (ending) => {
        const transport = new ControlledTransport();
        let rejectSend!: (reason: unknown) => void;
        if (ending === "send-failure") {
            transport.requestCompletion = new Promise((_resolve, reject) => {
                rejectSend = reject;
            });
        }
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const added = vi.spyOn(controller.signal, "addEventListener");
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const call = room.invoke("peer-a", "job.run", [], { signal: controller.signal, timeoutMs: 100 });
        const outcome = call.then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
        );
        try {
            const { requestId } = transport.request();
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(1);
            expect(added).toHaveBeenCalledOnce();
            expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
            const sendFailure = new Error("Send failed");
            switch (ending) {
                case "response":
                    transport.respond({ kind: "response", requestId, ok: true, data: "done" });
                    break;
                case "remote-error":
                    transport.respond({
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
                    await room.cancel("peer-a", requestId);
                    break;
                case "send-failure":
                    rejectSend(sendFailure);
                    break;
                case "peer-leave":
                    transport.leave("peer-a");
                    break;
                case "close":
                    room.close();
                    break;
            }
            const result = await outcome;
            if (ending === "response") expect(result).toEqual({ value: "done" });
            else if (ending === "send-failure") expect(result).toEqual({ error: sendFailure });
            else {
                const code =
                    ending === "remote-error"
                        ? "REMOTE_ERROR"
                        : ending === "timeout"
                          ? "TIMEOUT"
                          : ending === "peer-leave" || ending === "close"
                            ? "NOT_CONNECTED"
                            : "CANCELLED";
                expect(result).toMatchObject({ error: { code } });
                if (ending === "remote-error")
                    expect(result).toMatchObject({ error: { details: { stage: "handler" } } });
            }
            expect(vi.getTimerCount()).toBe(0);
            expect(removed).toHaveBeenCalledExactlyOnceWith("abort", added.mock.calls[0][1]);
            const cancels = transport.sent.filter(({ envelope }) => envelope.kind === "cancel");
            expect(cancels).toEqual(
                ["timeout", "abort", "cancel", "close"].includes(ending)
                    ? [{ envelope: { kind: "cancel", requestId }, peerId: "peer-a" }]
                    : []
            );
            const sent = [...transport.sent];
            controller.abort();
            room.close();
            room.close();
            await vi.runAllTimersAsync();
            expect(transport.sent).toEqual(sent);
            expect(removed).toHaveBeenCalledOnce();
        } finally {
            room.close();
            await outcome;
        }
    });

    it.each([0, -1])("retains abort cancellation when timeoutMs=%s disables the deadline", async (timeoutMs) => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const call = room.invoke("peer-a", "job.run", [], { signal: controller.signal, timeoutMs });
        const rejected = expect(call).rejects.toMatchObject({ code: "CANCELLED" });
        try {
            expect(vi.getTimerCount()).toBe(0);
            controller.abort();
            await rejected;
            expect(removed).toHaveBeenCalledOnce();
        } finally {
            room.close();
        }
    });

    it("does not acquire waiting resources or send for an already aborted signal", async () => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        controller.abort();
        const added = vi.spyOn(controller.signal, "addEventListener");
        try {
            await expect(room.invoke("peer-a", "job.run", [], { signal: controller.signal })).rejects.toMatchObject({
                code: "CANCELLED",
            });
            expect(added).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(transport.sent).toEqual([]);
        } finally {
            room.close();
        }
    });

    it("cleans up when the signal aborts while its listener is being registered", async () => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const add = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
            add(...args);
            controller.abort();
        });
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        try {
            await expect(room.invoke("peer-a", "job.run", [], { signal: controller.signal })).rejects.toMatchObject({
                code: "CANCELLED",
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(removed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            expect(transport.sent.map(({ envelope }) => envelope.kind)).toEqual(["request", "cancel"]);
        } finally {
            room.close();
        }
    });

    it("preserves the compatibility timer receiver when scheduling and releasing", async () => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const scheduled = vi.spyOn(compatGlobal, "setTimeout");
        const cleared = vi.spyOn(compatGlobal, "clearTimeout");
        const call = room.invoke("peer-a", "job.run", [], 100);
        try {
            expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 100);
            expect(scheduled.mock.contexts[0]).toBe(compatGlobal);
            transport.respond({ kind: "response", requestId: transport.request().requestId, ok: true, data: "done" });
            await expect(call).resolves.toBe("done");
            expect(cleared).toHaveBeenCalledExactlyOnceWith(scheduled.mock.results[0].value);
            expect(cleared.mock.contexts[0]).toBe(compatGlobal);
        } finally {
            room.close();
        }
    });

    it("keeps the default deadline and numeric overload without an AbortSignal", async () => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const normal = room.invoke("peer-a", "job.default", []);
        const numeric = room.invoke("peer-b", "job.numeric", [], 5);
        const normalRejected = expect(normal).rejects.toMatchObject({ code: "TIMEOUT" });
        const numericRejected = expect(numeric).rejects.toMatchObject({ code: "TIMEOUT" });
        try {
            expect(vi.getTimerCount()).toBe(2);
            await vi.advanceTimersByTimeAsync(5);
            await numericRejected;
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(29994);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await normalRejected;
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            room.close();
        }
    });

    it("releases only the settled call when invocations share an AbortSignal", async () => {
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, "removeEventListener");
        const first = room.invoke("peer-a", "job.first", [], { signal: controller.signal });
        const second = room.invoke("peer-b", "job.second", [], { signal: controller.signal });
        const secondRejected = expect(second).rejects.toMatchObject({ code: "CANCELLED" });
        try {
            await vi.advanceTimersByTimeAsync(0);
            transport.respond({ kind: "response", requestId: transport.request().requestId, ok: true, data: "first" });
            await expect(first).resolves.toBe("first");
            expect(removed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(1);
            controller.abort();
            await secondRejected;
            expect(removed).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
            expect(transport.sent.filter(({ envelope }) => envelope.kind === "cancel")).toEqual([
                { envelope: { kind: "cancel", requestId: transport.request(1).requestId }, peerId: "peer-b" },
            ]);
        } finally {
            room.close();
        }
    });
});
