import { describe, expect, it, vi } from "vitest";

import {
    analyseDatabaseUsage,
    type DatabaseUsageGetOptions,
    type DatabaseUsageProgress,
    type DatabaseUsageSource,
} from "./usage.ts";

interface FakeRevisionInfo {
    rev: string;
    status: string;
}

interface FakeEntry {
    revisions: FakeRevisionInfo[];
    documents: Record<string, object>;
    currentRevision?: string;
}

function makeSource(
    ids: string[],
    entries: Record<string, FakeEntry>,
    sequences: Array<string | number | undefined> = ["1-abc", "1-abc"]
): DatabaseUsageSource {
    let sequenceIndex = 0;
    return {
        info: vi.fn(async () => {
            const update_seq = sequences[Math.min(sequenceIndex, sequences.length - 1)];
            sequenceIndex++;
            return { update_seq };
        }),
        async *enumerateIds() {
            for (const id of ids) yield id;
        },
        get: vi.fn(async (id: string, options?: DatabaseUsageGetOptions) => {
            const entry = entries[id];
            if (!entry) return null;
            if (options?.revs_info) return { _revs_info: entry.revisions };
            const revision = options?.rev ?? entry.currentRevision ?? entry.revisions[0]?.rev;
            return revision ? (entry.documents[revision] ?? null) : null;
        }),
    };
}

function metadata(id: string, rev: string, path: string, children: string[]): object {
    return { _id: id, _rev: rev, path, children };
}

function chunk(id: string, rev: string, data: string, deleted = false): object {
    return { _id: id, _rev: rev, type: "leaf", data, _deleted: deleted };
}

function rowById(result: Awaited<ReturnType<typeof analyseDatabaseUsage>>, id: string, revision?: string) {
    return result.rows.find((row) => row.id === id && (revision === undefined || row.revision === revision));
}

