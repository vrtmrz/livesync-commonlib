import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
    compareReplicationResultQueueRows,
    createReplicationResultQueueStore,
    loadReplicationResultQueueRows,
    rowsFromLegacyReplicationResultSnapshot,
    toReplicationResultQueueWrites,
    type ReplicationResultQueueDelta,
    type ReplicationResultQueueBacking,
    type ReplicationResultQueueRow,
    type ReplicationResultQueueWrite,
} from "./replicationResultQueueStore.ts";

const legacyKey = "replicationResultProcessorSnapshot";
const rowPrefix = "replication-result-queue:v1:";

type Document = { _id: string; _rev: string; data: string };
type Pending = {
    documentId: string;
    revision: string;
    reason: string;
    source: "received";
    state: "waiting" | "review";
    automaticAttempted: boolean;
    resources?: readonly string[];
};
type Attempt = { documentId: string; revision: string; kind: "manual" | "automatic" };
type QueueRow = ReplicationResultQueueRow<Document, Pending, Attempt>;

const openStore = (backing: ReplicationResultQueueBacking) =>
    createReplicationResultQueueStore<Document, Pending, Attempt>(backing);

type RecordedWrite = { kind: string; key: string; valueBytes: number };

// Use JSON strings for these plain-data fixtures and the SQLite value BLOB's UTF-16BE encoding.
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf16le").swap16();
const decode = (bytes: Buffer): unknown => JSON.parse(Buffer.from(bytes).swap16().toString("utf16le"));

class RecordingBacking implements ReplicationResultQueueBacking {
    readonly values = new Map<string, Buffer>();
    readonly reads: string[] = [];
    readonly listings: string[] = [];
    readonly batches: RecordedWrite[][] = [];
    failAfterStagedOperation?: number;

    constructor(entries: readonly (readonly [string, unknown])[] = []) {
        for (const [key, value] of entries) {
            this.values.set(key, encode(value));
        }
    }

    async read(key: string): Promise<unknown> {
        this.reads.push(key);
        const bytes = this.values.get(key);
        return bytes === undefined ? undefined : decode(bytes);
    }

