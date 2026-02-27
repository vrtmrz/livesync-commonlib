import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DatabaseWriteLayer } from "./DatabaseWriteLayer";
import { LiveSyncError } from "../../common/LSError";
import type { DocumentID, EntryLeaf } from "../../common/types";
import type { WriteResult } from "./types.ts";

// Set up PouchDB with memory adapter
PouchDB.plugin(MemoryAdapter);
let dbCounter = 0;

function createMockLeaf(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        type: "leaf" as any,
        data: data,
    } as EntryLeaf;
}

function createMockNextFn() {
    return vi.fn().mockResolvedValue({
        result: true,
        processed: { cached: 0, hotPack: 0, written: 0, duplicated: 0 },
    } as WriteResult);
}

describe("DatabaseWriteLayer", () => {
    let db: PouchDB.Database<any>;
    let writeLayer: DatabaseWriteLayer;

    beforeEach(() => {
        // Create a unique in-memory database for each test
        dbCounter++;
        db = new PouchDB(`test-dwl-${dbCounter}`, { adapter: "memory" });
        writeLayer = new DatabaseWriteLayer(db);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("should initialize with a database", () => {
        expect(writeLayer).toBeDefined();
    });

    it("should call next for empty chunks array", async () => {
        const nextFn = vi.fn().mockResolvedValue({
            result: true,
            processed: { cached: 0, hotPack: 0, written: 0, duplicated: 0 },
        } as WriteResult);

        const result = await writeLayer.write([], {}, "origin-1" as DocumentID, nextFn);

        expect(nextFn).toHaveBeenCalledWith([]);
        expect(result).toEqual({
            result: true,
            processed: { cached: 0, hotPack: 0, written: 0, duplicated: 0 },
        });
    });

    it("should write a single chunk to database", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        const result = await writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn);

        expect(result.result).toBe(true);
        expect(result.processed.written).toBe(1);
        expect(result.processed.duplicated).toBe(0);
        expect(nextFn).toHaveBeenCalledWith([chunk]);

        // Verify chunk was written to database
        const doc = await db.get("chunk-1");
        expect(doc._id).toBe("chunk-1");
        expect(doc.data).toBe("data-chunk-1");
    });

    it("should write multiple chunks to database", async () => {
        const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];
        const nextFn = createMockNextFn();

        const result = await writeLayer.write(chunks, undefined, "origin-1" as DocumentID, nextFn);

        expect(result.result).toBe(true);
        expect(result.processed.written).toBe(3);
        expect(result.processed.duplicated).toBe(0);
        expect(nextFn).toHaveBeenCalledWith(chunks);

        // Verify all chunks were written
        const doc1 = await db.get("chunk-1");
        const doc2 = await db.get("chunk-2");
        const doc3 = await db.get("chunk-3");
        expect(doc1._id).toBe("chunk-1");
        expect(doc2._id).toBe("chunk-2");
        expect(doc3._id).toBe("chunk-3");
    });

    it("should use new_edits=true when force=false (default)", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        // Mock bulkDocs to verify options
        const bulkDocsSpy = vi.spyOn(db, "bulkDocs");

        await writeLayer.write([chunk], { force: false }, "origin-1" as DocumentID, nextFn);

        expect(bulkDocsSpy).toHaveBeenCalledWith([chunk], { new_edits: true });
    });

    it("should use new_edits=false when force=true", async () => {
        // For force=true (new_edits=false), PouchDB requires _rev field
        const chunk = {
            ...createMockLeaf("chunk-1"),
            _rev: "1-abc123",
        };
        const nextFn = createMockNextFn();

        // Mock bulkDocs to verify options
        const bulkDocsSpy = vi.spyOn(db, "bulkDocs");

        await writeLayer.write([chunk], { force: true }, "origin-1" as DocumentID, nextFn);

        expect(bulkDocsSpy).toHaveBeenCalledWith([chunk], { new_edits: false });
    });

    it("should handle 409 conflicts (duplicated chunks)", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        // First write
        await writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn);

        // Second write (should cause 409 conflict)
        const result = await writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn);

        expect(result.result).toBe(true);
        expect(result.processed.written).toBe(0); // No new writes
        expect(result.processed.duplicated).toBe(1); // One duplicate detected
    });

    it("should handle mixed success and conflict results", async () => {
        const chunk1 = createMockLeaf("chunk-1");
        const chunk2 = createMockLeaf("chunk-2");
        const nextFn = createMockNextFn();

        // Write chunk-1 first
        await writeLayer.write([chunk1], {}, "origin-1" as DocumentID, nextFn);

        // Try to write chunk-1 again along with new chunk-2
        const result = await writeLayer.write([chunk1, chunk2], {}, "origin-1" as DocumentID, nextFn);

        expect(result.result).toBe(true);
        expect(result.processed.written).toBe(1); // Only chunk-2 written
        expect(result.processed.duplicated).toBe(1); // chunk-1 duplicated
    });

    it("should throw LiveSyncError for non-409 database errors", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        // Mock bulkDocs to return a non-409 error
        vi.spyOn(db, "bulkDocs").mockResolvedValue([
            {
                id: "chunk-1",
                error: "forbidden",
                status: 403,
                name: "forbidden",
                message: "forbidden",
            },
        ] as any);

        await expect(writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn)).rejects.toThrow(LiveSyncError);

        await expect(writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn)).rejects.toThrow(
            "Failed to write chunks"
        );
    });

    it("should throw LiveSyncError when database operation fails", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        // Mock bulkDocs to throw an error
        vi.spyOn(db, "bulkDocs").mockRejectedValue(new Error("Database connection lost"));

        await expect(writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn)).rejects.toThrow(LiveSyncError);

        await expect(writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn)).rejects.toThrow(
            "Database write layer error"
        );
    });

    it("should preserve LiveSyncError when re-thrown", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        const originalError = new LiveSyncError("Custom error", { status: 500 });
        vi.spyOn(db, "bulkDocs").mockRejectedValue(originalError);

        await expect(writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn)).rejects.toThrow(originalError);
    });

    it("should return correct WriteResult structure", async () => {
        const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2")];
        const nextFn = createMockNextFn();

        const result = await writeLayer.write(chunks, {}, "origin-1" as DocumentID, nextFn);

        expect(result).toHaveProperty("result");
        expect(result).toHaveProperty("processed");
        expect(result.processed).toHaveProperty("cached");
        expect(result.processed).toHaveProperty("hotPack");
        expect(result.processed).toHaveProperty("written");
        expect(result.processed).toHaveProperty("duplicated");
        expect(typeof result.result).toBe("boolean");
        expect(typeof result.processed.cached).toBe("number");
        expect(typeof result.processed.hotPack).toBe("number");
        expect(typeof result.processed.written).toBe("number");
        expect(typeof result.processed.duplicated).toBe("number");
    });

    it("should set cached and hotPack to 0 in WriteResult", async () => {
        const chunk = createMockLeaf("chunk-1");
        const nextFn = createMockNextFn();

        const result = await writeLayer.write([chunk], {}, "origin-1" as DocumentID, nextFn);

        expect(result.processed.cached).toBe(0);
        expect(result.processed.hotPack).toBe(0);
    });
});
