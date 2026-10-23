import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import HttpAdapter from "pouchdb-adapter-http";
import Replication from "pouchdb-replication";
import { fetchChangesForInitialSync } from "@lib/pouchdb/StreamingFetch.ts";
import { prepareInitialFetchFastForward } from "./fastForward.ts";
import type { EntryDoc } from "@lib/common/types.ts";

PouchDB.plugin(MemoryAdapter).plugin(HttpAdapter).plugin(Replication);
const hostname = process.env.hostname || "http://127.0.0.1:5989/";
const username = process.env.username || "admin";
const password = process.env.password || "testpassword";
const remoteUrl = new URL("livesync-test-db-initial-fast-forward", hostname).toString();
const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const options = { push: {}, pull: { selector: { type: { $ne: "leaf" } } } };
let local: PouchDB.Database<EntryDoc>;
let remote: PouchDB.Database<EntryDoc>;

beforeEach(async () => {
    local = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
    await fetch(remoteUrl, { method: "DELETE", headers: { Authorization: auth } });
    const response = await fetch(`${remoteUrl}?n=1&q=2`, { method: "PUT", headers: { Authorization: auth } });
    expect(response.ok).toBe(true);
    remote = new PouchDB<EntryDoc>(remoteUrl, { adapter: "http", auth: { username, password } });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await local.destroy();
    await remote.destroy();
});

describe("fresh Fast Fetch to ordinary CouchDB replication", () => {
    it("hands off all conflict leaves and Chunks without a full audit, then receives new Live changes", async () => {
        const id = "conflicted-metadata";
        const revisions = ["1-aaaaaaaa", "1-bbbbbbbb", "1-cccccccc"];
        await remote.bulkDocs(revisions.map((rev, index) => ({
            _id: id, _rev: rev,
            _revisions: { start: 1, ids: [rev.slice(2)] },
            ...(index === 2 ? { _deleted: true } : { type: "plain", data: `branch ${index}` }),
        })) as never, { new_edits: false });
        await remote.put({ _id: "h:content", type: "leaf", data: "unchanged chunk" } as never);
        const session = (await prepareInitialFetchFastForward(local, remote, options, () => true))!;
        await fetchChangesForInitialSync(
            local, remoteUrl, auth, async (doc) => doc as never, "0", undefined,
            session.recordCheckpoint, undefined, session.recordStoredRevisions
        );
        expect(await local.revsDiff({ [id]: revisions })).toEqual({});
        expect(await session.fastForward()).toBe(true);
        const differences = vi.spyOn(remote, "revsDiff");
        const fetched = vi.spyOn(remote, "bulkGet");
        const result = await local.sync(remote, { ...options, batch_size: 1000, batches_limit: 2 });
        expect(result.push.docs_written).toBe(0);
        expect(result.pull.docs_written).toBe(0);
        expect(differences).not.toHaveBeenCalled();
        expect(fetched).not.toHaveBeenCalled();
        await remote.put({ _id: "after-fast-fetch", type: "plain", data: "new remote content" } as never);
        const live = local.sync(remote, { ...options, live: true, retry: false, batch_size: 25 });
        await new Promise<void>((resolve, reject) => {
            let received = false;
            live.on("change", (result) => {
                if (result.direction === "pull" && result.change.docs.some((doc) => doc._id === "after-fast-fetch")) {
                    received = true;
                    live.cancel();
                }
            });
            live.on("complete", () => received ? resolve() : reject(new Error("Live replication ended before the new revision arrived.")));
            live.on("error", reject);
        });
        await expect(local.get("after-fast-fetch")).resolves.toMatchObject({ data: "new remote content" });
        expect(await local.revsDiff({ [id]: revisions })).toEqual({});
    });
});
