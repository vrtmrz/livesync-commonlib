import { describe, expect, it, vi } from "vitest";
import type { RpcSessionProvider } from "./rpcSessionProvider";
import { BULK_GET_RPC_TIMEOUT, DEFAULT_RPC_TIMEOUT } from "./types";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";

describe("TrysteroReplicatorP2PClient finite-operation calls", () => {
    it("binds every remote database call to the finite-operation signal", async () => {
        const call = vi.fn(async () => ({ db_name: "remote", update_seq: 0 }));
        const notify = vi.fn(async () => {});
        const session = vi.fn(() => ({ call, notify }));
        const provider: RpcSessionProvider = { rpcRoom: { session } };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
        const controller = new AbortController();
        const database = client.getRemoteDB();

        expect(client.remoteDB).toBe(database);

        await client.getRemoteDB(controller.signal).info();
        await database.bulkGet({ docs: [{ id: "doc-a" }] });

        expect(session).toHaveBeenCalledTimes(2);
        expect(session).toHaveBeenNthCalledWith(1, "peer-a");
        expect(session).toHaveBeenNthCalledWith(2, "peer-a");
        expect(call).toHaveBeenCalledWith("db.info", [], {
            timeoutMs: DEFAULT_RPC_TIMEOUT,
            signal: controller.signal,
        });
        expect(call).toHaveBeenCalledWith("db.bulkGet", [{ docs: [{ id: "doc-a" }] }], {
            timeoutMs: BULK_GET_RPC_TIMEOUT,
            signal: undefined,
        });
    });
});

describe("TrysteroReplicatorP2PClient RPC calls", () => {
    it("uses the legacy namespace and caller options for bound, invoked, and direct calls", async () => {
        const call = vi.fn(async () => "remote result");
        const notify = vi.fn(async () => {});
        const session = vi.fn(() => ({ call, notify }));
        const provider: RpcSessionProvider = { rpcRoom: { session } };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
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
        const notify = vi.fn(async () => {});
        const session = vi.fn(() => ({ call, notify }));
        const provider: RpcSessionProvider = { rpcRoom: { session } };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
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
        const session = vi.fn(() => ({ call: vi.fn(), notify: vi.fn(async () => {}) }));
        const rpcRoom = state === "disconnected" ? undefined : { session };
        const provider: RpcSessionProvider = { rpcRoom };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
        const database = client.getRemoteDB();
        const signalDatabase = client.getRemoteDB(new AbortController().signal);
        const boundFunction = client.bindRemoteFunction("status");
        const boundObjectFunction = client.bindRemoteObjectFunctions<RemoteMethods, "read">("read");
        if (state === "closed") {
            client.close();
            client.close();
            expect(client.remoteDB).toBeUndefined();
            expect(() => client.getRemoteDB()).toThrow("Not connected to any room");
            expect(() => client.getRemoteDB(new AbortController().signal)).toThrow("Not connected to any room");
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
        await expect(signalDatabase.info()).rejects.toThrow("Not connected to any room");
        expect(session).not.toHaveBeenCalled();
    });

    it("uses a replacement room for cached database and bound function operations", async () => {
        const oldCall = vi.fn(async () => "old room");
        const newCall = vi.fn(async () => "new room");
        const oldSession = vi.fn(() => ({ call: oldCall, notify: vi.fn(async () => {}) }));
        const newSession = vi.fn(() => ({ call: newCall, notify: vi.fn(async () => {}) }));
        const provider: RpcSessionProvider = { rpcRoom: { session: oldSession } };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
        const database = client.getRemoteDB();
        const boundFunction = client.bindRemoteFunction("status");

        provider.rpcRoom = { session: newSession };

        await database.info();
        await boundFunction();

        expect(oldSession).not.toHaveBeenCalled();
        expect(oldCall).not.toHaveBeenCalled();
        expect(newSession).toHaveBeenCalledTimes(2);
        expect(newCall).toHaveBeenNthCalledWith(1, "db.info", [], {
            timeoutMs: DEFAULT_RPC_TIMEOUT,
            signal: undefined,
        });
        expect(newCall).toHaveBeenNthCalledWith(2, "legacy/status", [], {
            timeoutMs: DEFAULT_RPC_TIMEOUT,
            signal: undefined,
        });
    });
});

describe("TrysteroReplicatorP2PClient notifications", () => {
    it("uses the notification API with the existing method namespace", async () => {
        const notify = vi.fn(async () => {});
        const call = vi.fn();
        const session = vi.fn(() => ({ notify, call }));
        const provider: RpcSessionProvider = { rpcRoom: { session } };
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");
        await client.notifyRemoteFunction("onProgress", ["source"]);
        expect(session).toHaveBeenCalledWith("peer-a");
        expect(notify).toHaveBeenCalledExactlyOnceWith("legacy/onProgress", ["source"]);
        expect(call).not.toHaveBeenCalled();
    });
});

describe("TrysteroReplicatorP2PClient closed database access", () => {
    it("throws when requesting the remote database after close", () => {
        const provider: RpcSessionProvider = {};
        const client = new TrysteroReplicatorP2PClient(provider, "peer-a");

        client.close();

        expect(() => client.getRemoteDB()).toThrow("Not connected to any room");
        expect(() => client.getRemoteDB(new AbortController().signal)).toThrow("Not connected to any room");
        expect(client.remoteDB).toBeUndefined();
    });
});
