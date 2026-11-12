import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcRoom } from "./RpcRoom";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import type { RpcEnvelope, RpcWireMessage, TransportAdapter } from "./types";

class ControlledTransport implements TransportAdapter {
    readonly sent: { envelope: RpcEnvelope; peerId: string }[] = [];
    receive: (message: RpcWireMessage, peerId: string) => void = () => undefined;

    send(message: RpcWireMessage, peerId: string) {
        if (message.wire !== "raw") {
            throw new Error("The fixture expects a small RPC envelope");
        }
        this.sent.push({ envelope: JSON.parse(message.payload) as RpcEnvelope, peerId });
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.receive = handler;
        return () => {
            this.receive = () => undefined;
        };
    }

    request() {
        const request = this.sent.find(({ envelope }) => envelope.kind === "request");
        if (request?.envelope.kind !== "request") {
            throw new Error("Expected a request");
        }
        return request.envelope;
    }

    respond(envelope: RpcEnvelope) {
        this.receive({ wire: "raw", payload: JSON.stringify(envelope) }, "peer-b");
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("RpcRoom invocation wiring", () => {
    it("preserves the compatibility timer receiver when scheduling and releasing", async () => {
        vi.useFakeTimers();
        const transport = new ControlledTransport();
        const room = new RpcRoom({ transport });
        const scheduled = vi.spyOn(compatGlobal, "setTimeout");
        const cleared = vi.spyOn(compatGlobal, "clearTimeout");
        const call = room.invoke("peer-b", "job.run", [], 100);

        try {
            const { requestId } = transport.request();
            expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 100);
            expect(scheduled.mock.contexts[0]).toBe(compatGlobal);

            transport.respond({ kind: "response", requestId, ok: true, data: "done" });
            await expect(call).resolves.toBe("done");
            expect(cleared).toHaveBeenCalledExactlyOnceWith(scheduled.mock.results[0].value);
            expect(cleared.mock.contexts[0]).toBe(compatGlobal);
        } finally {
            room.close();
        }
    });
});
