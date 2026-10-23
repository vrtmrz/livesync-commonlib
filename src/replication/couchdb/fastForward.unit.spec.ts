import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import Replication from "pouchdb-replication";
import generateReplicationId from "pouchdb-generate-replication-id";
import Checkpointer from "pouchdb-checkpointer";
import { prepareInitialFetchFastForward } from "./fastForward.ts";
import type { EntryDoc } from "@lib/common/types.ts";

PouchDB.plugin(MemoryAdapter).plugin(Replication);
const databases: PouchDB.Database<EntryDoc>[] = [];
const options = { push: {}, pull: { selector: { type: { $ne: "leaf" } } } };
const create = () => {
    const database = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
    databases.push(database);
    return database;
};

async function fixture() {
    const local = create();
    const remote = create();
    await remote.bulkDocs([
        { _id: "note", type: "plain", value: "metadata" },
        { _id: "h:chunk", type: "leaf", data: "chunk content" },
    ] as never);
    const session = (await prepareInitialFetchFastForward(local, remote, options, () => true))!;
    expect(session).toBeDefined();
    const rows = await remote.allDocs({ include_docs: true });
    for (const row of rows.rows) {
        const document = await remote.get(row.id, { revs: true });
        await local.bulkDocs([document], { new_edits: false });
        session.recordStoredRevisions([{ id: document._id, rev: document._rev }]);
    }
    session.recordCheckpoint((await remote.info()).update_seq);
    return { local, remote, session };
}

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const database of databases.splice(0)) await database.destroy();
});

describe("fresh Fast Fetch checkpoint handoff", () => {
    it("prepares checkpoints without requiring the native randomUUID API", async () => {
        const local = create();
        const remote = create();
        vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
        await expect(prepareInitialFetchFastForward(local, remote, options, () => true)).resolves.toBeDefined();
    });

    it("preserves imported progress across batch, directional, and Live options and sends subsequent edits", async () => {
        const { local, remote, session } = await fixture();
        expect(await session.fastForward()).toBe(true);
        const differences = vi.spyOn(remote, "revsDiff");
        const synced = await local.sync(remote, { ...options, batch_size: 1000, batches_limit: 2 });
        expect(synced.push.docs_written).toBe(0);
        expect(synced.pull.docs_written).toBe(0);
        expect(differences).not.toHaveBeenCalled();
        const push = await generateReplicationId(local, remote, options);
        const livePush = await generateReplicationId(local, remote, { ...options, live: true, retry: true });
        expect(push).toBe(livePush);
        const pull = await generateReplicationId(remote, local, { ...options, ...options.pull });
        const directionalPull = await generateReplicationId(remote, local, { ...options.pull, batch_size: 25 });
        expect(pull).toBe(directionalPull);
        await local.put({ _id: "local-edit", type: "plain" } as never);
        await remote.put({ _id: "remote-edit", type: "plain" } as never);
        await local.sync(remote, { ...options, batch_size: 25 });
        await expect(remote.get("local-edit")).resolves.toBeDefined();
        await expect(local.get("remote-edit")).resolves.toBeDefined();
        expect(await session.fastForward()).toBe(false);
    });

    it("leaves checkpoints at zero when a local revision was not imported", async () => {
        const { local, remote, session } = await fixture();
        await local.put({ _id: "unsent-edit", type: "plain" } as never);
        expect(await session.fastForward()).toBe(false);
        const id = await generateReplicationId(local, remote, options);
        expect(await new Checkpointer(local, remote, id, { cancelled: false }).getCheckpoint()).toBe(0);
        await expect(remote.get("unsent-edit")).rejects.toMatchObject({ status: 404 });
    });

    it("refuses an import session for a non-empty local database", async () => {
        const local = create();
        await local.put({ _id: "retained-local", type: "plain" } as never);
        expect(await prepareInitialFetchFastForward(local, create(), options, () => true)).toBeUndefined();
    });

    it("does not recreate a lost remote checkpoint while publishing an imported prefix", async () => {
        const { local, remote, session } = await fixture();
        const id = await generateReplicationId(local, remote, options);
        await remote.remove(await remote.get(id));
        await expect(session.fastForward()).rejects.toThrow("no longer available");
        await expect(remote.get(id)).rejects.toMatchObject({ status: 404 });
        expect((await local.get(id) as any).last_seq).toBe(0);
    });

    it("rejects a replacement checkpoint even when its local revision number is reused", async () => {
        const { local, remote, session } = await fixture();
        const id = await generateReplicationId(local, remote, options);
        const initial = await remote.get(id);
        await remote.remove(initial);
        await remote.put({ _id: id, last_seq: 0, session_id: "another-import", version: 1 } as never);
        expect((await remote.get(id))._rev).toBe(initial._rev);
        await expect(session.fastForward()).rejects.toThrow("changed before");
        expect((await local.get(id) as any).last_seq).toBe(0);
    });

    it("retains ordinary recovery after publication fails between the two directional pairs", async () => {
        const { local, remote, session } = await fixture();
        const pullId = await generateReplicationId(remote, local, { ...options, ...options.pull });
        const originalPut = remote.put.bind(remote);
        const put = vi.spyOn(remote, "put").mockImplementation((document: any, ...args: any[]) => {
            if (document._id === pullId) return Promise.reject(Object.assign(new Error("publication interrupted"), { status: 500 }));
            return (originalPut as any)(document, ...args);
        });
        await expect(session.fastForward()).rejects.toThrow("publication interrupted");
        put.mockRestore();
        await remote.put({ _id: "after-interruption", type: "plain" } as never);
        // Invoke the existing ordinary API explicitly; the handoff starts no recovery.
        await local.sync(remote, options);
        await expect(local.get("after-interruption")).resolves.toBeDefined();
    });
});
