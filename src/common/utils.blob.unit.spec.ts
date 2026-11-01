import { describe, expect, it } from "vitest";
import type { DocumentID, FilePathWithPrefix, LoadedEntry } from "./types";
import { createBinaryBlob, createBlob, createTextBlob, isDocContentSame, isTextBlob, readAsBlob } from "./utils";

function binaryEntry(overrides: Partial<LoadedEntry> = {}): LoadedEntry {
    return {
        _id: "attachment.bin" as DocumentID,
        path: "attachment.bin" as FilePathWithPrefix,
        type: "newnote",
        datatype: "newnote",
        children: [],
        eden: {},
        ctime: 0,
        mtime: 0,
        size: 3,
        data: "AP8B",
        ...overrides,
    };
}

describe("legacy Blob construction contracts", () => {
    it("preserves existing Blob identity and MIME type through createBlob", () => {
        const existing = new Blob(["payload"], { type: "application/custom" });
        expect(createBlob(existing)).toBe(existing);
        expect(createBlob(existing).type).toBe("application/custom");
        expect(createBlob.name).toBe("createBlob");
    });

    it("preserves text parts, transparent line endings, and native string conversion", async () => {
        const parts = ["first\r", "\n日本語 🐙\0"];
        for (const create of [createTextBlob, createBlob]) {
            const blob = create(parts);
            expect(await blob.text()).toBe("first\r\n日本語 🐙\0");
            expect(blob.type).toBe("text/plain");
            expect(await create(["\ud83d", "\udc19"]).text()).toBe("\ufffd\ufffd");
            expect(create([]).size).toBe(0);
        }
    });

    it("keeps binary views bounded and snapshots their bytes", async () => {
        for (const create of [createBinaryBlob, createBlob]) {
            const bytes = new Uint8Array([255, 0, 128, 254, 255]);
            const blob = create(bytes.subarray(1, 4));
            bytes.fill(17);
            expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 128, 254]));
            expect(blob.type).toBe("application/octet-stream");
            expect(create(new ArrayBuffer(0)).size).toBe(0);
        }
    });

    it("retains the exact plain-text MIME predicate", () => {
        expect(isTextBlob(createTextBlob("text"))).toBe(true);
        expect(isTextBlob(createBinaryBlob(new ArrayBuffer(0)))).toBe(false);
        expect(isTextBlob(new Blob(["text"], { type: "text/plain;charset=utf-8" }))).toBe(false);
        expect(isTextBlob(new Blob(["text"], { type: "text/markdown" }))).toBe(false);
    });
});

describe("Commonlib document interpretation", () => {
    it.each([
        { type: "plain" as const, datatype: "newnote" as const },
        { type: "newnote" as const, datatype: "plain" as const },
    ])("keeps text selected by type=$type or datatype=$datatype", async (classification) => {
        const text = "first\r\n日本語";
        const doc = binaryEntry({
            ...classification,
            data: ["first\r", "\n日本語"],
            size: new TextEncoder().encode(text).length,
        });
        const blob = readAsBlob(doc);
        expect(blob.type).toBe("text/plain");
        expect(await blob.text()).toBe(text);
    });

    it("decodes stored binary content before constructing a Blob", async () => {
        const blob = readAsBlob(binaryEntry());
        expect(blob.type).toBe("application/octet-stream");
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
    });

    it("compares content bytes independently of their representation or MIME type", async () => {
        expect(await isDocContentSame(["first", "second"], "firstsecond")).toBe(true);
        expect(await isDocContentSame(new Blob(["same"], { type: "application/custom" }), "same")).toBe(true);
        expect(await isDocContentSame("one", "two")).toBe(false);
        expect(await isDocContentSame("short", "longer")).toBe(false);
        expect(await isDocContentSame([], new ArrayBuffer(0))).toBe(true);
    });
});
