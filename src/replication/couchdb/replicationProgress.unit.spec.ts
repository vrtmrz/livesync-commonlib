import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import Replication from "pouchdb-replication";
import type { EntryDoc, RemoteDBSettings } from "@lib/common/types.ts";
import { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { DEFAULT_REPLICATION_STATICS } from "@lib/common/models/shared.definition.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";

PouchDB.plugin(MemoryAdapter).plugin(Replication);

function handler() {
    const events = new EventEmitter();
    return Object.assign(events, {
        cancel: vi.fn(),
        then: new Promise(() => undefined).then.bind(new Promise(() => undefined)),
    });
}

function fixture(localDatabase: object = {}) {
    const statistics = reactiveSource({ ...DEFAULT_REPLICATION_STATICS });
    const replicator = new LiveSyncCouchDBReplicator({
        services: {
            context: createServiceContext(),
            database: { localDatabase: { localDatabase } },
            replicator: {
                replicationStatics: statistics,
                runFiniteReplicationActivity: async <T>(run: () => Promise<T>) => await run(),
            },
            replication: { parseSynchroniseResult: vi.fn().mockResolvedValue(true) },
            remote: { hadLastPostFailedBySize: false },
        },
    } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
    return { replicator, statistics };
}

afterEach(() => vi.useRealTimers());

describe("CouchDB checkpoint statistics", () => {
    it("publishes batched matching progress and an opaque position without receiving documents", async () => {
        vi.useFakeTimers();
        const { replicator, statistics } = fixture();
        const sync = handler();
        const task = replicator.processSync(sync as never, false, 0, 0, "pullOnly", false);
        try {
            sync.emit("checkpoint", { start_next_batch: "opaque-position" });
            for (let i = 0; i < 100; i++) {
                sync.emit("checkpoint", { revs_diff: { id: `document-${i}`, changes: [{ rev: "1-a" }] } });
            }
            sync.emit("checkpoint", { checkpoint: "opaque-position" });
            await vi.advanceTimersByTimeAsync(200);
            expect(statistics.value).toMatchObject({
                arrived: 0,
                sent: 0,
                couchDB: {
                    phase: "one-shot",
                    pull: { checkedChanges: 100, completedBatches: 1, lastSeq: "opaque-position", checking: true },
                },
            });
        } finally {
            sync.emit("complete", {});
            await task;
        }
    });
});

describe("PouchDB checkpoint observation through processSync", () => {
    it("compares existing history before receiving a missing document with unchanged transfer counts", async () => {
        const local = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const remote = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let task: Promise<unknown> | undefined;
        const { replicator, statistics } = fixture(local);
        try {
            await remote.bulkDocs(
                Array.from({ length: 30 }, (_, i) => ({
                    _id: `h:known-${i}`,
                    type: "leaf",
                    data: `known ${i}`,
                })) as EntryDoc[]
            );
            const existing = await remote.allDocs({ include_docs: true });
            await local.bulkDocs(
                existing.rows.map((row) => row.doc!),
                { new_edits: false }
            );
            await remote.put({ _id: "h:missing", type: "leaf", data: "new content" } as EntryDoc);
            const revisions = local.revsDiff.bind(local);
            let comparisons = 0;
            let comparedEntries = 0;
            vi.spyOn(local, "revsDiff").mockImplementation(async (diff) => {
                comparisons++;
                comparedEntries += Object.keys(diff).length;
                if (comparisons === 3) await gate;
                return await revisions(diff);
            });
            const sync = local.replicate.from(remote, { batch_size: 10, batches_limit: 1 });
            task = replicator.processSync(sync, false, 0, 0, "pullOnly", false);
            await vi.waitFor(() => expect(comparisons).toBe(3));
            await vi.waitFor(() => expect(statistics.value.couchDB?.pull?.checkedChanges).toBe(comparedEntries));
            expect(statistics.value.arrived).toBe(0);
            expect(comparedEntries).toBeGreaterThan(0);
            expect(statistics.value.couchDB?.pull).toMatchObject({ completedBatches: 2, checking: true });
            expect(statistics.value.couchDB?.pull?.lastSeq).toBeGreaterThan(0);
            release();
            await expect(task).resolves.toBe("DONE");
            expect(statistics.value).toMatchObject({
                sent: 0,
                arrived: 1,
                couchDB: { phase: "idle", pull: { checkedChanges: 31, lastSeq: 31, checking: false } },
            });
            expect(await local.get("h:missing")).toMatchObject({ data: "new content" });
            expect((await local.allDocs()).total_rows).toBe(31);
            expect(sync.listenerCount("checkpoint")).toBe(0);
        } finally {
            release();
            await replicator.terminateSync();
            await task;
            await local.destroy();
            await remote.destroy();
        }
    });

    it.each([0, 3])("handles a new target and %i source documents", async (count) => {
        const local = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const remote = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator, statistics } = fixture(local);
        try {
            if (count)
                await remote.bulkDocs(
                    Array.from({ length: count }, (_, i) => ({
                        _id: `h:new-${i}`,
                        type: "leaf",
                        data: String(i),
                    })) as EntryDoc[]
                );
            const sync = local.replicate.from(remote, { batch_size: 2 });
            await expect(replicator.processSync(sync, false, 0, 0, "pullOnly", false)).resolves.toBe("DONE");
            expect(statistics.value.arrived).toBe(count);
            expect(statistics.value.couchDB).toMatchObject({
                phase: "idle",
                pull: { checkedChanges: count, checking: false },
            });
            expect(statistics.value.couchDB?.push).toBeUndefined();
            expect((await local.allDocs()).total_rows).toBe(count);
        } finally {
            await local.destroy();
            await remote.destroy();
        }
    });
});

describe("checkpoint publication lifetime", () => {
    it("publishes catch-up and continuous stages and resets counters at the handler boundary", async () => {
        const pull = handler();
        const live = Object.assign(handler(), { pull: handler(), push: handler() });
        const local = {
            info: async () => ({ update_seq: 3 }),
            replicate: { from: () => pull },
            sync: vi.fn(() => live),
        };
        const { replicator, statistics } = fixture(local);
        vi.spyOn(replicator, "ensurePBKDF2Salt").mockResolvedValue(true);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
            db: {},
            info: { update_seq: "3-remote" },
            close: async () => undefined,
            syncOptionBase: {},
            syncOption: { live: true },
        } as never);
        const phases: string[] = [];
        statistics.onChanged((current) => {
            phases.push(current.value.couchDB?.phase ?? "absent");
        });
        const task = replicator.openContinuousReplication({} as RemoteDBSettings, false, false);
        try {
            await vi.waitFor(() => expect(pull.listenerCount("checkpoint")).toBe(1));
            expect(statistics.value.couchDB?.phase).toBe("catch-up");
            pull.emit("checkpoint", { revs_diff: { id: "known" } });
            pull.emit("complete", {});
            await vi.waitFor(() => expect(live.pull.listenerCount("checkpoint")).toBe(1));
            expect(statistics.value.couchDB).toMatchObject({
                phase: "continuous",
                pull: { checkedChanges: 0 },
                push: { checkedChanges: 0 },
            });
            expect(phases).toContain("catch-up");
            expect(phases).toContain("continuous");
        } finally {
            await replicator.terminateSync();
            await task;
        }
        expect(statistics.value.couchDB?.phase).toBe("idle");
        expect(live.pull.listenerCount("checkpoint")).toBe(0);
        expect(live.push.listenerCount("checkpoint")).toBe(0);
    });

    it("leaves the phase idle when cancelled before the catch-up controller exists", async () => {
        const { replicator, statistics } = fixture();
        let release!: () => void;
        const gate = new Promise<boolean>((resolve) => {
            release = () => resolve(true);
        });
        vi.spyOn(replicator, "openOneShotReplication").mockReturnValue(gate);
        const connect = vi.spyOn(replicator, "checkReplicationConnectivity");
        const task = replicator.openContinuousReplication({} as RemoteDBSettings, false, false);
        expect(statistics.value.couchDB?.phase).toBe("catch-up");
        const stopped = replicator.terminateSync();
        expect(statistics.value.couchDB?.phase).toBe("idle");
        release();
        await expect(task).resolves.toBe(false);
        await stopped;
        expect(connect).not.toHaveBeenCalled();
        expect(statistics.value.couchDB?.phase).toBe("idle");
    });

    it("discards late callbacks from a failed handler after a replacement starts", async () => {
        vi.useFakeTimers();
        const { replicator, statistics } = fixture();
        const first = handler();
        const initial = replicator.processSync(first as never, false, 0, 0, "pullOnly", false);
        const late = first.listeners("checkpoint")[0] as (event: unknown) => void;
        first.emit("checkpoint", { revs_diff: { id: "old" } });
        first.emit("error", new Error("failed"));
        await expect(initial).resolves.toBe("FAILED");
        expect(statistics.value.couchDB?.pull?.checkedChanges).toBe(1);
        const replacement = fixture();
        replacement.replicator.env.services.replicator.replicationStatics = statistics;
        const second = handler();
        const next = replacement.replicator.processSync(second as never, false, 0, 0, "pushOnly", false);
        try {
            late({ checkpoint: "old-position" });
            first.emit("checkpoint", { revs_diff: { id: "late" } });
            await vi.advanceTimersByTimeAsync(200);
            expect(statistics.value.couchDB).toEqual({
                phase: "one-shot",
                push: { checkedChanges: 0, completedBatches: 0, checking: false },
            });
        } finally {
            second.emit("complete", {});
            await next;
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let an earlier handler's cleanup cancel its replacement", async () => {
        vi.useFakeTimers();
        const { replicator, statistics } = fixture();
        const first = handler();
        const initial = replicator.processSync(first as never, false, 0, 0, "pullOnly", false);
        first.emit("checkpoint", { revs_diff: { id: "old" } });
        const second = handler();
        const next = replicator.processSync(second as never, false, 0, 0, "pushOnly", false);
        try {
            await initial;
            expect(second.cancel).not.toHaveBeenCalled();
            second.emit("checkpoint", { revs_diff: { id: "new" } });
            second.emit("checkpoint", { checkpoint: "new-position" });
            await vi.advanceTimersByTimeAsync(200);
            expect(statistics.value.couchDB).toMatchObject({
                phase: "one-shot",
                push: { checkedChanges: 1, completedBatches: 1, lastSeq: "new-position" },
            });
            expect(statistics.value.couchDB).not.toHaveProperty("pull");
        } finally {
            second.emit("complete", {});
            await next;
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not add CouchDB data to the shared provider default", () => {
        const { replicator, statistics } = fixture();
        // Exercise the shared projection independently of the CouchDB override.
        const base = LiveSyncAbstractReplicator.prototype as unknown as {
            getReplicationStatics(this: LiveSyncCouchDBReplicator): object;
        };
        expect(base.getReplicationStatics.call(replicator)).not.toHaveProperty("couchDB");
        expect(statistics.value).not.toHaveProperty("couchDB");
    });
});
