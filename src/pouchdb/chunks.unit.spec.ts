import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopAllRunningProcessors } from "octagonal-wheels/concurrency/processor";
import type { EntryLeaf } from "@lib/common/types";
import { transferChunks } from "./chunks";

type ChunkDocument = EntryLeaf & { _rev: string };
type KeyOptions = { keys: string[]; include_docs?: boolean };

function chunk(id: string, revision: string, data: string): ChunkDocument {
    return {
        _id: id as ChunkDocument["_id"],
        _rev: revision,
        type: "leaf",
        data,
    } as ChunkDocument;
}

function database<TBulk extends (...args: never[]) => Promise<unknown> = () => Promise<unknown>>(
    allDocs: (options: KeyOptions) => Promise<unknown>,
    bulkDocs?: TBulk
) {
    const mock = {
        allDocs: vi.fn(allDocs),
        bulkDocs: bulkDocs ? vi.fn(bulkDocs) : vi.fn(async () => []),
    };
    return { ...mock, pouch: mock as unknown as PouchDB.Database };
}

function expectBatchSizes(sizes: number[], total: number, limit: number): void {
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((size) => size > 0 && size <= limit)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(total);
    expect(sizes.some((size) => size < limit)).toBe(true);
}

async function advanceUntil(predicate: () => boolean, message: string, maxSteps = 100): Promise<void> {
    for (let step = 0; step < maxSteps && !predicate(); step++) {
        await vi.advanceTimersByTimeAsync(100);
    }
    expect(predicate(), message).toBe(true);
}

async function completeTransfer(transfer: Promise<boolean>): Promise<boolean> {
    let settled = false;
    let result: boolean | undefined;
    let failure: unknown;
    const observed = transfer.then(
        (value) => {
            settled = true;
            result = value;
        },
        (error: unknown) => {
            settled = true;
            failure = error;
        }
    );

    await advanceUntil(() => settled, "transferChunks should finish after its queued work drains");
    await observed;
    if (failure !== undefined) throw failure;
    return result as boolean;
}

