import { describe, expect, it } from "vitest";
import { parseFilePath } from "./pathComparison.ts";
import { FilePathIndex } from "./FilePathIndex.ts";

const path = (value: string) => parseFilePath(value);
const policy = (pathNormalizationVersion: 0 | 1, handleFilenameCaseSensitive: boolean) => ({
    pathNormalizationVersion,
    handleFilenameCaseSensitive,
});

describe("FilePathIndex", () => {
    it("retains original spelling and returns every match for all comparison policies", () => {
        const nfc = path("Café.md");
        const nfd = path("Cafe\u0301.md");
        const upper = path("CAFÉ.md");
        const index = new FilePathIndex();
        index.replaceAll([nfc, nfd, upper, path("Note.md"), path("note.md")]);

        expect(index.findPathIdentityCandidates(nfc, policy(0, true))).toEqual([nfc]);
        expect(index.findPathIdentityCandidates(nfd, policy(0, false))).toEqual([nfd]);
        expect(index.findPathIdentityCandidates(nfc, policy(1, true))).toEqual([nfd, nfc].sort());
        expect(index.findPathIdentityCandidates(path("café.md"), policy(1, false))).toEqual([nfc, nfd, upper].sort());
        expect(index.findPathIdentityCandidates(path("NOTE.md"), policy(0, false))).toEqual(["Note.md", "note.md"]);
        expect(index.findPathIdentityCandidates(path("Note.md"), policy(0, true))).toEqual(["Note.md"]);
    });

    it("applies idempotent membership deltas to every materialised policy map", () => {
        const index = new FilePathIndex();
        index.replaceAll([path("A.md"), path("a.md")]);
        for (const version of [0, 1] as const) {
            index.findPathIdentityCandidates(path("a.md"), policy(version, false));
        }

        index.apply({ removed: [path("absent.md"), path("A.md")], added: [path("B.md"), path("B.md")] });

        expect(index.getFileNames().sort()).toEqual(["B.md", "a.md"]);
        expect(index.findPathIdentityCandidates(path("b.md"), policy(0, false))).toEqual(["B.md"]);
        expect(index.findPathIdentityCandidates(path("a.md"), policy(1, false))).toEqual(["a.md"]);
    });

    it("treats a same-path remove/add as a no-op and publishes a rename as one delta", () => {
        const index = new FilePathIndex();
        index.replaceAll([path("old.md"), path("keep.md")]);
        index.apply({ removed: [path("old.md")], added: [path("old.md")] });
        expect(index.getFileNames().sort()).toEqual(["keep.md", "old.md"]);

        index.apply({ removed: [path("new.md")], added: [path("new.md")] });
        expect(index.getFileNames().sort()).toEqual(["keep.md", "new.md", "old.md"]);

        index.apply({ removed: [path("old.md")], added: [path("new.md")] });
        expect(index.getFileNames().sort()).toEqual(["keep.md", "new.md"]);
        expect(index.findPathIdentityCandidates(path("old.md"), policy(0, true))).toEqual([]);
    });

    it("leaves membership unchanged when replacement or a delta fails validation", () => {
        const index = new FilePathIndex();
        index.replaceAll([path("kept.md")]);
        index.findPathIdentityCandidates(path("kept.md"), policy(1, false));

        const invalidPath = 123 as unknown as ReturnType<typeof path>;
        expect(() => index.replaceAll([path("replacement.md"), invalidPath])).toThrow("File paths must be strings");
        expect(() =>
            index.apply({
                removed: [path("kept.md")],
                added: [invalidPath],
            })
        ).toThrow("File paths must be strings");

        expect(index.getFileNames()).toEqual(["kept.md"]);
        expect(index.findPathIdentityCandidates(path("kept.md"), policy(1, false))).toEqual(["kept.md"]);
    });

    it("rebuilds every warmed policy candidate set when replacing the inventory", () => {
        const nfc = path("Café.md");
        const nfd = path("Cafe\u0301.md");
        const upper = path("CAFÉ.md");
        const replacementNfd = path("cafe\u0301.md");
        const index = new FilePathIndex();
        const policies = [policy(0, true), policy(0, false), policy(1, true), policy(1, false)];
        index.replaceAll([nfc, nfd, upper]);

        for (const selectedPolicy of policies) {
            index.findPathIdentityCandidates(nfc, selectedPolicy);
        }

        index.replaceAll([replacementNfd, upper, path("other.md")]);

        expect(index.findPathIdentityCandidates(nfc, policies[0]!)).toEqual([]);
        expect(index.findPathIdentityCandidates(nfc, policies[1]!)).toEqual([upper]);
        expect(index.findPathIdentityCandidates(nfc, policies[2]!)).toEqual([]);
        expect(index.findPathIdentityCandidates(path("café.md"), policies[2]!)).toEqual([replacementNfd]);
        expect(index.findPathIdentityCandidates(nfc, policies[3]!)).toEqual([replacementNfd, upper].sort());
        expect(index.getFileNames().sort()).toEqual([replacementNfd, upper, "other.md"].sort());
    });

    it("removes the last cached candidate and restores it after a later addition", () => {
        const original = path("Note.md");
        const selectedPolicy = policy(1, false);
        const index = new FilePathIndex();
        index.replaceAll([original]);
        expect(index.findPathIdentityCandidates(path("note.md"), selectedPolicy)).toEqual([original]);

        index.apply({ removed: [original], added: [] });
        expect(index.findPathIdentityCandidates(path("note.md"), selectedPolicy)).toEqual([]);

        const replacement = path("NOTE.md");
        index.apply({ removed: [], added: [replacement] });
        expect(index.findPathIdentityCandidates(path("note.md"), selectedPolicy)).toEqual([replacement]);
    });

    it("rejects unsupported policies without changing retained membership", () => {
        const index = new FilePathIndex();
        index.replaceAll([path("kept.md")]);
        const unsupportedPolicy = {
            pathNormalizationVersion: 2,
            handleFilenameCaseSensitive: true,
        } as unknown as Parameters<typeof index.findPathIdentityCandidates>[1];

        expect(() => index.findPathIdentityCandidates(path("kept.md"), unsupportedPolicy)).toThrow(
            "Unsupported path normalisation version: 2"
        );
        const invalidCasePolicy = {
            pathNormalizationVersion: 1,
            handleFilenameCaseSensitive: "true",
        } as unknown as Parameters<typeof index.findPathIdentityCandidates>[1];
        expect(() => index.findPathIdentityCandidates(path("kept.md"), invalidCasePolicy)).toThrow(
            "Filename case handling must be explicit"
        );
        expect(index.getFileNames()).toEqual(["kept.md"]);
        expect(index.findPathIdentityCandidates(path("kept.md"), policy(1, true))).toEqual(["kept.md"]);
    });

    it("keeps instances independent and returns copies", () => {
        const first = new FilePathIndex();
        const second = new FilePathIndex();
        first.replaceAll([path("Note.md")]);

        const fileNames = first.getFileNames();
        fileNames.push(path("Other.md"));
        const candidates = first.findPathIdentityCandidates(path("Note.md"), policy(0, true)) as string[];
        candidates.push("Other.md");

        expect(first.getFileNames()).toEqual(["Note.md"]);
        expect(first.findPathIdentityCandidates(path("Note.md"), policy(0, true))).toEqual(["Note.md"]);
        expect(second.getFileNames()).toEqual([]);
    });
});