describe("analyseDatabaseUsage", () => {
    it("reports growing available-revision progress through reading and accounting", async () => {
        const source = makeSource(["first", "second"], {
            first: {
                revisions: [
                    { rev: "1-first", status: "available" },
                    { rev: "2-pruned", status: "pruned" },
                    { rev: "3-missing", status: "missing" },
                ],
                documents: { "1-first": metadata("first", "1-first", "first.md", []) },
            },
            second: {
                revisions: [
                    { rev: "1-failed", status: "available" },
                    { rev: "2-not-found", status: "available" },
                ],
                documents: {},
            },
        });
        const get = source.get as ReturnType<typeof vi.fn>;
        const originalGet = get.getMockImplementation();
        get.mockImplementation(async (id: string, options?: DatabaseUsageGetOptions) => {
            if (id === "second" && options?.rev === "1-failed") throw new Error("private failure");
            if (id === "second" && options?.rev === "2-not-found") return null;
            return originalGet?.(id, options) ?? null;
        });
        const progress: DatabaseUsageProgress[] = [];

        const result = await analyseDatabaseUsage({ source, onProgress: (value) => progress.push(value) });

        expect(progress[0]).toEqual({
            phase: "reading",
            idsProcessed: 0,
            revisionsProcessed: 0,
            processed: 0,
            total: 0,
            totalIsFinal: false,
        });
        const readingProgress = progress.filter(({ phase }) => phase === "reading");
        expect(
            readingProgress.some(
                ({ processed, total, totalIsFinal }) => processed === 0 && total === 1 && totalIsFinal === false
            )
        ).toBe(true);
        expect(
            readingProgress.some(
                ({ processed, total, totalIsFinal }) => processed === 1 && total === 3 && totalIsFinal === false
            )
        ).toBe(true);
        expect(readingProgress.at(-1)).toMatchObject({
            revisionsProcessed: 3,
            processed: 3,
            total: 3,
            totalIsFinal: true,
        });
        const accountingProgress = progress.filter(({ phase }) => phase === "accounting");
        expect(accountingProgress[0]).toMatchObject({ processed: 0, totalIsFinal: true });
        expect(accountingProgress.at(-1)).toMatchObject({
            processed: accountingProgress.at(-1)?.total,
            totalIsFinal: true,
        });
        expect(result.errors).toEqual([
            { code: "revision_read_failed", id: "second", revision: "1-failed" },
            { code: "revision_not_found", id: "second", revision: "2-not-found" },
        ]);
        expect(source.get).not.toHaveBeenCalledWith("first", { rev: "2-pruned" });
        expect(source.get).not.toHaveBeenCalledWith("first", { rev: "3-missing" });
    });

    it("keeps results equal when progress callbacks fail", async () => {
        const makeFixture = () =>
            makeSource(["entry"], {
                entry: {
                    revisions: [{ rev: "1-entry", status: "available" }],
                    documents: { "1-entry": metadata("entry", "1-entry", "entry.md", []) },
                },
            });

        const expected = await analyseDatabaseUsage({ source: makeFixture() });
        const actual = await analyseDatabaseUsage({
            source: makeFixture(),
            onProgress: () => {
                throw new Error("progress observer failed");
            },
        });

        expect(actual).toEqual(expected);
    });

    it("yields during accounting and omits incomplete rows when cancelled", async () => {
        const ids = Array.from({ length: 130 }, (_, index) => `entry-${index}`);
        const entries: Record<string, FakeEntry> = Object.fromEntries(
            ids.map((id, index) => {
                const revision = `1-entry${index}`;
                return [
                    id,
                    {
                        revisions: [{ rev: revision, status: "available" }],
                        documents: { [revision]: metadata(id, revision, `${id}.md`, []) },
                    },
                ] as const;
            })
        );
        const source = makeSource(ids, entries);
        const controller = new AbortController();
        let cancelScheduled = false;
        let eventLoopReached = false;
        const progress: DatabaseUsageProgress[] = [];

        const result = await analyseDatabaseUsage({
            source,
            signal: controller.signal,
            onProgress: (value) => {
                progress.push(value);
                if (value.phase === "accounting" && value.processed === 0 && !cancelScheduled) {
                    cancelScheduled = true;
                    setTimeout(() => {
                        eventLoopReached = true;
                        controller.abort();
                    }, 0);
                }
            },
        });

        expect(eventLoopReached).toBe(true);
        expect(
            progress.some(({ phase, processed, total }) => phase === "accounting" && processed > 0 && processed < total)
        ).toBe(true);
        expect(result.status).toBe("cancelled");
        expect(result.rows).toEqual([]);
    });

    it.each([{ children: "chunk-a" }, { children: ["chunk-a", 7] }, { children: false }])(
        "marks malformed Chunk references as partial without treating the revision as inspected: $children",
        async ({ children }) => {
            const source = makeSource(["broken", "valid", "chunk-a"], {
                broken: {
                    revisions: [{ rev: "1-broken", status: "available" }],
                    documents: {
                        "1-broken": { _id: "broken", _rev: "1-broken", path: "broken.md", children },
                    },
                },
                valid: {
                    revisions: [{ rev: "1-valid", status: "available" }],
                    documents: { "1-valid": metadata("valid", "1-valid", "valid.md", ["chunk-a"]) },
                },
                "chunk-a": {
                    revisions: [{ rev: "1-chunk", status: "available" }],
                    documents: { "1-chunk": chunk("chunk-a", "1-chunk", "retained") },
                },
            });

            const result = await analyseDatabaseUsage({ source });

            expect(result.status).toBe("partial");
            expect(result.errors).toEqual([{ code: "revision_document_invalid", id: "broken", revision: "1-broken" }]);
            expect(rowById(result, "broken")).toBeUndefined();
            expect(rowById(result, "valid")).toMatchObject({ uniqueChunkCount: 1, uniqueChunkSize: 8 });
        }
    );

    it("deduplicates repeated references and classifies first references as unique", async () => {
        const source = makeSource(["note-a", "note-b", "chunk-shared", "chunk-a"], {
            "note-a": {
                revisions: [
                    { rev: "1-a1", status: "available" },
                    { rev: "2-a2", status: "available" },
                    { rev: "3-old", status: "missing" },
                ],
                documents: {
                    "1-a1": metadata("note-a", "1-a1", "a.md", ["chunk-shared", "chunk-shared", "chunk-a"]),
                    "2-a2": metadata("note-a", "2-a2", "a.md", ["chunk-shared"]),
                },
            },
            "note-b": {
                revisions: [{ rev: "1-b1", status: "available" }],
                documents: { "1-b1": metadata("note-b", "1-b1", "b.md", ["chunk-shared"]) },
            },
            "chunk-shared": {
                revisions: [{ rev: "1-c1", status: "available" }],
                documents: { "1-c1": chunk("chunk-shared", "1-c1", "x😀") },
            },
            "chunk-a": {
                revisions: [{ rev: "1-c2", status: "available" }],
                documents: { "1-c2": chunk("chunk-a", "1-c2", "ab") },
            },
        });

        const result = await analyseDatabaseUsage({ source });

        expect(result.status).toBe("complete");
        expect(result.startUpdateSeq).toBe("1-abc");
        expect(result.endUpdateSeq).toBe("1-abc");
        expect(result.changedDuringRun).toBe(false);
        expect(rowById(result, "note-a", "1-a1")).toMatchObject({
            title: "a.md (1-a1)",
            path: "a.md",
            rev: "1",
            revHash: "a1",
            uniqueChunkCount: 2,
            sharedChunkCount: 0,
            uniqueChunkSize: 5,
            sharedChunkSize: 0,
        });
        expect(rowById(result, "note-a", "2-a2")).toMatchObject({
            uniqueChunkCount: 0,
            sharedChunkCount: 1,
            uniqueChunkSize: 0,
            sharedChunkSize: 3,
        });
        expect(rowById(result, "note-b", "1-b1")).toMatchObject({
            uniqueChunkCount: 0,
            sharedChunkCount: 1,
            sharedChunkSize: 3,
        });
        expect(result.rows.at(-1)).toMatchObject({
            id: "__orphan",
            uniqueChunkCount: 0,
            uniqueChunkSize: 0,
        });
        expect(JSON.stringify(result)).not.toContain("x😀");
        expect(source.get).not.toHaveBeenCalledWith("note-a", { rev: "3-old" });
        expect(result.errors).toEqual([]);
    });

    it("counts unreferenced nondeleted chunks in the special orphan row", async () => {
        const source = makeSource(["orphan"], {
            orphan: {
                revisions: [{ rev: "4-orph", status: "available" }],
                documents: { "4-orph": chunk("orphan", "4-orph", "orphan data") },
            },
        });

        const result = await analyseDatabaseUsage({ source });

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            title: "__orphan",
            id: "__orphan",
            path: "__orphan",
            rev: "1",
            revHash: "xxxxx",
            uniqueChunkCount: 1,
            sharedChunkCount: 0,
            uniqueChunkSize: "orphan data".length,
            sharedChunkSize: 0,
        });
    });

    it("marks a run partial when the database changes during analysis", async () => {
        const source = makeSource([], {}, ["before", "after"]);

        const result = await analyseDatabaseUsage({ source });

        expect(result.changedDuringRun).toBe(true);
        expect(result.status).toBe("partial");
    });

    it("marks a run partial when an update sequence is unavailable", async () => {
        const source = makeSource([], {}, [7, undefined]);

        const result = await analyseDatabaseUsage({ source });

        expect(result.status).toBe("partial");
        expect(result.startUpdateSeq).toBe(7);
        expect(result.endUpdateSeq).toBeUndefined();
        expect(result.changedDuringRun).toBeUndefined();
        expect(result.errors).toEqual([{ code: "end_update_seq_unavailable" }]);
    });

    it("does not read the source when cancelled before starting", async () => {
        const source = makeSource(["entry"], {
            entry: {
                revisions: [{ rev: "1-entry", status: "available" }],
                documents: { "1-entry": metadata("entry", "1-entry", "entry.md", []) },
            },
        });
        const enumerateIds = vi.fn(async function* () {
            yield "entry";
        });
        source.enumerateIds = enumerateIds;
        const controller = new AbortController();
        controller.abort();

        const result = await analyseDatabaseUsage({ source, signal: controller.signal });

        expect(result.status).toBe("cancelled");
        expect(result.rows.map((row) => row.id)).toEqual(["__orphan"]);
        expect(source.info).not.toHaveBeenCalled();
        expect(source.get).not.toHaveBeenCalled();
        expect(enumerateIds).not.toHaveBeenCalled();
    });

    it("skips tombstoned chunks and reports an unavailable listed revision as partial", async () => {
        const source = makeSource(["note", "missing", "deleted"], {
            note: {
                revisions: [{ rev: "1-note", status: "available" }],
                documents: { "1-note": metadata("note", "1-note", "note.md", ["deleted"]) },
            },
            missing: {
                revisions: [{ rev: "1-miss", status: "available" }],
                documents: {},
            },
            deleted: {
                revisions: [{ rev: "1-dead", status: "available" }],
                documents: { "1-dead": chunk("deleted", "1-dead", "gone", true) },
            },
        });

        const result = await analyseDatabaseUsage({ source });

        expect(result.status).toBe("partial");
        expect(rowById(result, "note", "1-note")).toMatchObject({
            uniqueChunkCount: 0,
            sharedChunkCount: 0,
            uniqueChunkSize: 0,
            sharedChunkSize: 0,
        });
        expect(result.rows.at(-1)).toMatchObject({ uniqueChunkCount: 0, uniqueChunkSize: 0 });
        expect(result.errors).toEqual([{ code: "revision_not_found", id: "missing", revision: "1-miss" }]);
    });

    it("continues after read errors without exposing database content or raw error messages", async () => {
        const source = makeSource(["bad", "good"], {
            bad: {
                revisions: [{ rev: "1-bad", status: "available" }],
                documents: {},
            },
            good: {
                revisions: [{ rev: "1-good", status: "available" }],
                documents: { "1-good": metadata("good", "1-good", "visible.md", []) },
            },
        });
        const get = source.get as ReturnType<typeof vi.fn>;
        get.mockImplementation(async (id: string, options?: DatabaseUsageGetOptions) => {
            if (id === "bad" && options?.rev) throw new Error("private document body: secret-value");
            if (options?.revs_info)
                return {
                    _revs_info:
                        id === "bad"
                            ? [{ rev: "1-bad", status: "available" }]
                            : [{ rev: "1-good", status: "available" }],
                };
            return id === "good" && options?.rev === "1-good" ? metadata("good", "1-good", "visible.md", []) : null;
        });

        const result = await analyseDatabaseUsage({ source });
        const serialised = JSON.stringify(result);

        expect(result.status).toBe("partial");
        expect(rowById(result, "good", "1-good")).toBeDefined();
        expect(result.errors).toEqual([{ code: "revision_read_failed", id: "bad", revision: "1-bad" }]);
        expect(serialised).not.toContain("private document body");
        expect(serialised).not.toContain("secret-value");
    });

    it("does not add an in-flight revision after the signal aborts", async () => {
        const controller = new AbortController();
        const source = makeSource(
            ["first", "second"],
            {
                first: {
                    revisions: [{ rev: "1-first", status: "available" }],
                    documents: { "1-first": metadata("first", "1-first", "first.md", []) },
                },
                second: {
                    revisions: [{ rev: "1-second", status: "available" }],
                    documents: { "1-second": metadata("second", "1-second", "second.md", []) },
                },
            },
            [7, 8]
        );
        const get = source.get as ReturnType<typeof vi.fn>;
        get.mockImplementation(async (id: string, options?: DatabaseUsageGetOptions) => {
            if (options?.revs_info) {
                const rev = id === "first" ? "1-first" : "1-second";
                return { _revs_info: [{ rev, status: "available" }] };
            }
            if (id === "first" && options?.rev === "1-first") {
                return metadata("first", "1-first", "first.md", []);
            }
            if (id === "second" && options?.rev === "1-second") {
                controller.abort();
                return metadata("second", "1-second", "second.md", []);
            }
            return metadata("second", "1-second", "second.md", []);
        });

        const progress: DatabaseUsageProgress[] = [];
        const result = await analyseDatabaseUsage({
            source,
            signal: controller.signal,
            onProgress: (value) => progress.push(value),
        });

        expect(result.status).toBe("cancelled");
        expect(result.rows.map((row) => row.id)).toEqual(["first", "__orphan"]);
        expect(result.startUpdateSeq).toBe(7);
        expect(result.endUpdateSeq).toBeUndefined();
        expect(result.changedDuringRun).toBeUndefined();
        expect(source.info).toHaveBeenCalledTimes(1);
        expect(
            progress.every(
                ({ idsProcessed, revisionsProcessed }) =>
                    Number.isInteger(idsProcessed) && Number.isInteger(revisionsProcessed)
            )
        ).toBe(true);
        expect(progress.filter(({ phase }) => phase === "reading").at(-1)).toMatchObject({
            revisionsProcessed: 1,
            processed: 1,
            total: 2,
            totalIsFinal: false,
        });
    });
});
