import { describe, expect, it } from "vitest";
import type { EntryDoc } from "@lib/common/types.ts";
import { decodeJournalRecords, serializeDoc } from "./journalRecords.ts";

const encoder = new TextEncoder();

describe("serializeDoc", () => {
    const metadata = {
        _id: "notes/journal.md",
        _rev: "3-current",
        _revisions: { start: 3, ids: ["current", "parent", "root"] },
        type: "plain",
        path: "notes/journal.md",
        children: ["h:chunk"],
        customField: { retained: true },
    } as EntryDoc;
    const chunk = {
        _id: "h:chunk",
        _rev: "1-chunk",
        type: "leaf",
        data: "first\nsecond\rthird\\fourth",
    } as EntryDoc;

    it.each([
        ["Metadata JSON", metadata, `${JSON.stringify(metadata)}\n`],
        ["compact Chunk with escaped newlines", chunk, "~h:chunk\u001f\\ffirst\\nsecond\\rthird\\\\fourth\n"],
    ])("serialises %s", (_name, doc, expected) => {
        expect(serializeDoc(doc)).toEqual(encoder.encode(expected));
    });

    it("round trips Metadata fields and revision ancestry", () => {
        expect(decodeJournalRecords(serializeDoc(metadata))).toEqual({ ok: true, docs: [metadata] });
    });
});

describe("decodeJournalRecords", () => {
    const jsonChunk = {
        _id: "h:json-chunk",
        _rev: "2-json",
        type: "leaf",
        data: "raw chunk data",
        isCorrupted: false,
    };
    const metadata = {
        _id: "notes/journal.md",
        _rev: "2-parent",
        _revisions: { start: 2, ids: ["parent", "root"] },
        type: "plain",
        path: "notes/journal.md",
        children: ["h:json-chunk"],
    };
    const compactChunk = {
        _id: "h:compact-chunk",
        data: "line one\nline two\rwith \\ slash",
        type: "leaf",
        _rev: "",
    };

    it.each([
        ["empty input", new Uint8Array(), { ok: true, docs: [] }],
        [
            "Metadata JSON and revision ancestry",
            encoder.encode(`${JSON.stringify(metadata)}\n`),
            { ok: true, docs: [metadata] },
        ],
        ["JSON Chunk", encoder.encode(`${JSON.stringify(jsonChunk)}\n`), { ok: true, docs: [jsonChunk] }],
        [
            "compact Chunk and escaped newlines",
            encoder.encode("~h:compact-chunk\u001f\\fline one\\nline two\\rwith \\\\ slash\n"),
            { ok: true, docs: [compactChunk] },
        ],
        ["empty frame", encoder.encode("\n"), { ok: false, stage: "parse" }],
        ["malformed JSON", encoder.encode('{"_id":\n'), { ok: false, stage: "parse" }],
        ["non-object JSON", encoder.encode("null\n"), { ok: false, stage: "parse" }],
        ["missing document identity", encoder.encode('{"_rev":"1-a"}\n'), { ok: false, stage: "parse" }],
        ["empty document identity", encoder.encode('{"_id":"","_rev":"1-a"}\n'), { ok: false, stage: "parse" }],
        ["missing Metadata revision", encoder.encode('{"_id":"notes/journal.md"}\n'), { ok: false, stage: "parse" }],
        [
            "empty Metadata revision",
            encoder.encode('{"_id":"notes/journal.md","_rev":""}\n'),
            { ok: false, stage: "parse" },
        ],
        [
            "malformed JSON Chunk fields",
            encoder.encode('{"_id":"h:chunk","_rev":"1-a"}\n'),
            { ok: false, stage: "parse" },
        ],
        ["compact frame without separator", encoder.encode("~h:chunk\n"), { ok: false, stage: "parse" }],
        ["compact frame with invalid identity", encoder.encode("~h:\u001fdata\n"), { ok: false, stage: "parse" }],
        ["truncated final frame", encoder.encode(`${JSON.stringify(metadata)}`), { ok: false, stage: "parse" }],
        ["invalid UTF-8", new Uint8Array([0xff, 0x0a]), { ok: false, stage: "decode" }],
        [
            "valid record followed by an invalid record",
            encoder.encode(`${JSON.stringify(metadata)}\n{bad json}\n`),
            { ok: false, stage: "parse" },
        ],
    ] as const)("decodes %s", (_name, input, expected) => {
        const result = decodeJournalRecords(input);
        expect(result).toEqual(expected);
        if (expected.ok === false) {
            expect(result).not.toHaveProperty("docs");
        }
    });
});
