import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import { RpcRoom, RpcError, type RpcWireMessage, type TransportAdapter } from "@lib/rpc/index";
import { exposeDB } from "./RpcPouchDBServer";
import { RpcPouchDBProxy } from "./RpcPouchDBProxy";
import { replicateShim } from "@lib/pouchdb/ReplicatorShim";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(replication);

// ---------------------------------------------------------------------------
// In-process MockTransport (same pair pattern as RpcRoom.unit.spec.ts)
// ---------------------------------------------------------------------------

class MockTransport implements TransportAdapter {
    readonly peerId: string;
    peer?: MockTransport;
    private messageHandler?: (message: RpcWireMessage, peerId: string) => void;
    private joinHandlers: Array<(peerId: string) => void> = [];
    private leaveHandlers: Array<(peerId: string) => void> = [];

    constructor(peerId: string) {
        this.peerId = peerId;
    }

    attach(peer: MockTransport) {
        this.peer = peer;
        this.joinHandlers.forEach((h) => h(peer.peerId));
    }

    detach() {
        const old = this.peer;
        this.peer = undefined;
        if (old) this.leaveHandlers.forEach((h) => h(old.peerId));
    }

    send(message: RpcWireMessage) {
        const peer = this.peer;
        if (!peer || !peer.messageHandler) return;
        peer.messageHandler(message, this.peerId);
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.messageHandler = handler;
        return () => {
            if (this.messageHandler === handler) this.messageHandler = undefined;
        };
    }

    onPeerJoin(handler: (peerId: string) => void) {
        this.joinHandlers.push(handler);
        return () => {
            this.joinHandlers = this.joinHandlers.filter((h) => h !== handler);
        };
    }

    onPeerLeave(handler: (peerId: string) => void) {
        this.leaveHandlers.push(handler);
        return () => {
            this.leaveHandlers = this.leaveHandlers.filter((h) => h !== handler);
        };
    }
}

