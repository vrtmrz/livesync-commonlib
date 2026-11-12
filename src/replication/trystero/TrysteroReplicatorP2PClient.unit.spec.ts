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

        expect(client.remoteDB).toBe(client.getRemoteDB());

        await client.getRemoteDB(controller.signal).info();

        expect(session).toHaveBeenCalledWith("peer-a");
        expect(call).toHaveBeenCalledWith("db.info", [], {
            timeoutMs: expect.any(Number),
            signal: controller.signal,
        });
    });
});

describe("TrysteroReplicatorP2PClient RPC calls", () => {
    it("uses the legacy namespace and caller options for bound, invoked, and direct calls", async () => {
        const call = vi.fn(async () => "remote result");
        const session = vi.fn(() => ({ call }));
        const client = new TrysteroReplicatorP2PClient({ rpcRoom: { session } } as any, "peer-a");
        const signal = new AbortController().signal;

        await expect(client.bindRemoteFunction("status", 1200, signal)("source")).resolves.toBe("remote result");
        await expect(client.invokeRemoteFunction("status", ["source"], 3400, signal)).resolves.toBe("remote result");
        await expect(client._sendRPC("refresh", ["source"], 5600)).resolves.toBe("remote result");

        expect(session).toHaveBeenCalledTimes(3);
        expect(call).toHaveBeenNthCalledWith(1, "legacy/status", ["source"], {
            timeoutMs: 1200,
            signal,
        });
        expect(call).toHaveBeenNthCalledWith(2, "legacy/status", ["source"], {
            timeoutMs: 3400,
            signal,
        });
        expect(call).toHaveBeenNthCalledWith(3, "legacy/refresh", ["source"], 5600);
    });

    it("binds and invokes remote object methods with their RPC options", async () => {
        type RemoteMethods = { read: (id: string) => Promise<string> };
        const call = vi.fn(async () => "document");
        const session = vi.fn(() => ({ call }));
        const client = new TrysteroReplicatorP2PClient({ rpcRoom: { session } } as any, "peer-a");
        const signal = new AbortController().signal;

        await expect(client.bindRemoteObjectFunctions<RemoteMethods, "read">("read", 2300)("doc-a")).resolves.toBe(
            "document"
        );
        await expect(
            client.invokeRemoteObjectFunction<RemoteMethods, "read">("read", ["doc-b"], 4700, signal)
        ).resolves.toBe("document");

        expect(call).toHaveBeenNthCalledWith(1, "legacy/read", ["doc-a"], 2300);
        expect(call).toHaveBeenNthCalledWith(2, "legacy/read", ["doc-b"], {
            timeoutMs: 4700,
            signal,
        });
    });

    it.each(["disconnected", "closed"] as const)("rejects every call shape while %s", async (state) => {
        type RemoteMethods = { read: (id: string) => Promise<string> };
        const session = vi.fn(() => ({ call: vi.fn(), notify: vi.fn() }));
        const rpcRoom = state === "disconnected" ? undefined : { session };
        const client = new TrysteroReplicatorP2PClient({ rpcRoom } as any, "peer-a");
        const database = client.remoteDB;
        const boundFunction = client.bindRemoteFunction("status");
        const boundObjectFunction = client.bindRemoteObjectFunctions<RemoteMethods, "read">("read");
        if (state === "closed") {
            client.close();
            client.close();
            expect(client.remoteDB).toBeUndefined();
        }

        expect(() => client._sendRPC("refresh", [])).toThrow("Not connected to any room");
        await expect(boundFunction()).rejects.toThrow("Not connected to any room");
        await expect(client.invokeRemoteFunction("status", [])).rejects.toThrow("Not connected to any room");
        await expect(client.notifyRemoteFunction("onProgress", [])).rejects.toThrow("Not connected to any room");
        await expect(boundObjectFunction("doc-a")).rejects.toThrow("Not connected to any room");
        await expect(client.invokeRemoteObjectFunction<RemoteMethods, "read">("read", ["doc-b"])).rejects.toThrow(
            "Not connected to any room"
        );
        await expect(database.info()).rejects.toThrow("Not connected to any room");
        expect(session).not.toHaveBeenCalled();
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