    async listKeys(prefix: string): Promise<readonly string[]> {
        this.listings.push(prefix);
        return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    async writeBatch(operations: readonly ReplicationResultQueueWrite[]): Promise<void> {
        const staged = new Map<string, Buffer | undefined>();
        const writes: RecordedWrite[] = [];
        this.batches.push(writes);
        for (const operation of operations) {
            const bytes = operation.kind === "upsert" ? encode(operation.value) : undefined;
            staged.set(operation.key, bytes);
            writes.push({ kind: operation.kind, key: operation.key, valueBytes: bytes?.byteLength ?? 0 });
            if (writes.length === this.failAfterStagedOperation) {
                this.failAfterStagedOperation = undefined;
                throw new Error("Injected failure after staging an operation");
            }
        }
        for (const [key, bytes] of staged) {
            if (bytes === undefined) {
                this.values.delete(key);
            } else {
                this.values.set(key, bytes);
            }
        }
    }
}

const duplicateDoc = { _id: "same-doc", _rev: "2-abc", data: "文書" };

const pending = {
    documentId: "same-doc",
    revision: "2-abc",
    reason: "transport",
    source: "received",
    state: "review",
    automaticAttempted: true,
} satisfies Pending;

const attempt = { documentId: "same-doc", revision: "2-abc", kind: "manual" } satisfies Attempt;

function queueRow(id: string, order = 0): QueueRow {
    return { kind: "queued", id, order, payload: duplicateDoc };
}

describe("replication result queue rows", () => {
    it("maps each legacy array index to an occurrence ID and order", () => {
        const snapshot = {
            queued: [duplicateDoc, duplicateDoc],
            processing: [duplicateDoc],
        };

        expect(rowsFromLegacyReplicationResultSnapshot(snapshot)).toEqual([
            {
                kind: "processing",
                id: "legacy:processing:0",
                order: 0,
                payload: duplicateDoc,
            },
            {
                kind: "queued",
                id: "legacy:queued:0",
                order: 0,
                payload: duplicateDoc,
            },
            {
                kind: "queued",
                id: "legacy:queued:1",
                order: 1,
                payload: duplicateDoc,
            },
        ]);
    });

    it("orders rows by phase, order, and then ID", () => {
        const first = queueRow("b");
        const tie = queueRow("a");
        const later = queueRow("0", 1);
        const active = { ...later, id: "z", kind: "processing" } as const;

        expect([later, first, tie, active].sort(compareReplicationResultQueueRows)).toEqual([
            active,
            tie,
            first,
            later,
        ]);
        expect(compareReplicationResultQueueRows(first, tie)).toBeGreaterThan(0);
        expect(compareReplicationResultQueueRows(first, { ...first })).toBe(0);
    });

    it("translates ordered changes to writes for the same occurrence key", () => {
        const row = queueRow("item");
        const processing = { ...row, kind: "processing" } as const;
        const key = `${rowPrefix}item`;

        expect(
            toReplicationResultQueueWrites([
                { kind: "upsert", row },
                { kind: "upsert", row: processing },
                { kind: "delete", id: row.id },
            ])
        ).toEqual([
            { kind: "upsert", key, value: row },
            { kind: "upsert", key, value: processing },
            { kind: "delete", key },
        ]);
    });

    it.each([
        [{ kind: "upsert", row: queueRow("item", -1) }, "Invalid replication result queue row"],
        [{ kind: "delete", id: "" }, "requires a non-empty ID"],
        // JavaScript callers can violate the TypeScript discriminant.
        [
            { kind: "replace" } as unknown as ReplicationResultQueueDelta<Document, Pending, Attempt>,
            "Invalid replication result queue change",
        ],
    ] satisfies [ReplicationResultQueueDelta<Document, Pending, Attempt>, string][])(
        "rejects a malformed change before the backing can write",
        (change, message) => {
            expect(() => toReplicationResultQueueWrites([change])).toThrow(message);
        }
    );

    it("rejects listings that contain another namespace's keys", async () => {
        const backing = new RecordingBacking();
        vi.spyOn(backing, "listKeys").mockResolvedValue(["other-setting"]);

        await expect(loadReplicationResultQueueRows(backing)).rejects.toThrow("outside the queue namespace");
        expect(backing.reads).toEqual([]);
        expect(backing.batches).toEqual([]);
    });
});

describe("replication result queue store", () => {
    it("exposes unvalidated payloads on load and keeps upserts typed", () => {
        type Store = ReturnType<typeof openStore>;
        type ReadRows = Awaited<ReturnType<Store["load"]>>;
        type Write = Parameters<Store["commit"]>[0][number];

        expectTypeOf<ReadRows>().toEqualTypeOf<readonly ReplicationResultQueueRow<unknown, unknown, unknown>[]>();
        expectTypeOf<Extract<Write, { kind: "upsert" }>["row"]>().toEqualTypeOf<QueueRow>();
    });

    it.each([
        { name: "small", backlogCount: 2, expectedBacklogBytes: 400_396 },
        { name: "about 24 MB", backlogCount: 120, expectedBacklogBytes: 24_024_280 },
    ])("writes only the changed key with a $name backlog", async ({ backlogCount, expectedBacklogBytes }) => {
        const payload = { _id: "backlog-doc", _rev: "1-a", data: "x".repeat(100_000) };
        const unchanged = Array.from({ length: backlogCount }, (_, order) => {
            const id = `backlog-${order}`;
            return [`${rowPrefix}${id}`, { kind: "queued", id, order, payload }] as const;
        });
        const backing = new RecordingBacking(unchanged);
        const store = openStore(backing);
        expect(await store.load()).toHaveLength(backlogCount);
        const backlogBytes = [...backing.values.values()].reduce((total, value) => total + value.byteLength, 0);
        expect(backlogBytes).toBe(expectedBacklogBytes);
        const originalValues = new Map(backing.values);
        const startupReads = backing.reads.length;
        const startupListings = backing.listings.length;
        const row = queueRow("new-item", 120);
        const processing: QueueRow = { ...row, kind: "processing", payload: duplicateDoc };

        await store.commit([{ kind: "upsert", row }]);
        await store.commit([{ kind: "upsert", row: processing }]);
        await store.commit([{ kind: "delete", id: row.id }]);

        const key = `${rowPrefix}${row.id}`;
        expect(backing.batches).toEqual([
            [{ kind: "upsert", key, valueBytes: 202 }],
            [{ kind: "upsert", key, valueBytes: 210 }],
            [{ kind: "delete", key, valueBytes: 0 }],
        ]);
        expect(backing.reads).toHaveLength(startupReads);
        expect(backing.listings).toHaveLength(startupListings);
        expect(backing.values.size).toBe(originalValues.size);
        for (const [unchangedKey, value] of originalValues) {
            expect(backing.values.get(unchangedKey)).toBe(value);
        }
    });

    it("does not open a write batch when the delta is empty", async () => {
        const backing = new RecordingBacking();
        const store = openStore(backing);
        await store.load();

        await store.commit([]);
        expect(backing.batches).toEqual([]);
    });

    it("migrates all legacy kinds in their original order and restores them after reopening", async () => {
        const secondDoc = { ...duplicateDoc, _id: "another-doc", _attachments: { notes: { stub: true } } };
        const secondPending = { ...pending, documentId: secondDoc._id, resources: ["remote"], state: "waiting" };
        const secondAttempt = { ...attempt, documentId: secondDoc._id, kind: "automatic" };
        const backing = new RecordingBacking([
            [
                legacyKey,
                {
                    queued: [secondDoc, duplicateDoc, duplicateDoc, ...Array.from({ length: 9 }, () => secondDoc)],
                    processing: [duplicateDoc, secondDoc],
                    pendingReflections: [secondPending, pending],
                    recoveryAttempts: [secondAttempt, attempt],
                },
            ],
            ["unrelated", "keep"],
        ]);
        const restored = await openStore(backing).load();
        expect(restored.map(({ kind }) => kind)).toEqual([
            "processing",
            "processing",
            ...Array.from({ length: 12 }, () => "queued"),
            "pendingReflection",
            "pendingReflection",
            "recoveryAttempt",
            "recoveryAttempt",
        ]);
        expect(restored.slice(0, 5)).toEqual([
            { kind: "processing", id: "legacy:processing:0", order: 0, payload: duplicateDoc },
            { kind: "processing", id: "legacy:processing:1", order: 1, payload: secondDoc },
            { kind: "queued", id: "legacy:queued:0", order: 0, payload: secondDoc },
            { kind: "queued", id: "legacy:queued:1", order: 1, payload: duplicateDoc },
            { kind: "queued", id: "legacy:queued:2", order: 2, payload: duplicateDoc },
        ]);
        expect(restored.slice(-4).map(({ order, payload }) => [order, payload])).toEqual([
            [0, secondPending],
            [1, pending],
            [0, secondAttempt],
            [1, attempt],
        ]);
        expect(new Set(restored.map(({ id }) => id)).size).toBe(restored.length);
        expect(backing.batches).toHaveLength(1);
        expect(backing.batches[0]).toHaveLength(restored.length + 1);
        expect(backing.batches[0].at(-1)).toEqual({ kind: "delete", key: legacyKey, valueBytes: 0 });
        expect(backing.values.has(legacyKey)).toBe(false);
        expect(await backing.read("unrelated")).toBe("keep");

        expect(await openStore(backing).load()).toEqual(restored);
        expect(backing.batches).toHaveLength(1);
    });

    it("restores queue rows from a snapshot with obsolete control metadata and null optional arrays", async () => {
        const backing = new RecordingBacking([
            [
                legacyKey,
                {
                    queued: [duplicateDoc],
                    processing: [duplicateDoc],
                    databaseId: "old-database",
                    invalidControlObserved: true,
                    observedFeatures: ["old-feature"],
                    observedGeneration: 1,
                    pendingReflections: null,
                    recoveryAttempts: null,
                },
            ],
        ]);
        const restored = [{ ...queueRow("legacy:processing:0"), kind: "processing" }, queueRow("legacy:queued:0")];
        expect(await openStore(backing).load()).toEqual(restored);
        expect(backing.values.has(legacyKey)).toBe(false);
        expect(await openStore(backing).load()).toEqual(restored);
    });

    it("retains legacy pending payloads for the host to validate independently", async () => {
        const incompletePending = { reason: "offline" };
        const backing = new RecordingBacking([
            [
                legacyKey,
                { queued: [duplicateDoc], processing: [], pendingReflections: [null, incompletePending, pending] },
            ],
        ]);
        const restored = [
            queueRow("legacy:queued:0"),
            { kind: "pendingReflection", id: "legacy:pendingReflection:0", order: 0, payload: null },
            { kind: "pendingReflection", id: "legacy:pendingReflection:1", order: 1, payload: incompletePending },
            { kind: "pendingReflection", id: "legacy:pendingReflection:2", order: 2, payload: pending },
        ];
        expect(await openStore(backing).load()).toEqual(restored);
        expect(await openStore(backing).load()).toEqual(restored);
    });

    it("retains non-null legacy attempt payloads for the host to interpret", async () => {
        const attempts = [7, [], false, "", attempt];
        const backing = new RecordingBacking([
            [legacyKey, { queued: [duplicateDoc], processing: [], recoveryAttempts: attempts }],
        ]);
        const restored = [
            queueRow("legacy:queued:0"),
            ...attempts.map((payload, order) => ({
                kind: "recoveryAttempt",
                id: `legacy:recoveryAttempt:${order}`,
                order,
                payload,
            })),
        ];

        expect(await openStore(backing).load()).toEqual(restored);
        expect(backing.values.has(legacyKey)).toBe(false);
        expect(await openStore(backing).load()).toEqual(restored);
    });

    it.each([null, undefined])("keeps a legacy snapshot with a %s attempt payload intact", async (payload) => {
        const legacy = { queued: [duplicateDoc], processing: [], recoveryAttempts: [payload] };
        const backing = new RecordingBacking([[legacyKey, legacy]]);
        const initialValues = new Map(backing.values);
        vi.spyOn(backing, "read").mockResolvedValueOnce(legacy);

        await expect(openStore(backing).load()).rejects.toThrow(/recoveryAttempts/);
        expect(backing.batches).toEqual([]);
        expect(backing.values).toEqual(initialValues);
    });

    it("retries a legacy snapshot with neither optional field after migration rolls back", async () => {
        const backing = new RecordingBacking([[legacyKey, { queued: [duplicateDoc, duplicateDoc], processing: [] }]]);
        const initialValues = new Map(backing.values);
        const store = openStore(backing);
        backing.failAfterStagedOperation = 1;

        await expect(store.load()).rejects.toThrow("Injected failure");
        expect(backing.batches[0]).toEqual([
            { kind: "upsert", key: `${rowPrefix}legacy:queued:0`, valueBytes: expect.any(Number) },
        ]);
        expect(backing.values).toEqual(initialValues);
        await expect(store.commit([{ kind: "upsert", row: queueRow("new-item") }])).rejects.toThrow(/load|discard/i);
        expect(backing.batches).toHaveLength(1);

        const restored = await openStore(backing).load();
        expect(restored).toEqual([queueRow("legacy:queued:0", 0), queueRow("legacy:queued:1", 1)]);
        expect(await openStore(backing).load()).toEqual(restored);
        expect(backing.batches).toHaveLength(2);
    });

    it("rolls back a normal batch and retries recovery changes alongside the original row ID", async () => {
        const backing = new RecordingBacking();
        const store = openStore(backing);
        expect(await store.load()).toEqual([]);
        expect(backing.batches).toEqual([]);
        const queued = queueRow("first");
        const processing: QueueRow = { ...queued, kind: "processing", payload: duplicateDoc };
        const pendingRow = { kind: "pendingReflection", id: "retained", order: 0, payload: pending } as const;
        const attemptRow = { kind: "recoveryAttempt", id: "reserved", order: 0, payload: attempt } as const;
        await store.commit([{ kind: "upsert", row: queued }]);
        backing.failAfterStagedOperation = 2;
        const delta = [
            { kind: "upsert", row: processing },
            { kind: "upsert", row: pendingRow },
            { kind: "upsert", row: attemptRow },
        ] as const;

        await expect(store.commit(delta)).rejects.toThrow("Injected failure");
        expect(backing.batches[1].map(({ key }) => key)).toEqual([`${rowPrefix}first`, `${rowPrefix}retained`]);
        expect(await openStore(backing).load()).toEqual([queued]);

        await store.commit(delta);
        expect(await openStore(backing).load()).toEqual([processing, pendingRow, attemptRow]);
        const reviewed = { ...pendingRow, payload: { ...pending, reason: "interrupted" } };
        await store.commit([
            { kind: "delete", id: processing.id },
            { kind: "upsert", row: reviewed },
            { kind: "delete", id: attemptRow.id },
        ]);
        expect(await openStore(backing).load()).toEqual([reviewed]);
    });

    it("blocks writes after a read failure and permits a fresh successful load", async () => {
        const backing = new RecordingBacking([[`${rowPrefix}first`, queueRow("first")]]);
        const store = openStore(backing);
        expect(await store.load()).toEqual([queueRow("first")]);
        const failure = new Error("read unavailable");
        const read = backing.read.bind(backing);
        vi.spyOn(backing, "read").mockImplementation(async (key) => {
            if (key === `${rowPrefix}first`) {
                throw failure;
            }
            return await read(key);
        });

        await expect(store.load()).rejects.toBe(failure);
        await expect(store.commit([{ kind: "delete", id: "first" }])).rejects.toThrow(/load|discard/i);
        expect(backing.batches).toEqual([]);

        vi.restoreAllMocks();
        expect(await store.load()).toEqual([queueRow("first")]);
        await store.commit([{ kind: "delete", id: "first" }]);
        expect(await openStore(backing).load()).toEqual([]);
    });

    it.each([
        {
            name: "mixed formats",
            entries: [
                [legacyKey, { queued: [], processing: [] }],
                [`${rowPrefix}first`, queueRow("first")],
            ],
        },
        { name: "a null legacy value", entries: [[legacyKey, null]] },
        {
            name: "an invalid optional legacy field",
            entries: [[legacyKey, { queued: [duplicateDoc], processing: [], recoveryAttempts: {} }]],
        },
        {
            name: "a malformed document representation",
            entries: [[legacyKey, { queued: [duplicateDoc, null], processing: [] }]],
        },
        { name: "a row with an invalid order", entries: [[`${rowPrefix}first`, queueRow("first", -1)]] },
        { name: "a row with the wrong ID", entries: [[`${rowPrefix}first`, queueRow("replacement")]] },
        { name: "an unsupported row version", entries: [["replication-result-queue:v2:first", queueRow("first")]] },
    ] satisfies { name: string; entries: readonly (readonly [string, unknown])[] }[])(
        "keeps $name intact and rejects load",
        async ({ entries }) => {
            const backing = new RecordingBacking(entries);
            const initialValues = new Map(backing.values);
            const store = openStore(backing);
            await expect(store.load()).rejects.toThrow();
            await expect(store.commit([{ kind: "upsert", row: queueRow("new-item") }])).rejects.toThrow(
                /load|discard/i
            );
            expect(backing.batches).toEqual([]);
            expect(backing.values).toEqual(initialValues);
        }
    );

    it("discards both formats without replay, retaining the old data on failure", async () => {
        const backing = new RecordingBacking([
            [legacyKey, { queued: [duplicateDoc], processing: [] }],
            [`${rowPrefix}old-item`, queueRow("old-item")],
            ["replication-result-queue-other:v1:unrelated", "keep also"],
            ["other-setting", "keep"],
        ]);
        const initialValues = new Map(backing.values);
        const store = openStore(backing);
        backing.failAfterStagedOperation = 1;
        await expect(store.discard()).rejects.toThrow("Injected failure");
        expect(backing.batches[0]).toHaveLength(1);
        expect(backing.values).toEqual(initialValues);
        await expect(store.commit([{ kind: "upsert", row: queueRow("new-item") }])).rejects.toThrow(/load|discard/i);

        await store.discard();
        expect(backing.batches[1]).toHaveLength(2);
        expect(backing.reads).toEqual([]);
        expect([...backing.values.keys()]).toEqual(["replication-result-queue-other:v1:unrelated", "other-setting"]);

        const replacement = queueRow("replacement");
        await store.commit([{ kind: "upsert", row: replacement }]);
        await store.commit([{ kind: "delete", id: "old-item" }]);
        expect(await openStore(backing).load()).toEqual([replacement]);
    });

    it("lets the host recover the prior queue after a logical reset batch fails", async () => {
        const storeBacking = new RecordingBacking();
        const store = openStore(storeBacking);
        await store.load();
        const active = { kind: "processing", id: "working", order: 0, payload: duplicateDoc } as const;
        const ordinary = queueRow("ordinary", 0);
        const held = queueRow("held", 1);
        const recovery = { kind: "pendingReflection", id: "pending", order: 0, payload: pending } as const;
        const reservation = { kind: "recoveryAttempt", id: "attempt", order: 0, payload: attempt } as const;
        const priorQueue = [active, ordinary, held, recovery, reservation];
        await store.commit(priorQueue.map((row) => ({ kind: "upsert", row })));
        const reset = [held, recovery, reservation].map(({ id }) => ({ kind: "delete", id }) as const);

        storeBacking.failAfterStagedOperation = 2;
        await expect(store.commit(reset)).rejects.toThrow("Injected failure");
        expect(await store.load()).toEqual(priorQueue);

        await store.commit(reset);
        expect(await openStore(storeBacking).load()).toEqual([active, ordinary]);
    });
});