function createPair() {
    const tA = new MockTransport("peer-a");
    const tB = new MockTransport("peer-b");
    tA.attach(tB);
    tB.attach(tA);
    const roomA = new RpcRoom({ transport: tA });
    const roomB = new RpcRoom({ transport: tB });
    return { tA, tB, roomA, roomB };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap PouchDB.replicate in a Promise for cleaner async tests. */
function replicateNative(src: any, target: PouchDB.Database, opts: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        (PouchDB as any)
            .replicate(src, target, { live: false, ...opts })
            .on("complete", () => resolve())
            .on("error", (err: unknown) => reject(err));
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RPC PouchDB Sync", () => {
    let dbServer: PouchDB.Database<object>;
    let dbLocal: PouchDB.Database<object>;

    beforeEach(() => {
        const suffix = Date.now();
        dbServer = new PouchDB<object>(`server-${suffix}`, { adapter: "memory" });
        dbLocal = new PouchDB<object>(`local-${suffix}`, { adapter: "memory" });
    });

    afterEach(async () => {
        await Promise.all([dbServer.destroy(), dbLocal.destroy()]);
    });

    // -----------------------------------------------------------------------
    // Happy-path replication scenarios
    // -----------------------------------------------------------------------

    it("pulls documents from RPC server to local using replicateShim", async () => {
        await dbServer.put({ _id: "doc1", value: "hello" });
        await dbServer.put({ _id: "doc2", value: "world" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        await replicateShim(dbLocal, proxy as any, () => Promise.resolve());

        const doc1: any = await dbLocal.get("doc1");
        const doc2: any = await dbLocal.get("doc2");
        expect(doc1.value).toBe("hello");
        expect(doc2.value).toBe("world");

        roomA.close();
        roomB.close();
    });

    it("pulls documents using native PouchDB.replicate with RPC proxy as source", async () => {
        await dbServer.put({ _id: "alpha", value: 1 });
        await dbServer.put({ _id: "beta", value: 2 });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        await replicateNative(proxy, dbLocal);

        const alpha: any = await dbLocal.get("alpha");
        const beta: any = await dbLocal.get("beta");
        expect(alpha.value).toBe(1);
        expect(beta.value).toBe(2);

        roomA.close();
        roomB.close();
    });

    it("pushes local documents to RPC server using replicateShim", async () => {
        await dbLocal.put({ _id: "local-only", value: "from-local" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        // push: target = proxy (remote), source = dbLocal
        await replicateShim(proxy as any, dbLocal, () => Promise.resolve());

        const doc: any = await dbServer.get("local-only");
        expect(doc.value).toBe("from-local");

        roomA.close();
        roomB.close();
    });

    it("bidirectional replicateShim syncs both sides", async () => {
        await dbServer.put({ _id: "server-doc", value: "from-server" });
        await dbLocal.put({ _id: "local-doc", value: "from-local" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        await replicateShim(dbLocal, proxy as any, () => Promise.resolve());
        await replicateShim(proxy as any, dbLocal, () => Promise.resolve());

        const serverDocInLocal: any = await dbLocal.get("server-doc");
        const localDocInServer: any = await dbServer.get("local-doc");
        expect(serverDocInLocal.value).toBe("from-server");
        expect(localDocInServer.value).toBe("from-local");

        roomA.close();
        roomB.close();
    });

    it("incremental pull only transfers new documents after checkpoint", async () => {
        await dbServer.put({ _id: "initial", value: "v1" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const progresses: number[] = [];
        await replicateShim(dbLocal, proxy as any, (docs) => {
            progresses.push(docs.length);
            return Promise.resolve();
        });
        expect(progresses.reduce((a, b) => a + b, 0)).toBe(1);

        await dbServer.put({ _id: "new-doc", value: "v2" });

        const secondProgresses: number[] = [];
        await replicateShim(dbLocal, proxy as any, (docs) => {
            secondProgresses.push(docs.length);
            return Promise.resolve();
        });
        expect(secondProgresses.reduce((a, b) => a + b, 0)).toBe(1);

        const newDoc: any = await dbLocal.get("new-doc");
        expect(newDoc.value).toBe("v2");

        roomA.close();
        roomB.close();
    });

    // -----------------------------------------------------------------------
    // Large dataset — stress test
    // -----------------------------------------------------------------------

    it("replicates 500 documents in one shot", async () => {
        const N = 500;
        const docs = Array.from({ length: N }, (_, i) => ({
            _id: `bulk-${String(i).padStart(5, "0")}`,
            payload: `data-${i}`,
        }));
        await dbServer.bulkDocs(docs);

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        let totalWritten = 0;
        await replicateShim(dbLocal, proxy as any, (written) => {
            totalWritten += written.length;
            return Promise.resolve();
        });

        const localInfo = await dbLocal.info();
        expect(localInfo.doc_count).toBe(N);
        expect(totalWritten).toBe(N);

        roomA.close();
        roomB.close();
    });

    it("replicates 500 documents via native PouchDB.replicate", async () => {
        const N = 500;
        const docs = Array.from({ length: N }, (_, i) => ({
            _id: `native-${String(i).padStart(5, "0")}`,
            payload: `value-${i}`,
        }));
        await dbServer.bulkDocs(docs);

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        await replicateNative(proxy, dbLocal);

        const localInfo = await dbLocal.info();
        expect(localInfo.doc_count).toBe(N);

        roomA.close();
        roomB.close();
    });

    // -----------------------------------------------------------------------
    // changes() interface
    // -----------------------------------------------------------------------

    it("proxy changes() is thenable (usable with await)", async () => {
        await dbServer.put({ _id: "item1", value: 42 });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const result = await proxy.changes({ since: 0, style: "all_docs" });
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0].id).toBe("item1");

        roomA.close();
        roomB.close();
    });

    it("proxy changes() emits EventEmitter events", async () => {
        await dbServer.put({ _id: "ev1", value: "x" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const receivedChanges: any[] = [];
        await new Promise<void>((resolve, reject) => {
            const feed = proxy.changes({ since: 0, style: "all_docs" });
            void feed.on("change", (c) => receivedChanges.push(c));
            void feed.on("complete", () => resolve());
            void feed.on("error", reject);
        });

        expect(receivedChanges.length).toBe(1);
        expect(receivedChanges[0].id).toBe("ev1");

        roomA.close();
        roomB.close();
    });

    it("proxy changes() cancel() mid-loop stops iteration and suppresses 'complete'", async () => {
        // Insert 3 docs so the for-loop has multiple iterations to work with.
        await dbServer.put({ _id: "loop1", value: 1 });
        await dbServer.put({ _id: "loop2", value: 2 });
        await dbServer.put({ _id: "loop3", value: 3 });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        let completeFired = false;
        const received: string[] = [];

        // Attach the "then" handler before cancel() removes all listeners.
        const feed = proxy.changes({ since: 0, style: "all_docs" });
        const settled = new Promise<void>((res) => {
            void feed.then(
                () => res(),
                () => res()
            );
        });

        void feed.on("change", (c: any) => {
            received.push(c.id);
            // Cancel after the very first change — the loop should break
            // before emitting the remaining changes.
            feed.cancel();
        });
        void feed.on("complete", () => {
            completeFired = true;
        });

        await settled;

        // Only the first change was received; the loop broke on cancel.
        expect(received).toHaveLength(1);
        // 'complete' must not have been emitted (cancelled=true suppresses it).
        expect(completeFired).toBe(false);

        roomA.close();
        roomB.close();
    });

    it("proxy changes() emits 'error' event when RPC call fails", async () => {
        const { roomA, roomB } = createPair();
        // Override the changes handler to simulate a server-side failure.
        roomA.register("pdb.changes", () => {
            throw new Error("remote changes feed exploded");
        });
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: unknown = await new Promise((res, rej) => {
            const feed = proxy.changes({ since: 0 });
            void feed.on("error", res);
            void feed.on("complete", () => rej(new Error("unexpected complete")));
        });

        expect(err).toBeDefined();

        roomA.close();
        roomB.close();
    });

    // -----------------------------------------------------------------------
    // Error propagation edge cases
    // -----------------------------------------------------------------------

    it("proxy reconstructs PouchDB 404 error shape (status + name + reason)", async () => {
        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: any = await proxy.get("nonexistent").catch((e) => e);
        expect(err.name).toBe("not_found");
        expect(err.status).toBe(404);
        // PouchDB memory adapter sets reason:"missing" on not_found errors.
        expect(err.reason).toBe("missing");

        roomA.close();
        roomB.close();
    });

    it("proxy reconstructs PouchDB error that carries a reason field", async () => {
        // A conflict-like error: has status, name, AND reason.
        const { roomA, roomB } = createPair();
        const mockDb = Object.create(dbServer) as PouchDB.Database<object>;
        (mockDb as any).put = () => {
            const e: any = new Error("document update conflict");
            e.status = 409;
            e.name = "conflict";
            e.reason = "Document update conflict.";
            throw e;
        };
        exposeDB(roomA, mockDb);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: any = await proxy.put({ _id: "x" }).catch((e) => e);
        expect(err.status).toBe(409);
        expect(err.name).toBe("conflict");
        expect(err.reason).toBe("Document update conflict.");

        roomA.close();
        roomB.close();
    });

    it("proxy reconstructs error that has status but no name", async () => {
        // runDB: if(err.name) false branch — status present, name absent
        const { roomA, roomB } = createPair();
        const mockDb = Object.create(dbServer) as PouchDB.Database<object>;
        (mockDb as any).info = () => {
            const e: any = new Error("server error");
            e.status = 500;
            // deliberately omit e.name
            throw e;
        };
        exposeDB(roomA, mockDb);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: any = await proxy.info().catch((e) => e);
        expect(err.status).toBe(500);

        roomA.close();
        roomB.close();
    });

    it("runDB passes through non-standard throws (no name, no status)", async () => {
        // runDB: if(err?.status || err?.name) false branch — bare object throw
        const { roomA, roomB } = createPair();
        const mockDb = Object.create(dbServer) as PouchDB.Database<object>;
        (mockDb as any).info = () => {
            throw { message: "non-standard error without name or status" };
        };
        exposeDB(roomA, mockDb);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        // The thrown object passes through runDB unchanged, gets serialised as
        // a generic REMOTE_ERROR by the RPC layer, and arrives as an RpcError
        // (not a PouchDB-shaped error).
        const err: any = await proxy.info().catch((e) => e);
        expect(err).toBeDefined();
        // Must NOT be reconstructed as a PouchDB error (no status / name).
        expect(err.status).toBeUndefined();
        expect(err.name).not.toBe("not_found");

        roomA.close();
        roomB.close();
    });

    it("callDB rethrows bare REMOTE_ERROR without PouchDB shape in details", async () => {
        // callDB: if(d?.name || d?.status) false branch
        const { roomA, roomB } = createPair();
        roomA.register("pdb.get", () => {
            throw new RpcError("REMOTE_ERROR", "raw remote error without pouchdb details");
        });
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: any = await proxy.get("any-id").catch((e) => e);
        // Should arrive as RpcError, not a reconstructed PouchDB error.
        expect(err).toBeInstanceOf(RpcError);
        expect(err.message).toContain("raw remote error");

        roomA.close();
        roomB.close();
    });

    it("callDB reconstructs error with status only (no name in details)", async () => {
        // callDB: if(d.name) false branch — details carries status but not name.
        // We use Object.create(null) to create an error without a name property,
        // since new Error() always sets name:"Error" which would be truthy.
        const { roomA, roomB } = createPair();
        const mockDb = Object.create(dbServer) as PouchDB.Database<object>;
        (mockDb as any).allDocs = () => {
            const e = Object.assign(Object.create(null), { message: "nameless status error", status: 503 });
            throw e;
        };
        exposeDB(roomA, mockDb);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const err: any = await proxy.allDocs().catch((e) => e);
        expect(err.status).toBe(503);
        // name was not in details so the reconstructed Error retains its default name.
        expect(err.name).toBe("Error");

        roomA.close();
        roomB.close();
    });

    // -----------------------------------------------------------------------
    // Misc proxy surface
    // -----------------------------------------------------------------------

    it("proxy allDocs() lists documents from server", async () => {
        await dbServer.put({ _id: "list1", value: "a" });
        await dbServer.put({ _id: "list2", value: "b" });

        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const result = await proxy.allDocs({ include_docs: false });
        const ids = result.rows.map((r) => r.id);
        expect(ids).toContain("list1");
        expect(ids).toContain("list2");

        roomA.close();
        roomB.close();
    });

    it("proxy activeTasks stub methods are callable without error", () => {
        const { roomA, roomB } = createPair();
        exposeDB(roomA, dbServer);
        const proxy = new RpcPouchDBProxy(roomB.session("peer-a"), "server");

        const id = proxy.activeTasks.add({ name: "test", total_items: 1 });
        const task = proxy.activeTasks.get(id);
        proxy.activeTasks.update(id, { completed_items: 1 });
        proxy.activeTasks.remove(id);
        const list = proxy.activeTasks.list();

        expect(task).toBeNull();
        expect(list).toEqual([]);

        roomA.close();
        roomB.close();
    });
});
