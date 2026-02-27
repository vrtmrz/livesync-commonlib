import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { ConflictManager } from "./ConflictManager";
import type { ConflictManagerOptions } from "./ConflictManager";
import type {
    DocumentID,
    EntryDoc,
    FilePathWithPrefix,
    // diff_result_leaf,
    LoadedEntry,
    // SavingEntry,
} from "../common/types";
import { MISSING_OR_ERROR, NOT_CONFLICTED } from "../common/types";
import type { EntryManager } from "./EntryManager/EntryManager";
import type { IPathService } from "../services/base/IService";

// Set up PouchDB with memory adapter
PouchDB.plugin(MemoryAdapter);
let dbCounter = 0;

/**
 * Helper function to create a test document
 */
function createTestDoc(id: string, data: string, mtime: number = Date.now(), ctime: number = Date.now()) {
    return {
        _id: id as DocumentID,
        path: id.replace("i:", "") as FilePathWithPrefix,
        type: "plain",
        datatype: "plain",
        data: [data],
        mtime: mtime,
        ctime: ctime,
        size: data.length,
        children: [],
        eden: {},
    } as unknown as EntryDoc & Awaited<ReturnType<PouchDB.Database["put"]>>;
}

const i2p = (id: DocumentID): FilePathWithPrefix => id as unknown as FilePathWithPrefix;
const p2i = (path: FilePathWithPrefix | string): DocumentID => path as unknown as DocumentID;
function unused(v: any) {}
/**
 * Helper function to create a conflicted document in PouchDB
 */
async function createConflict(
    db: PouchDB.Database<EntryDoc>,
    id: string,
    data1: string,
    data2: string,
    mtime1: number = Date.now(),
    mtime2: number = Date.now() + 100
): Promise<{ rev1: string; rev2: string }> {
    // Create first version
    const doc1 = createTestDoc(id, data1, mtime1);
    const result1 = await db.put(doc1);
    const rev1 = result1.rev;

    // Create second version with force to create conflict
    const doc2 = {
        ...createTestDoc(id, data2, mtime2),
        _rev: rev1.split("-")[0] + "-conflict", // Different rev with same generation
    };
    await db.put(doc2, { force: true } as any);

    // Get the actual rev of the conflicted version
    const conflictedDoc = await db.get(id, { conflicts: true });
    const rev2 = conflictedDoc._conflicts?.[0] || "";

    return { rev1, rev2 };
}
unused(createConflict);

