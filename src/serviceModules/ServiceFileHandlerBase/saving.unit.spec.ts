import { describe, expect, it } from "vitest";

import { EntryTypes, type FilePathWithPrefix, type LoadedEntry } from "@lib/common/types";

import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";
import { storeFileToDBFromRevision, storeFileToDBWithBaseRevision } from "./saving";

const filePath = "notes/saving.md" as FilePathWithPrefix;

/** Build a decoded Metadata revision for database-boundary responses. */
function makeLoadedEntry(path: FilePathWithPrefix, revision: string, data: string): LoadedEntry {
    return {
        ...makeMetaEntry(path, revision),
        data,
        datatype: EntryTypes.NOTE_PLAIN,
    };
}

describe("ServiceFileHandlerBase saving operations", () => {
    it("creates a root revision when storage has no current Metadata entry", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new local file\n");
        fixture.files.set(filePath, file);

        await expect(storeFileToDBFromRevision(fixture.ctx, file)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, undefined, true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-stored");
    });

    it("refuses missing and internal observations before any database write", async () => {
        const fixture = createFileHandlerFixture();
        const missingResult = await storeFileToDBFromRevision(fixture.ctx, filePath);
        const internal = { ...makeFileStub(filePath), isInternal: true };
        const internalResult = await storeFileToDBFromRevision(fixture.ctx, internal);
        const missingBaseResult = await storeFileToDBWithBaseRevision(fixture.ctx, filePath, "2-base");
        const internalBaseResult = await storeFileToDBWithBaseRevision(fixture.ctx, internal, "2-base");

        expect(missingResult).toBe(false);
        expect(internalResult).toBe(false);
        expect(missingBaseResult).toBe(false);
        expect(internalBaseResult).toBe(false);
        expect(fixture.storage.getFileStub).toHaveBeenCalledTimes(2);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
    });

    it("refuses an explicit base which is no longer a live leaf", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "local edit\n");
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-obsolete") return makeMetaEntry(filePath, "2-obsolete");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-obsolete")).resolves.toBe(false);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledWith(file, "2-obsolete", true);
        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledWith(file, undefined, true);
        expect(fixture.db.getConflictedRevs).toHaveBeenCalledExactlyOnceWith(file);
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("stores an edit below the selected live conflict revision, not the winner", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "edit on displayed branch\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "previous displayed bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed")).resolves.toBe(true);

        expect(fixture.db.fetchEntry).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true, true);
        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalledWith(file, "3-winner", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("certifies matching bytes without creating a child when edits are disabled", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "same bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "same bytes\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed", false)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-displayed");
    });

    it("refuses differing bytes when the selected-base operation cannot create a child", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "old bytes\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed", false)).resolves.toBe(false);

        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("returns false when the selected live branch refuses a changed body", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new branch content\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "old branch content\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);
        fixture.db.storeWithBaseRevision.mockResolvedValue(false);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed")).resolves.toBe(false);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("recognises unchanged bytes on a uniquely reconstructed displayed conflict branch", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "displayed branch bytes\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "displayed branch bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-deleted-winner", { deleted: true });
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.findContentRevisions.mockResolvedValue(["2-displayed"]);
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file)).resolves.toBe(true);

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.db.fetchEntry).toHaveBeenCalledWith(file, "2-displayed", true, true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-displayed");
        expect(fixture.log).toHaveBeenCalledWith(
            expect.stringContaining("is not changed on its displayed conflict branch"),
            expect.any(Number)
        );
    });

    it("preserves unknown conflicted bytes as a sibling and clears stale rename-source provenance", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unknown branch bytes\n");
        const sourcePath = "notes/source.md" as FilePathWithPrefix;
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(sourcePath, {
            revision: "1-pruned-source",
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: 0,
        });
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "1-pruned-source") return false;
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true, false, sourcePath)).resolves.toBe(true);

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.db.storeAsConflictedRevisionWithResult).toHaveBeenCalledExactlyOnceWith(file, "3-winner", true);
        expect(fixture.provenance.delete).toHaveBeenCalledExactlyOnceWith(sourcePath);
        expect(fixture.provenanceRecords.has(sourcePath)).toBe(false);
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-conflicted");
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("queues conflict review when a sibling-preservation write is refused", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unknown branch bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "3-winner"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);
        fixture.db.storeAsConflictedRevisionWithResult.mockResolvedValue(false);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(false);

        expect(fixture.db.storeAsConflictedRevisionWithResult).toHaveBeenCalledExactlyOnceWith(file, "3-winner", true);
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.provenance.delete).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("saves a forced displayed-branch child even when provenance publication fails", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "current storage bytes\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "current storage bytes\n");
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, { revision: "2-displayed", observedStorageMtime: file.stat.mtime });
        fixture.provenance.set.mockRejectedValue(new Error("provenance store unavailable"));
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.log).toHaveBeenCalledWith(
            expect.stringContaining("Could not record file reflection provenance"),
            expect.any(Number)
        );
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("refuses unknown branch preservation if the current revision disappears before the save", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "untracked conflict bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta
            .mockResolvedValueOnce(makeMetaEntry(filePath, "3-winner"))
            .mockResolvedValueOnce(false);
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(false);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledTimes(2);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(1, file, undefined, true);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(2, file, undefined, true);
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });
});
