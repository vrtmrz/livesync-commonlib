import { describe, expect, it } from "vitest";
import type { DocumentID, FilePathWithPrefix } from "./models/db.type";
import { getPath, getPathWithoutPrefix } from "../string_and_binary/path";
import { isDeletedEntry, isTextDocument, readAsBlob, readContent } from "./utils";

describe("document information views", () => {
    it("resolves paths without requiring content or file properties", () => {
        const reference = {
            _id: "i:.obsidian/app.json" as DocumentID,
            path: "i:.obsidian/app.json" as FilePathWithPrefix,
        };
        expect(getPath(reference)).toBe("i:.obsidian/app.json");
        expect(getPathWithoutPrefix(reference)).toBe(".obsidian/app.json");
    });

    it.each([
        [{}, false],
        [{ deleted: true }, true],
        [{ _deleted: true }, true],
        [{ deleted: false, _deleted: false }, false],
    ])("checks deletion flags independently of content", (value, expected) => {
        expect(isDeletedEntry(value)).toBe(expected);
    });

    it("preserves text interpretation and legacy path fallback", async () => {
        const path = "note.md" as FilePathWithPrefix;
        const content = { path, type: "newnote" as const, datatype: "newnote" as const, data: ["日本語", " text"] };
        expect(isTextDocument({ path, type: "newnote" })).toBe(true);
        expect(readContent(content)).toBe("日本語 text");
        expect(await readAsBlob(content).text()).toBe("日本語 text");
    });

    it("decodes binary content without database or timestamp fields", async () => {
        const content = { path: "attachment.bin" as FilePathWithPrefix, type: "newnote" as const, data: "AP8B" };
        expect(isTextDocument(content)).toBe(false);
        expect(new Uint8Array(await readAsBlob(content).arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
    });
});
