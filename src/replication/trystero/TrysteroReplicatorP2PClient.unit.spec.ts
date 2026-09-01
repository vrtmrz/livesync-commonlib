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
