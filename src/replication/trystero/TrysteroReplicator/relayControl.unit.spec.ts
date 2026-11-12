import { describe, expect, it, vi } from "vitest";
import { disconnectRelay, type RelayControl } from "./relayControl";

describe("relay disconnection", () => {
    it("closes the captured sockets after pausing and starts the host stop without waiting", async () => {
        const order: string[] = [];
        const sockets: ReturnType<RelayControl["getSockets"]> = {
            first: {
                close: () => {
                    order.push("first");
                },
            },
            second: {
                close: () => {
                    order.push("second");
                },
            },
        };
        let finishStop!: () => void;
        const stopping = new Promise<void>((resolve) => {
            finishStop = resolve;
        });
        const relay = {
            getSockets: vi.fn(() => {
                order.push("read");
                return sockets;
            }),
            pauseReconnection: vi.fn(() => {
                order.push("pause");
                delete sockets.second;
            }),
        };
        const pauseServe = vi.fn(() => {
            order.push("stop");
            return stopping;
        });

        expect(disconnectRelay({ relay, pauseServe })).toBeUndefined();
        expect(order).toEqual(["read", "pause", "first", "second", "stop"]);
        expect(pauseServe).toHaveBeenCalledOnce();
        finishStop();
        await stopping;
    });

    it("still pauses and stops the host when no sockets exist", () => {
        const order: string[] = [];
        const relay = {
            getSockets: () => ({}),
            pauseReconnection: () => {
                order.push("pause");
            },
        };
        const pauseServe = vi.fn(async () => {
            order.push("stop");
        });
        disconnectRelay({ relay, pauseServe });
        expect(order).toEqual(["pause", "stop"]);
    });

    it("propagates a socket close error before closing later sockets or stopping the host", () => {
        const failure = new Error("Socket close failed");
        const later = vi.fn();
        const relay = {
            getSockets: () => ({
                first: {
                    close: () => {
                        throw failure;
                    },
                },
                second: { close: later },
            }),
            pauseReconnection: vi.fn(),
        };
        const pauseServe = vi.fn(async () => {});
        expect(() => disconnectRelay({ relay, pauseServe })).toThrow(failure);
        expect(relay.pauseReconnection).toHaveBeenCalledOnce();
        expect(later).not.toHaveBeenCalled();
        expect(pauseServe).not.toHaveBeenCalled();
    });
});
