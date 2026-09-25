import { describe, expect, it } from "vitest";
import type { DocumentID, FilePath, FilePathWithPrefix } from "@lib/common/types";
import {
    expandDocumentIDPrefix,
    expandFilePathPrefix,
    id2path_base,
    isFilePath,
    isValidFilenameInAndroid,
    isValidFilenameInDarwin,
    isValidFilenameInLinux,
    isValidFilenameInWidows,
    path2id_base,
    stripAllPrefixes,
    stripPrefix,
} from "./path";

describe("ordinary paths containing colons", () => {
    it.each([
        "Folder/Poem: Example.md",
        "Folder/A:B:C.md",
        "Folder: Poems/Example.md",
        "Poem: Example.md",
        "Folder/i: Example.md",
        "Folder/trailing:",
    ])("preserves the complete path %s", async (value) => {
        const path = value as FilePath;
        expect(isFilePath(path)).toBe(true);
        expect(expandFilePathPrefix(path)).toEqual(["", path]);
        expect(expandDocumentIDPrefix(value as DocumentID)).toEqual(["", path]);
        expect(stripPrefix(path)).toBe(path);
        expect(stripAllPrefixes(path)).toBe(path);
        expect(id2path_base(value as DocumentID)).toBe(path);
        await expect(path2id_base(path, false, false)).resolves.toBe(value);
    });

    it("keeps the filename private and distinct when obfuscating colon paths", async () => {
        const first = await path2id_base("Folder/Poem: Example.md" as FilePath, "test-secret", false);
        const second = await path2id_base("Other/Poem: Example.md" as FilePath, "test-secret", false);
        expect(first).toMatch(/^f:[0-9a-f]{64}$/);
        expect(second).toMatch(/^f:[0-9a-f]{64}$/);
        expect(first).not.toBe(second);
        expect(id2path_base(first, { path: "Folder/Poem: Example.md" as FilePath })).toBe("Folder/Poem: Example.md");
    });

    it.each(["i:", "ix:", "ps:"])("removes only the known %s namespace and keeps the remainder", (prefix) => {
        const path = "Folder/Poem: Part: Example.md";
        const prefixed = `${prefix}${path}` as FilePathWithPrefix;
        expect(isFilePath(prefixed)).toBe(false);
        expect(expandFilePathPrefix(prefixed)).toEqual([prefix, path]);
        expect(stripPrefix(prefixed)).toBe(path);
        expect(stripAllPrefixes(prefixed)).toBe(path);
        expect(id2path_base(prefixed as DocumentID)).toBe(prefixed);
    });

    it("preserves a literal prefix-like component inside an internal path", () => {
        expect(stripAllPrefixes("i:i: Example.md" as FilePathWithPrefix)).toBe("i: Example.md");
    });
});

describe("compatibility: established path and document namespaces", () => {
    it.each(["note.md", "Folder/note.md", "_private/note.md"])("round-trips %s", async (value) => {
        const id = await path2id_base(value as FilePath, false, false);
        expect(id).toBe(value.startsWith("_") ? `/${value}` : value);
        expect(id2path_base(id)).toBe(value);
    });

    it.each(["i:", "ix:", "ps:"])("keeps the existing %s namespace", async (prefix) => {
        const path = `${prefix}folder/note.md` as FilePathWithPrefix;
        expect(stripAllPrefixes(path)).toBe("folder/note.md");
        await expect(path2id_base(path, false, false)).resolves.toBe(path);
        expect(id2path_base(path as DocumentID)).toBe(path);
        const id = await path2id_base(path, "test-secret", false);
        expect(id.startsWith(`${prefix}f:`)).toBe(true);
        expect(() => id2path_base(id)).toThrow("Entry has been obfuscated!");
        expect(id2path_base(id, { path })).toBe(path);
    });
});

describe("colon filename validation", () => {
    it("accepts ordinary colon paths on Darwin and Linux", () => {
        expect(isValidFilenameInDarwin("Folder/Poem: Example.md")).toBe(true);
        expect(isValidFilenameInLinux("Folder/Poem: Example.md")).toBe(true);
    });

    it("retains Windows, Android, and control-character restrictions", () => {
        expect(isValidFilenameInWidows("Folder/Poem: Example.md")).toBe(false);
        expect(isValidFilenameInAndroid("Folder/Poem: Example.md")).toBe(false);
        expect(isValidFilenameInDarwin("Folder/Bad\u0000.md")).toBe(false);
        expect(isValidFilenameInLinux("Folder/Bad\u0000.md")).toBe(false);
    });
});