describe("transferChunks", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        stopAllRunningProcessors();
        vi.useRealTimers();
    });

    it("transfers partial final batches, skips existing or missing chunks, and preserves revisions", async () => {
        const items = Array.from({ length: 127 }, (_, index) => ({
            id: `h:chunk-${String(index).padStart(4, "0")}`,
            rev: `3-revision-${index}`,
        }));
        const alreadyPresent = chunk(items[0].id, "2-existing", "keep this exact value");
        const destinationDocs = new Map([[alreadyPresent._id, alreadyPresent]]);
        const sourceDocs = new Map(
            items
                .slice(0, -2)
                .map((item, index) => [item.id, chunk(item.id, item.rev, `source-content-${index}`)] as const)
        );

        const bulkDocs = vi.fn(async (docs: ChunkDocument[], _options: { new_edits?: boolean }) => {
            for (const doc of docs) destinationDocs.set(doc._id, doc);
            return docs.map((doc) => ({ ok: true, id: doc._id, rev: doc._rev }));
        });
        const target = database(
            async ({ keys }) => ({
                rows: keys.map((id) => {
                    const doc = destinationDocs.get(id as ChunkDocument["_id"]);
                    return doc
                        ? { id, key: id, value: { rev: doc._rev } }
                        : { key: id, error: "not_found" as const };
                }),
            }),
            bulkDocs
        );
        const source = database(async ({ keys }) => ({
            rows: keys.map((id) => {
                const doc = sourceDocs.get(id);
                return doc
                    ? { id, key: id, value: { rev: doc._rev }, doc }
                    : { key: id, error: "not_found" as const };
            }),
        }));
        const result = await completeTransfer(
            transferChunks("unit", "source -> target", source.pouch, target.pouch, items)
        );

        expect(result).toBe(true);
        const targetBatchSizes = target.allDocs.mock.calls
            .map(([options]) => options.keys.length);
        expectBatchSizes(targetBatchSizes, items.length, 50);

        const sourceBatchSizes = source.allDocs.mock.calls
            .map(([options]) => options.keys.length);
        expectBatchSizes(sourceBatchSizes, items.length - 1, 25);
        expect(source.allDocs.mock.calls.every(([options]) => options.include_docs === true)).toBe(true);
        const requestedFromSource = source.allDocs.mock.calls.flatMap(([options]) => options.keys);
        expect(requestedFromSource.sort()).toEqual(items.slice(1).map(({ id }) => id).sort());

        const bulkBatchSizes = bulkDocs.mock.calls.map(([docs]) => docs.length);
        expectBatchSizes(bulkBatchSizes, sourceDocs.size - 1, 100);
        expect(bulkDocs.mock.calls.every(([, options]) => options.new_edits === false)).toBe(true);
        const transferredIds = bulkDocs.mock.calls.flatMap(([docs]) => docs.map((doc) => doc._id));
        expect(transferredIds).not.toContain(alreadyPresent._id);
        expect(transferredIds).not.toContain(items[items.length - 2].id);
        expect(transferredIds).not.toContain(items[items.length - 1].id);

        const expectedDocs = [
            ...[...sourceDocs.values()].filter((doc) => doc._id !== alreadyPresent._id),
            alreadyPresent,
        ].sort((a, b) => a._id.localeCompare(b._id));
        expect([...destinationDocs.values()].sort((a, b) => a._id.localeCompare(b._id))).toEqual(expectedDocs);
    });

    it("keeps the transfer pending until the downstream bulkDocs call finishes", async () => {
        const item = { id: "h:slow", rev: "4-source" };
        const sourceDoc = chunk(item.id, item.rev, "slow content");
        let releaseBulkDocs!: () => void;
        const bulkDocsGate = new Promise<void>((resolve) => {
            releaseBulkDocs = resolve;
        });
        let bulkDocsStarted = false;
        let settled = false;

        const source = database(async ({ keys }) => ({
            rows: keys.map((id) => ({ id, key: id, value: { rev: sourceDoc._rev }, doc: sourceDoc })),
        }));
        const bulkDocs = vi.fn(async () => {
            bulkDocsStarted = true;
            await bulkDocsGate;
        });
        const target = database(
            async ({ keys }) => ({
                rows: keys.map((id) => ({ key: id, error: "not_found" as const })),
            }),
            bulkDocs
        );

        const transfer = transferChunks("slow", "source -> target", source.pouch, target.pouch, [item]).then(
            (result) => {
                settled = true;
                return result;
            }
        );

        try {
            await advanceUntil(() => bulkDocsStarted, "bulkDocs should receive the fetched chunk");
            expect(settled).toBe(false);
        } finally {
            releaseBulkDocs();
        }

        expect(await completeTransfer(transfer)).toBe(true);
    });

    it("completes when its explicitly caught bulkDocs write fails", async () => {
        const item = { id: "h:write-error", rev: "2-source" };
        const sourceDoc = chunk(item.id, item.rev, "source content");
        const bulkDocs = vi.fn(async () => {
            throw new Error("write failed");
        });
        const source = database(async ({ keys }) => ({
            rows: keys.map((id) => ({ id, key: id, value: { rev: sourceDoc._rev }, doc: sourceDoc })),
        }));
        const target = database(
            async ({ keys }) => ({
                rows: keys.map((id) => ({ key: id, error: "not_found" as const })),
            }),
            bulkDocs
        );

        await expect(
            completeTransfer(transferChunks("error", "source -> target", source.pouch, target.pouch, [item]))
        ).resolves.toBe(true);
        expect(bulkDocs).toHaveBeenCalledOnce();
    });

    it("completes immediately for empty input", async () => {
        const source = database(async () => ({ rows: [] }));
        const target = database(async () => ({ rows: [] }));

        await expect(
            completeTransfer(transferChunks("empty", "source -> target", source.pouch, target.pouch, []))
        ).resolves.toBe(true);
        expect(source.allDocs).not.toHaveBeenCalled();
        expect(target.allDocs).not.toHaveBeenCalled();
        expect(target.bulkDocs).not.toHaveBeenCalled();
    });
});
