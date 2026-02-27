import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DatabaseReadLayer } from "./DatabaseReadLayer";
import { LiveSyncError } from "../../common/LSError";
import type { DocumentID, EntryLeaf } from "../../common/types";

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

describe("DatabaseReadLayer", () => {
    let db: PouchDB.Database<any>;
    let readLayer: DatabaseReadLayer;

    beforeEach(() => {
        // Create a unique in-memory database for each test
        dbCounter++;
        db = new PouchDB(`test-drl-${dbCounter}`, { adapter: "memory" });
        readLayer = new DatabaseReadLayer(db);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("should initialize with a database", () => {
        expect(readLayer).toBeDefined();
    });

    it("should return empty array for empty ids", async () => {
        const result = await readLayer.read([], {}, vi.fn());
        expect(result).toEqual([]);
    });

    it("should read a leaf from database", async () => {
        const leaf = createMockLeaf("chunk-1");
        await db.put(leaf);

        const result = await readLayer.read(["chunk-1" as DocumentID], {}, vi.fn());

        expect(result).toHaveLength(1);
        expect((result[0] as any)?._id).toBe("chunk-1");
        expect((result[0] as any)?.type).toBe("leaf");
    });

    it("should return false for non-existent chunks", async () => {
        const nextFn = vi.fn().mockResolvedValue([false]);
        const result = await readLayer.read(["non-existent" as DocumentID], {}, nextFn);

        expect(result).toEqual([false]);
        expect(nextFn).toHaveBeenCalled();
    });

    it("should call next layer for missing chunks", async () => {
        const leaf1 = createMockLeaf("chunk-1");
        await db.put(leaf1);

        const leaf2 = createMockLeaf("chunk-2");
        const nextFn = vi.fn().mockResolvedValue([leaf2]);

        const result = await readLayer.read(["chunk-1" as DocumentID, "chunk-2" as DocumentID], {}, nextFn);

        expect(result).toHaveLength(2);
        expect((result[0] as any)?._id).toBe("chunk-1");
        expect((result[1] as any)?._id).toBe("chunk-2");
        expect(nextFn).toHaveBeenCalledWith(["chunk-2" as DocumentID]);
    });

    it("should not call next layer if all chunks found", async () => {
        const leaf1 = createMockLeaf("chunk-1");
        const leaf2 = createMockLeaf("chunk-2");
        await db.bulkDocs([leaf1, leaf2]);

        const nextFn = vi.fn();
        const result = await readLayer.read(["chunk-1" as DocumentID, "chunk-2" as DocumentID], {}, nextFn);

        expect(result).toHaveLength(2);
        expect(nextFn).not.toHaveBeenCalled();
    });

    it("should merge results from database and next layer", async () => {
        const leaf1 = createMockLeaf("chunk-1");
        const leaf3 = createMockLeaf("chunk-3");
        await db.bulkDocs([leaf1, leaf3]);

        const leaf2 = createMockLeaf("chunk-2");
        const leaf4 = createMockLeaf("chunk-4");
        const nextFn = vi.fn().mockResolvedValue([leaf2, leaf4]);

        const result = await readLayer.read(
            ["chunk-1" as DocumentID, "chunk-2" as DocumentID, "chunk-3" as DocumentID, "chunk-4" as DocumentID],
            {},
            nextFn
        );

        expect(result).toHaveLength(4);
        expect((result[0] as any)?._id).toBe("chunk-1");
        expect((result[1] as any)?._id).toBe("chunk-2");
        expect((result[2] as any)?._id).toBe("chunk-3");
        expect((result[3] as any)?._id).toBe("chunk-4");
    });
    it("should merge results (including not found) from database and next layer", async () => {
        const leaf1 = createMockLeaf("chunk-1");
        const leaf3 = createMockLeaf("chunk-3");
        await db.bulkDocs([leaf1, leaf3]);

        // const leaf2 = createMockLeaf("chunk-2");
        const leaf4 = createMockLeaf("chunk-4");
        const nextFn = vi.fn().mockResolvedValue([false, leaf4]);

        const result = await readLayer.read(
            ["chunk-1" as DocumentID, "chunk-2" as DocumentID, "chunk-3" as DocumentID, "chunk-4" as DocumentID],
            {},
            nextFn
        );
        expect(result).toHaveLength(4);
        expect((result[0] as any)?._id).toBe("chunk-1");
        expect(result[1] as any).toBe(false);
        expect((result[2] as any)?._id).toBe("chunk-3");
        expect((result[3] as any)?._id).toBe("chunk-4");
    });

    it("should throw error for wrong type", async () => {
        const wrongDoc = { _id: "wrong", type: "NOTE", data: "data" };
        await db.put(wrongDoc);

        await expect(readLayer.read(["wrong" as DocumentID], {}, vi.fn())).rejects.toThrow(LiveSyncError);
    });

    it("should throw error for missing type", async () => {
        const noTypeDoc = { _id: "no-type", data: "data" };
        await db.put(noTypeDoc);

        await expect(readLayer.read(["no-type" as DocumentID], {}, vi.fn())).rejects.toThrow(LiveSyncError);
    });

    it("should handle database errors gracefully", async () => {
        const errorDb = {
            allDocs: vi.fn().mockRejectedValue(new Error("DB error")),
        } as any;
        const errorLayer = new DatabaseReadLayer(errorDb);

        const result = await errorLayer.read(["chunk-1" as DocumentID], {}, vi.fn());

        expect(result).toEqual([false]);
    });

    it("should preserve order of requested ids", async () => {
        const leaves = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];
        await db.bulkDocs(leaves);

        const result = await readLayer.read(
            ["chunk-3" as DocumentID, "chunk-1" as DocumentID, "chunk-2" as DocumentID],
            {},
            vi.fn()
        );

        expect((result[0] as any)?._id).toBe("chunk-3");
        expect((result[1] as any)?._id).toBe("chunk-1");
        expect((result[2] as any)?._id).toBe("chunk-2");
    });
});
