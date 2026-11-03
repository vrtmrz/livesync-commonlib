import { describe, expect, it } from "vitest";
import { normalisePathForIdentity } from "../common/pathNormalization.ts";
import { expandFilePathPrefix } from "../string_and_binary/path.ts";
import {
    parseFilePath,
    parseDocumentPath,
    splitDocumentPath,
    joinDocumentPath,
    getStoragePathComparisonKey,
    getDocumentPathComparisonKey,
} from "./pathComparison.ts";

describe("path comparison and namespaces", () => {
    it.each([0, 1] as const)("preserves version %s comparison bytes and namespace identity", (version) => {
        for (const sensitive of [false, true]) {
            const settings = { pathNormalizationVersion: version, handleFilenameCaseSensitive: sensitive };
            for (const value of ["Résumé.md", "i:.obsidian/Café.json", "ix:folder:name", "ps:日本語"]) {
                const original = value.normalize("NFD");
                const expected = normalisePathForIdentity(original, version);
                expect(getDocumentPathComparisonKey(parseDocumentPath(original), settings)).toBe(
                    sensitive ? expected : expected.toLowerCase()
                );
            }
            expect(getDocumentPathComparisonKey(parseDocumentPath("i:note.md"), settings)).not.toBe(
                getDocumentPathComparisonKey(parseDocumentPath("note.md"), settings)
            );
        }
    });

    it("retains original spelling and makes NFC independent of case handling", () => {
        const original = "Café/Note.md".normalize("NFD");
        const path = parseFilePath(original);
        expect(path).toBe(original);
        expect(
            getStoragePathComparisonKey(path, { pathNormalizationVersion: 1, handleFilenameCaseSensitive: true })
        ).toBe("Café/Note.md");
        expect(
            getStoragePathComparisonKey(path, { pathNormalizationVersion: 1, handleFilenameCaseSensitive: false })
        ).toBe("café/note.md");
        expect(
            getStoragePathComparisonKey(path, { pathNormalizationVersion: 0, handleFilenameCaseSensitive: true })
        ).toBe(original);
    });

    it.each([
        "note.md",
        "i:.obsidian/settings.json",
        "ix:folder:name",
        "ps:legacy",
        "i:i:literal",
        "h:chunk",
        "I:literal",
    ])("round-trips exactly one namespace in %s", (value) => {
        const path = parseDocumentPath(value);
        const parts = splitDocumentPath(path);
        expect(joinDocumentPath(parts)).toBe(value);
        expect([parts.prefix, parts.path]).toEqual(expandFilePathPrefix(path));
    });

    it("rejects invalid rooted paths without rewriting them", () => {
        for (const path of ["../outside", "/absolute", "C:/drive", "a/../outside", "a\\b"]) {
            expect(() => parseFilePath(path)).toThrow();
        }
    });

    it("rejects unsupported normalisation versions", () => {
        expect(() =>
            getStoragePathComparisonKey(parseFilePath("note.md"), {
                pathNormalizationVersion: 2,
                handleFilenameCaseSensitive: true,
            } as never)
        ).toThrow(/unsupported/i);
    });
});
