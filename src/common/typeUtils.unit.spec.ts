import { describe, expect, it } from "vitest";
import type { FilePath, FilePathWithPrefix, UXFileInfoStub } from "./types";
import { getDatabasePathFromUXFileInfo, getStoragePathFromUXFileInfo } from "./typeUtils";

describe("file path conversion", () => {
    it.each(["Folder/Poem: Example.md", "Folder/A:B:C.md", "Poem: Example.md"])(
        "preserves an ordinary path from both strings and file information: %s",
        (path) => {
            const file = {
                path: path as FilePath,
                name: path,
                stat: { type: "file", size: 1, ctime: 1, mtime: 1 },
            } satisfies UXFileInfoStub;
            for (const input of [file, path]) {
                expect(getStoragePathFromUXFileInfo(input)).toBe(path);
                expect(getDatabasePathFromUXFileInfo(input)).toBe(path);
            }
        }
    );

    it("keeps an internal file path intact when adding or removing its namespace", () => {
        const path = ".obsidian/Poem: Example.md" as FilePath;
        const prefixed = `i:${path}` as FilePathWithPrefix;
        const file = {
            path,
            isInternal: true,
            name: path,
            stat: { type: "file", size: 1, ctime: 1, mtime: 1 },
        } satisfies UXFileInfoStub;
        expect(getStoragePathFromUXFileInfo(file)).toBe(path);
        expect(getDatabasePathFromUXFileInfo(file)).toBe(prefixed);
        expect(getStoragePathFromUXFileInfo(prefixed)).toBe(path);
        expect(getDatabasePathFromUXFileInfo(prefixed)).toBe(prefixed);
    });
});