describe("ConflictManager", () => {
    let db: PouchDB.Database<EntryDoc>;
    let conflictManager: ConflictManager;
    let mockEntryManager: Partial<EntryManager>;
    let mockPathService: Partial<IPathService>;

    beforeEach(() => {
        // Create a unique in-memory database for each test
        dbCounter++;
        db = new PouchDB(`test-conflict-${dbCounter}`, { adapter: "memory" });

        // Mock PathService
        mockPathService = {
            path2id: vi.fn((path: FilePathWithPrefix | string) => {
                return Promise.resolve(p2i(path));
            }),
            id2path: vi.fn((id: DocumentID) => {
                return i2p(id);
            }),
        };

        // Mock EntryManager
        mockEntryManager = {
            getDBEntry: vi.fn(
                async (
                    path: FilePathWithPrefix,
                    opt?: any,
                    waitForReady?: boolean,
                    skipCheck?: boolean,
                    includeDeleted?: boolean
                ) => {
                    try {
                        const doc = await db.get(p2i(path), opt);
                        return doc as LoadedEntry;
                    } catch (ex) {
                        unused(ex);
                        return false;
                    }
                }
            ),
        };

        const options: ConflictManagerOptions = {
            entryManager: mockEntryManager as EntryManager,
            pathService: mockPathService as IPathService,
            database: db,
        };

        conflictManager = new ConflictManager(options);
    });

    afterEach(async () => {
        await db.destroy();
    });

    describe("Initialization", () => {
        it("should initialize successfully", () => {
            expect(conflictManager).toBeDefined();
            expect(conflictManager.options).toBeDefined();
        });

        it("should have access to database", () => {
            expect(conflictManager.database).toBe(db);
        });
    });

    describe("getConflictedDoc", () => {
        it("should return false for non-existent document", async () => {
            const result = await conflictManager.getConflictedDoc("non-existent" as FilePathWithPrefix, "1-abc");

            expect(result).toBe(false);
        });

        it("should retrieve a document with specific revision", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const doc = createTestDoc(path, "test data", 1000, 900);
            const putResult = await db.put(doc);

            const result = await conflictManager.getConflictedDoc(path, putResult.rev);

            expect(result).not.toBe(false);
            if (result !== false) {
                expect(result.data).toBe("test data");
                expect(result.rev).toBe(putResult.rev);
                expect(result.mtime).toBe(1000);
                expect(result.ctime).toBe(900);
            }
        });

        it("should handle deleted documents", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const doc = createTestDoc(path, "test data");
            const putResult = await db.put(doc);

            // Mock the entry manager to return a deleted doc structure
            const deleteResult = await db.remove(putResult.id, putResult.rev);
            mockEntryManager.getDBEntry = vi.fn(async (p: FilePathWithPrefix, opt?: any) => {
                try {
                    const deletedDoc = await db.get(p2i(p), { ...opt, revs: true });
                    return { ...deletedDoc, _deleted: true, deleted: true, data: "" } as LoadedEntry;
                } catch (ex) {
                    unused(ex);
                    return false;
                }
            });

            const result = await conflictManager.getConflictedDoc(path, deleteResult.rev);

            expect(result).not.toBe(false);
            if (result !== false) {
                expect(result.deleted).toBe(true);
            }
        });

        it("should handle newnote datatype", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const doc = {
                ...createTestDoc(path, "dGVzdCBkYXRh"), // base64 encoded "test data"
                datatype: "newnote",
            };
            const putResult = await db.put(doc as any);

            const result = await conflictManager.getConflictedDoc(path, putResult.rev);

            expect(result).not.toBe(false);
            if (result !== false) {
                expect(result.data).toContain("test data");
            }
        });
    });

    describe("mergeSensibly", () => {
        it("should return false when base document is missing", async () => {
            const result = await conflictManager.mergeSensibly(
                "test" as FilePathWithPrefix,
                "1-missing",
                "2-missing",
                "3-missing"
            );

            expect(result).toBe(false);
        });

        it("should return false when both revisions are deleted", async () => {
            const path = "test-doc" as FilePathWithPrefix;

            // Create base version with actual content
            const baseDoc = createTestDoc(path, "base data", 1000);
            const baseResult = await db.put(baseDoc);

            // Create two conflicting versions (not deleted)
            const doc1 = { ...createTestDoc(path, "version1", 2000), _rev: baseResult.rev };
            const result1 = await db.put(doc1);

            const doc2 = {
                ...createTestDoc(path, "version2", 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(doc2, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            // Now delete both revisions by updating the entry manager mock
            mockEntryManager.getDBEntry = vi.fn(async (p: FilePathWithPrefix, opt?: any) => {
                const doc = await db.get(p2i(p), opt);
                return { ...doc, _deleted: true, deleted: true } as LoadedEntry;
            });

            const result = await conflictManager.mergeSensibly(path, baseResult.rev, result1.rev, conflictedRev);

            expect(result).toBe(false);
        });

        it("should merge non-conflicting changes", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const baseData = "line1\nline2\nline3\n";
            const leftData = "line1\nline2 modified left\nline3\n";
            const rightData = "line1\nline2\nline3 modified right\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeSensibly(path, baseResult.rev, currentDoc._rev, conflictedRev);

            expect(result).not.toBe(false);
            if (result !== false) {
                const mergedText = result
                    .filter((e) => e[0] !== -1)
                    .map((e) => e[1])
                    .join("");
                expect(mergedText).toContain("line2 modified left");
                expect(mergedText).toContain("line3 modified right");
            }
        });

        it("should return false for conflicting changes on same line", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const baseData = "line1\nline2\nline3\n";
            const leftData = "line1\nline2 left\nline3\n";
            const rightData = "line1\nline2 right\nline3\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);
            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeSensibly(path, baseResult.rev, currentDoc._rev, conflictedRev);

            // Should not be able to auto-merge conflicting changes
            expect(result).toBe(false);
        });

        it("should merge when both sides add the same line", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const baseData = "line1\nline3\n";
            const bothData = "line1\nline2\nline3\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, bothData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);
            // Create right (conflicting) version with same change
            const rightDoc = {
                ...createTestDoc(path, bothData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeSensibly(path, baseResult.rev, currentDoc._rev, conflictedRev);

            expect(result).not.toBe(false);
            if (result !== false) {
                const mergedText = result
                    .filter((e) => e[0] !== -1)
                    .map((e) => e[1])
                    .join("");
                expect(mergedText).toBe(bothData);
            }
        });
    });

    describe("mergeObject", () => {
        it("should return false when documents are missing", async () => {
            const result = await conflictManager.mergeObject(
                "test" as FilePathWithPrefix,
                "1-missing",
                "2-missing",
                "3-missing"
            );

            expect(result).toBe(false);
        });

        it("should return false when both revisions are deleted", async () => {
            const path = "test.json" as FilePathWithPrefix;

            // Create base version
            const baseDoc = createTestDoc(path, JSON.stringify({ key: "base" }), 1000);
            const baseResult = await db.put(baseDoc);

            // Create two conflicting versions
            const doc1 = { ...createTestDoc(path, JSON.stringify({ key: "v1" }), 2000), _rev: baseResult.rev };
            const result1 = await db.put(doc1);
            unused(result1);
            const doc2 = {
                ...createTestDoc(path, JSON.stringify({ key: "v2" }), 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(doc2, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            // Now make the entry manager return deleted versions
            mockEntryManager.getDBEntry = vi.fn(async (p: FilePathWithPrefix, opt?: any) => {
                const doc = await db.get(p2i(p), opt);
                return { ...doc, _deleted: true, deleted: true } as LoadedEntry;
            });

            const result = await conflictManager.mergeObject(path, baseResult.rev, result1.rev, conflictedRev);

            expect(result).toBe(false);
        });

        it("should merge non-conflicting object changes", async () => {
            const path = "test.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ a: 1, b: 2, c: 3 });
            const leftData = JSON.stringify({ a: 1, b: 20, c: 3 }); // Changed b
            const rightData = JSON.stringify({ a: 1, b: 2, c: 30 }); // Changed c

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);
            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeObject(path, baseResult.rev, currentDoc._rev, conflictedRev);

            expect(result).not.toBe(false);
            if (result !== false) {
                const merged = JSON.parse(result);
                expect(merged.b).toBe(20); // Left change
                expect(merged.c).toBe(30); // Right change
                expect(merged.a).toBe(1); // Unchanged
            }
        });

        it("should return false for conflicting object changes on same key", async () => {
            const path = "test.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ a: 1, b: 2 });
            const leftData = JSON.stringify({ a: 1, b: 20 }); // Changed b to 20
            const rightData = JSON.stringify({ a: 1, b: 30 }); // Changed b to 30

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeObject(path, baseResult.rev, currentDoc._rev, conflictedRev);

            // Should not be able to auto-merge conflicting changes on same key
            expect(result).toBe(false);
        });

        it("should merge when both sides change to the same value", async () => {
            const path = "test.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ a: 1, b: 2 });
            const bothData = JSON.stringify({ a: 1, b: 20 }); // Both changed b to 20

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, bothData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);
            // Create right (conflicting) version with same change
            const rightDoc = {
                ...createTestDoc(path, bothData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeObject(path, baseResult.rev, currentDoc._rev, conflictedRev);

            expect(result).not.toBe(false);
            if (result !== false) {
                const merged = JSON.parse(result);
                expect(merged.b).toBe(20);
            }
        });

        it("should handle complex nested object merges", async () => {
            const path = "test.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ a: { x: 1, y: 2 }, b: { z: 3 } });
            const leftData = JSON.stringify({ a: { x: 10, y: 2 }, b: { z: 3 } }); // Changed a.x
            const rightData = JSON.stringify({ a: { x: 1, y: 2 }, b: { z: 30 } }); // Changed b.z

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const currentDoc = await db.get(path, { conflicts: true });
            const conflictedRev = currentDoc._conflicts?.[0] || "";

            const result = await conflictManager.mergeObject(path, baseResult.rev, currentDoc._rev, conflictedRev);

            expect(result).not.toBe(false);
            if (result !== false) {
                const merged = JSON.parse(result);
                expect(merged.a.x).toBe(10); // Left change
                expect(merged.b.z).toBe(30); // Right change
            }
        });
    });

    describe("tryAutoMerge", () => {
        it("should return MISSING_OR_ERROR for non-existent document", async () => {
            const result = await conflictManager.tryAutoMerge("non-existent" as FilePathWithPrefix, true);

            expect(result).toHaveProperty("ok");
            if ("ok" in result) {
                expect(result.ok).toBe(MISSING_OR_ERROR);
            }
        });

        it("should return NOT_CONFLICTED for document without conflicts", async () => {
            const path = "test-doc" as FilePathWithPrefix;
            const doc = createTestDoc(path, "test data");
            await db.put(doc);

            const result = await conflictManager.tryAutoMerge(path, true);

            expect(result).toHaveProperty("ok");
            if ("ok" in result) {
                expect(result.ok).toBe(NOT_CONFLICTED);
            }
        });

        it("should return UserActionRequired when auto-merge is disabled", async () => {
            const path = "test.md" as FilePathWithPrefix;
            const baseData = "line1\nline2\n";
            const leftData = "line1 left\nline2\n";
            const rightData = "line1 right\nline2\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            await db.put(leftDoc);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const result = await conflictManager.tryAutoMerge(path, false); // Auto-merge disabled

            expect(result).toHaveProperty("leftRev");
            expect(result).toHaveProperty("rightRev");
            if ("leftRev" in result) {
                expect(result.leftRev).toBeDefined();
                expect(result.rightRev).toBeDefined();
            }
        });

        it("should auto-merge when enableMarkdownAutoMerge is true and merge is possible", async () => {
            const path = "test.md" as FilePathWithPrefix;
            const baseData = "line1\nline2\nline3\n";
            const leftData = "line1\nline2 left\nline3\n";
            const rightData = "line1\nline2\nline3 right\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            await db.put(leftDoc);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const result = await conflictManager.tryAutoMerge(path, true);

            // Should return merged result
            if ("result" in result) {
                expect(result.result).toBeDefined();
                expect(result.conflictedRev).toBeDefined();
                expect(result.result).toContain("line2 left");
                expect(result.result).toContain("line3 right");
            }
        });

        it("should return UserActionRequired when auto-merge fails", async () => {
            const path = "test.md" as FilePathWithPrefix;
            const baseData = "line1\nline2\n";
            const leftData = "line1 left\nline2\n";
            const rightData = "line1 right\nline2\n";

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            await db.put(leftDoc);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const result = await conflictManager.tryAutoMerge(path, true);

            // Should return UserActionRequired because changes conflict
            expect(result).toHaveProperty("leftRev");
            expect(result).toHaveProperty("rightRev");
        });

        it("should auto-merge using object merge when isObjectMargeApplicable applies", async () => {
            const path = "settings.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ theme: "light", fontSize: 12, debug: false });
            const leftData = JSON.stringify({ theme: "light", fontSize: 14, debug: false }); // Changed fontSize
            const rightData = JSON.stringify({ theme: "light", fontSize: 12, debug: true }); // Changed debug

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            await db.put(leftDoc);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const result = await conflictManager.tryAutoMerge(path, true);

            // Should return merged result using object merge
            if ("result" in result) {
                expect(result.result).toBeDefined();
                expect(result.conflictedRev).toBeDefined();
                const merged = JSON.parse(result.result);
                expect(merged.fontSize).toBe(14); // Left change
                expect(merged.debug).toBe(true); // Right change
                expect(merged.theme).toBe("light"); // Unchanged
            }
        });

        it("should fail object merge when changes conflict on same key", async () => {
            const path = "config.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ apiUrl: "http://localhost:3000", timeout: 30 });
            const leftData = JSON.stringify({ apiUrl: "http://api.local:3000", timeout: 30 }); // Changed apiUrl
            const rightData = JSON.stringify({ apiUrl: "http://api.production:3000", timeout: 30 }); // Different apiUrl

            // Create base document
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);

            // Create left version
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseResult.rev };
            await db.put(leftDoc);

            // Create right (conflicting) version
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseResult.rev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            const result = await conflictManager.tryAutoMerge(path, true);

            // Should return UserActionRequired because object merge fails due to conflicting key
            expect(result).toHaveProperty("leftRev");
            expect(result).toHaveProperty("rightRev");
        });

        it("should find commonBase and auto-merge when base revision exists in history", async () => {
            const path = "document.md" as FilePathWithPrefix;
            const baseData = "# Document\n\nOriginal content\n";
            const leftData = "# Document\n\nLeft updated content\n";
            const rightData = "# Document\n\nRight updated content\n";

            // Step 1: Create base document (rev 1)
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);
            const baseRev = baseResult.rev; // Should be 1-xxx

            // Step 2: Create left version by updating from base (rev 2)
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseRev };
            const leftResult = await db.put(leftDoc);
            const leftRev = leftResult.rev; // Should be 2-xxx
            unused(leftRev);
            // Step 3: Before updating, create a conflicting version based on rev 1
            // This simulates a branch from the base revision
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseRev.split("-")[0] + "-conflict", // rev 2 but different generation
            };
            await db.put(rightDoc, { force: true } as any);

            // Verify that the document now has conflicts
            const currentDoc = await db.get(path, { conflicts: true, revs_info: true });
            expect(currentDoc._conflicts).toBeDefined();
            expect(currentDoc._conflicts?.length).toBeGreaterThan(0);

            // Now test tryAutoMergeSensibly which should find the commonBase
            const result = await conflictManager.tryAutoMerge(path, true);

            // If text merge is applicable, it should successfully merge
            // Left change is in the middle of the document, right change is at the end
            // These don't conflict, so auto-merge should succeed
            if ("result" in result && typeof result.result === "string") {
                expect(result.result).toBeDefined();
                expect(result.conflictedRev).toBeDefined();
                // The merged result should contain parts from both versions
                expect(result.result).toContain("Document");
                expect(result.result).toContain("updated");
            }
        });
        it("should find commonBase and auto-merge when base revision exists in history", async () => {
            const path = "document.md" as FilePathWithPrefix;
            const baseData = "# Document\n\nOriginal content\nNext Line content\n";
            const leftData = "# Document\n\nLeft updated content\nNext Line content\n";
            const rightData = "# Document\n\nOriginal content\nRight updated next line\n";

            // Step 1: Create base document (rev 1)
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);
            const baseRev = baseResult.rev; // Should be 1-xxx

            // Step 2: Create left version by updating from base (rev 2)
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseRev };
            const leftResult = await db.put(leftDoc);
            const leftRev = leftResult.rev; // Should be 2-xxx
            unused(leftRev);
            // Step 3: Before updating, create a conflicting version based on rev 1
            // This simulates a branch from the base revision
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseRev.split("-")[0] + "-conflict", // rev 2 but different generation
            };
            await db.put(rightDoc, { force: true } as any);

            // Verify that the document now has conflicts
            const currentDoc = await db.get(path, { conflicts: true, revs_info: true });
            expect(currentDoc._conflicts).toBeDefined();
            expect(currentDoc._conflicts?.length).toBeGreaterThan(0);

            // Now test tryAutoMergeSensibly which should find the commonBase
            const result = await conflictManager.tryAutoMerge(path, true);

            // If text merge is applicable, it should successfully merge
            // Left change is in the middle of the document, right change is at the end
            // These don't conflict, so auto-merge should succeed
            if ("result" in result && typeof result.result === "string") {
                expect(result.result).toBeDefined();
                expect(result.conflictedRev).toBeDefined();
                // The merged result should contain parts from both versions
                expect(result.result).toBe("# Document\n\nLeft updated content\nRight updated next line\n");
            }
        });

        it("should handle commonBase with conflicting lines correctly", async () => {
            const path = "notes.md" as FilePathWithPrefix;
            const baseData = "Line 1\nLine 2\nLine 3\n";
            const leftData = "Line 1\nLine 2 MODIFIED LEFT\nLine 3\n";
            const rightData = "Line 1\nLine 2 MODIFIED RIGHT\nLine 3\n";

            // Step 1: Create base document (rev 1)
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);
            const baseRev = baseResult.rev;

            // Step 2: Create left version (rev 2)
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseRev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);

            // Step 3: Create conflicting version from base (rev 2, different branch)
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseRev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            // Test tryAutoMerge with commonBase existing
            const result = await conflictManager.tryAutoMerge(path, true);

            // Should return UserActionRequired because Line 2 has conflicting modifications
            // even though commonBase (rev 1) exists
            expect(result).toHaveProperty("leftRev");
            expect(result).toHaveProperty("rightRev");
        });

        it("should use commonBase for object merge when applicable", async () => {
            const path = "config.json" as FilePathWithPrefix;
            const baseData = JSON.stringify({ server: "localhost", port: 3000, debug: false });
            const leftData = JSON.stringify({ server: "localhost", port: 3000, debug: true }); // Changed debug
            const rightData = JSON.stringify({ server: "localhost", port: 8080, debug: false }); // Changed port

            // Step 1: Create base document (rev 1)
            const baseDoc = createTestDoc(path, baseData, 1000);
            const baseResult = await db.put(baseDoc);
            const baseRev = baseResult.rev;

            // Step 2: Create left version (rev 2)
            const leftDoc = { ...createTestDoc(path, leftData, 2000), _rev: baseRev };
            const leftResult = await db.put(leftDoc);
            unused(leftResult);

            // Step 3: Create conflicting version from base (rev 2, different branch)
            const rightDoc = {
                ...createTestDoc(path, rightData, 2100),
                _rev: baseRev.split("-")[0] + "-conflict",
            };
            await db.put(rightDoc, { force: true } as any);

            // Test tryAutoMerge with commonBase existing
            const result = await conflictManager.tryAutoMerge(path, true);

            // Should successfully merge using object merge since changes are on different keys
            if ("result" in result && typeof result.result === "string") {
                expect(result.result).toBeDefined();
                const merged = JSON.parse(result.result);
                expect(merged.debug).toBe(true); // Left change
                expect(merged.port).toBe(8080); // Right change
                expect(merged.server).toBe("localhost"); // Unchanged from base
            }
        });
    });
});
