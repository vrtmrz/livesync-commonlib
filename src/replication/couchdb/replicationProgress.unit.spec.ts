import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import Replication from "pouchdb-replication";
import { DEFAULT_SETTINGS, type EntryDoc, type RemoteDBSettings } from "@lib/common/types.ts";
import { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPLICATION_STATICS } from "@lib/common/models/shared.definition.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";
import { ReplicationStaticsOwner } from "@lib/services/base/ReplicationStaticsOwner.ts";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";
import { Logger } from "@lib/common/logger.ts";

PouchDB.plugin(MemoryAdapter).plugin(Replication);

function handler() {
    const events = new EventEmitter();
    return Object.assign(events, {
        cancel: vi.fn(),
        then: new Promise(() => undefined).then.bind(new Promise(() => undefined)),
    });
}

function fixture(localDatabase: object = {}, statisticsOwner = new ReplicationStaticsOwner()) {
    const statistics = statisticsOwner.source;
    const replicator = new LiveSyncCouchDBReplicator({
        services: {
            API: { addLog: Logger },
            context: createServiceContext(),
            database: {
                localDatabase: {
                    localDatabase,
                    readFromDatabase: <T>(read: (pouch: typeof localDatabase) => Promise<T>) => read(localDatabase),
                },
            },
            replicator: {
                replicationStatics: statistics,
                runFiniteReplicationActivity: async <T>(run: () => Promise<T>) => await run(),
            },
            replication: { parseSynchroniseResult: vi.fn().mockResolvedValue(true) },
            remote: { hadLastPostFailedBySize: false },
        },
    } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
    return { replicator, statistics, statisticsOwner };
}

afterEach(() => vi.useRealTimers());

describe("replication statistics publication", () => {
    it("starts disconnected before statistics have been published", () => {
        expect(DEFAULT_REPLICATION_STATICS).toMatchObject({
            syncStatus: "NOT_CONNECTED",
            statsUpdatedAt: null,
        });
    });

    it("stamps common replicator publications without changing the time on reads", () => {
        vi.useFakeTimers();
        const publishedAt = Date.UTC(2026, 10, 19, 12);
        vi.setSystemTime(publishedAt);
        const { replicator, statistics } = fixture();

        replicator.updateInfo();
        expect(statistics.value).toMatchObject({
            syncStatus: "NOT_CONNECTED",
            statsUpdatedAt: publishedAt,
        });

        vi.setSystemTime(publishedAt + 1000);
        expect(statistics.value).toMatchObject({ statsUpdatedAt: publishedAt });
    });
});

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
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: async () => ({ update_seq: 3 }),
            replicate: { from: vi.fn(() => pull) },
            sync: vi.fn(() => live),
        };
        const { replicator, statistics } = fixture(local);
        replicator.nodeid = "phase-fixture";
        vi.spyOn(replicator, "getReplicationPBKDF2Salt").mockResolvedValue(new Uint8Array([1]));
        Object.assign(replicator.env.services.API, {
            isMobile: () => false,
            getAppVersion: () => "test",
            getPluginVersion: () => "test",
            getPlatform: () => "test",
        });
        Object.assign(replicator.env.services, {
            vault: { vaultName: () => "test-vault", getVaultName: () => "test-device" },
        });
        const remote = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const releaseConnection = vi.fn(async () => undefined);
        const openCouchDBConnection = vi.fn(async () => ({
            db: remote,
            close: releaseConnection,
            info: await remote.info(),
        }));
        Object.assign(replicator.env.services.remote, { openCouchDBConnection });
        const settings = {
            ...DEFAULT_SETTINGS,
            versionUpFlash: "",
            couchDB_URI: "https://couchdb.test",
            couchDB_DBNAME: "phase",
            pathNormalizationVersion: 0,
            batch_size: 3,
        } satisfies RemoteDBSettings;
        const phases: string[] = [];
        statistics.onChanged((current) => {
            phases.push(current.value.couchDB?.phase ?? "absent");
        });
        const onStartSettled = vi.fn();
        const task = replicator.openContinuousReplication(settings, false, false, onStartSettled);
        try {
            await vi.waitFor(() => expect(pull.listenerCount("checkpoint")).toBe(1));
            expect(local.replicate.from).toHaveBeenCalledExactlyOnceWith(
                remote,
                expect.objectContaining({ batch_size: 3 })
            );
            expect(statistics.value.couchDB?.phase).toBe("catch-up");
            expect(onStartSettled).not.toHaveBeenCalled();
            const document = { _id: "h:received", type: "leaf", data: "content" };
            pull.emit("checkpoint", { revs_diff: { id: document._id } });
            pull.emit("change", { docs: [document], last_seq: "1-remote" });
            await vi.waitFor(() => expect(statistics.value.arrived).toBe(1));
            expect(replicator.env.services.replication.parseSynchroniseResult).toHaveBeenCalledWith([document]);
            expect(statistics.value.couchDB?.pull?.checkedChanges).toBe(1);
            pull.emit("complete", {});
            await vi.waitFor(() => expect(live.pull.listenerCount("checkpoint")).toBe(1));
            expect(statistics.value.couchDB).toMatchObject({
                phase: "continuous",
                pull: { checkedChanges: 0 },
                push: { checkedChanges: 0 },
            });
            expect(local.sync).toHaveBeenCalledExactlyOnceWith(
                remote,
                expect.objectContaining({ live: true, retry: true })
            );
            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "started" });
            expect(statistics.value.arrived).toBe(1);
            expect(phases).toContain("catch-up");
            expect(phases).toContain("continuous");
        } finally {
            try {
                await replicator.terminateSync();
                await task;
            } finally {
                await remote.destroy();
            }
        }
        expect(statistics.value.couchDB?.phase).toBe("idle");
        expect(live.pull.listenerCount("checkpoint")).toBe(0);
        expect(live.push.listenerCount("checkpoint")).toBe(0);
        expect(openCouchDBConnection).toHaveBeenCalledTimes(2);
        expect(releaseConnection).toHaveBeenCalledTimes(2);
    });

    it("leaves the phase idle when cancelled before the catch-up controller exists", async () => {
        const { replicator, statistics } = fixture();
        const seedStarted = Promise.withResolvers<void>();
        const seed = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
        vi.spyOn(replicator, "getReplicationPBKDF2Salt").mockImplementation(() => {
            seedStarted.resolve();
            return seed.promise;
        });
        vi.spyOn(replicator, "isMobile").mockReturnValue(false);
        const openCouchDBConnection = vi.fn(async () => ({ error: new Error("unexpected connection") }));
        Object.assign(replicator.env.services.remote, { openCouchDBConnection });
        const setting = {
            versionUpFlash: "",
            couchDB_URI: "https://couchdb.test",
            couchDB_DBNAME: "phase",
            couchDB_CustomHeaders: "",
        } as RemoteDBSettings;
        const task = replicator.openContinuousReplication(setting, false, false);
        try {
            await seedStarted.promise;
            expect(statistics.value.couchDB?.phase).toBe("catch-up");
            const stopped = replicator.terminateSync();
            expect(statistics.value.couchDB?.phase).toBe("idle");
            seed.resolve(new Uint8Array([1]));
            await expect(task).resolves.toBe(false);
            await stopped;
            expect(openCouchDBConnection).not.toHaveBeenCalled();
            expect(statistics.value.couchDB?.phase).toBe("idle");
        } finally {
            seed.resolve(new Uint8Array([1]));
            await replicator.terminateSync();
            await task;
        }
    });

    it("discards late callbacks from a failed handler after a replacement starts", async () => {
        vi.useFakeTimers();
        const { replicator, statistics, statisticsOwner } = fixture();
        const first = handler();
        const initial = replicator.processSync(first as never, false, 0, 0, "pullOnly", false);
        const late = first.listeners("checkpoint")[0] as (event: unknown) => void;
        first.emit("checkpoint", { revs_diff: { id: "old" } });
        first.emit("error", new Error("failed"));
        await expect(initial).resolves.toBe("FAILED");
        expect(statistics.value.couchDB?.pull?.checkedChanges).toBe(1);
        const replacement = fixture({}, statisticsOwner);
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
