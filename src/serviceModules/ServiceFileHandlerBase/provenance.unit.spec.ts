import { describe, expect, it } from "vitest";

import { EntryTypes, type FilePathWithPrefix, type LoadedEntry } from "@lib/common/types";

import { createFileHandlerFixture, makeFile, makeMetaEntry } from "../../../_tools/fixtures/file-handler-context";
import { classifyStorageContent, getProvenBaseRevision, getProvenance, readProvenanceSnapshot } from "./provenance";

const filePath = "notes/provenance.md" as FilePathWithPrefix;

/** Build a decoded Metadata revision for database-boundary responses. */
function makeLoadedEntry(path: FilePathWithPrefix, revision: string, data: string): LoadedEntry {
    return {
        ...makeMetaEntry(path, revision),
        data,
        datatype: EntryTypes.NOTE_PLAIN,
    };
}

describe("ServiceFileHandlerBase provenance operations", () => {
    it("reconstructs one exact content match when the optional provenance service is absent", async () => {
        const fixture = createFileHandlerFixture({ includeProvenance: false });
        const file = makeFile(filePath, "displayed bytes\n");
        fixture.db.findContentRevisions.mockResolvedValue(["2-displayed"]);

        await expect(getProvenBaseRevision(fixture.ctx, file)).resolves.toBe("2-displayed");

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("treats a provenance read failure as unknown ancestry", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unclassified bytes\n");
        const error = new Error("provenance store unavailable");
        fixture.provenance.get.mockRejectedValue(error);

        await expect(getProvenBaseRevision(fixture.ctx, file)).resolves.toBeUndefined();

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.log).toHaveBeenCalledWith(
            expect.stringContaining("Could not read file reflection provenance"),
            expect.any(Number)
        );
        expect(fixture.log).toHaveBeenCalledWith(error, expect.any(Number));
        expect(fixture.provenance.set).not.toHaveBeenCalled();
    });

    it("compares bytes against the recorded revision when its hash evidence is unsupported", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "edited bytes\n");
        const current = makeMetaEntry(filePath, "3-winner");
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "older bytes\n"));

        await expect(
            classifyStorageContent(fixture.ctx, file, current, filePath, {
                revision: "2-displayed",
                contentHash: `sha1:${"0".repeat(64)}`,
                contentSize: file.body.size,
            })
        ).resolves.toEqual({ kind: "edited", revision: "2-displayed" });

        expect(fixture.db.fetchEntry).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true, true, true);
        expect(fixture.db.findLiveContentRevisions).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("removes stale legacy provenance but retains supported content evidence", async () => {
        const fixture = createFileHandlerFixture();
        fixture.provenanceRecords.set(filePath, { revision: "1-pruned" });

        await expect(getProvenance(fixture.ctx, filePath)).resolves.toBeUndefined();

        expect(fixture.provenance.delete).toHaveBeenCalledExactlyOnceWith(filePath);

        fixture.provenance.delete.mockClear();
        fixture.provenanceRecords.set(filePath, {
            revision: "1-pruned-with-evidence",
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: 0,
        });

        await expect(getProvenance(fixture.ctx, filePath)).resolves.toBeUndefined();

        expect(fixture.provenance.delete).not.toHaveBeenCalled();
    });

    it("suppresses provenance snapshot errors for ordinary reads and propagates required revalidation errors", async () => {
        const fixture = createFileHandlerFixture();
        const error = new Error("provenance read failed");
        fixture.provenance.get.mockRejectedValue(error);

        await expect(readProvenanceSnapshot(fixture.ctx, filePath)).resolves.toBeUndefined();
        await expect(readProvenanceSnapshot(fixture.ctx, filePath, true)).rejects.toBe(error);
    });

    it("rejects strict classification when the recorded live revision cannot be read", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "edited bytes\n");
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "2-displayed"));

        await expect(
            classifyStorageContent(
                fixture.ctx,
                file,
                makeMetaEntry(filePath, "3-winner"),
                filePath,
                { revision: "2-displayed" },
                undefined,
                true
            )
        ).rejects.toThrow("Could not read the recorded file revision");

        expect(fixture.db.fetchEntry).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true, true, false);
        expect(fixture.db.findLiveContentRevisions).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });
});
