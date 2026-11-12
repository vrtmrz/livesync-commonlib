import { describe, expect, it, vi } from "vitest";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";

describe("TrysteroReplicatorP2PClient finite-operation calls", () => {
    it("binds every remote database call to the finite-operation signal", async () => {
        const call = vi.fn(async () => ({ db_name: "remote", update_seq: 0 }));
        const session = vi.fn(() => ({ call }));
        const client = new TrysteroReplicatorP2PClient(
            {
                rpcRoom: { session },
            } as any,
            "peer-a"
        );
        const controller = new AbortController();

        await client.getRemoteDB(controller.signal).info();

        expect(session).toHaveBeenCalledWith("peer-a");
        expect(call).toHaveBeenCalledWith("db.info", [], {
            timeoutMs: expect.any(Number),
            signal: controller.signal,
        });
    });
});

describe("TrysteroReplicatorP2PClient notifications", () => {
    it("uses the notification API with the existing method namespace", async () => {
        const notify = vi.fn(async () => {});
        const call = vi.fn();
        const session = vi.fn(() => ({ notify, call }));
        const client = new TrysteroReplicatorP2PClient({ rpcRoom: { session } } as any, "peer-a");
        await client.notifyRemoteFunction("onProgress", ["source"]);
        expect(session).toHaveBeenCalledWith("peer-a");
        expect(notify).toHaveBeenCalledExactlyOnceWith("legacy/onProgress", ["source"]);
        expect(call).not.toHaveBeenCalled();
    });
});
