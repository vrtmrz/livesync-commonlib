import { describe, expect, it } from "vitest";
import type { ProcessingEntry } from "./journalRecords.ts";
import {
    assessChunkWrites,
    hasJournalWriteErrors,
    journalMetadataRevisions,
    partitionJournalDocuments,
    selectChunksToSave,
    selectMetadataToSave,
} from "./journalReceive.ts";

function doc(id: string, rev: string): ProcessingEntry {
    return {
        _id: id,
        _rev: rev,
        _revisions: { start: 2, ids: [rev.slice(2), "root"] },
        type: "plain",
    } as ProcessingEntry;
}

describe("Journal document preparation", () => {
    it("partitions records without changing their order, content, or revision ancestry", () => {
        const entries = [doc("note", "2-a"), doc("h:a", "1-chunk"), doc("note", "2-b"), doc("h:b", "1-chunk")];
        const before = structuredClone(entries);
        const result = partitionJournalDocuments(entries);
        expect(result).toEqual({ chunks: [entries[1], entries[3]], docs: [entries[0], entries[2]] });
        expect(result.docs[0]).toBe(entries[0]);
        expect(entries).toEqual(before);
    });

    it("selects absent Chunks with fresh revisions without modifying the transferred records", () => {
        const existing = doc("h:existing", "2-existing");
        const missing = doc("h:missing", "2-remote");
        const result = selectChunksToSave([existing, missing], [{ id: "h:existing" }, { error: "not_found" }]);
        expect(result).toEqual([{ ...missing, _rev: undefined }]);
        expect(result[0]).not.toBe(missing);
        expect(missing._rev).toBe("2-remote");
    });

    it("rejects an unavailable Chunk inspection instead of treating it as absence", () => {
        expect(() => selectChunksToSave([doc("h:a", "1-a")], [{ id: "h:a", error: "unavailable" }])).toThrow(
            "Could not inspect existing Chunks"
        );
    });

    it("selects exact missing Metadata revisions and retains both conflict branches", () => {
        const entries = [doc("note", "2-a"), doc("other", "2-c"), doc("note", "2-b")];
        const before = structuredClone(entries);
        expect(journalMetadataRevisions(entries)).toEqual({ note: ["2-a", "2-b"], other: ["2-c"] });
        const selected = selectMetadataToSave(entries, { note: { missing: ["2-b"] } });
        expect(selected).toEqual([entries[2]]);
        expect(selected[0]).toBe(entries[2]);
        expect(entries).toEqual(before);
    });
});

describe("Journal write result assessment", () => {
    it.each([
        {
            name: "all requested Chunks",
            results: [
                { id: "h:a", ok: true },
                { id: "h:b", ok: true },
            ],
            ids: ["h:a", "h:b"],
            failed: false,
        },
        { name: "a partial response", results: [{ id: "h:a", ok: true }], ids: ["h:a"], failed: true },
        {
            name: "a failed row",
            results: [
                { id: "h:a", ok: true },
                { id: "h:b", error: "unavailable" },
            ],
            ids: ["h:a"],
            failed: true,
        },
        { name: "an empty response", results: [], ids: [], failed: true },
        { name: "unrelated successful rows", results: [{ id: "h:other", ok: true }], ids: [], failed: true },
    ])("reports persisted Chunks and completion for $name", ({ results, ids, failed }) => {
        const chunks = [doc("h:a", ""), doc("h:b", "")];
        const result = assessChunkWrites(chunks, results as (PouchDB.Core.Error | PouchDB.Core.Response)[]);
        expect(result.persisted.map((entry) => entry._id)).toEqual(ids);
        expect(result.failed).toBe(failed);
        for (const entry of result.persisted) expect(chunks).toContain(entry);
    });

    it("accepts no writes when all Chunks already exist", () => {
        expect(assessChunkWrites([], [])).toEqual({ persisted: [], failed: false });
    });

    it("accepts the empty successful response used by new_edits:false", () => {
        expect(hasJournalWriteErrors([])).toBe(false);
    });

    it("rejects a Metadata response containing an error even alongside successful rows", () => {
        expect(
            hasJournalWriteErrors([
                { id: "note", rev: "2-a", ok: true },
                { id: "other", error: "write-failed" },
            ])
        ).toBe(true);
    });
});
