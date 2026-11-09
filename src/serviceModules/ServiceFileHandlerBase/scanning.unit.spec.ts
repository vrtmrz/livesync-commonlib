import { describe, expect, it } from "vitest";

import { EntryTypes, type FilePathWithPrefix, type LoadedEntry } from "@lib/common/types";

import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";
import { canSkipUnchangedFile, tryRecordUntrackedFileRevision } from "./scanning";

const filePath = "notes/scanning.md" as FilePathWithPrefix;

/** Build a decoded Metadata revision for database-boundary responses. */
function makeLoadedEntry(path: FilePathWithPrefix, revision: string, data: string): LoadedEntry {
    return {
        ...makeMetaEntry(path, revision),
        data,
        datatype: EntryTypes.NOTE_PLAIN,
    };
}

describe("ServiceFileHandlerBase scanning decisions", () => {
    it("skips only when supported provenance, current metadata, and storage stat still agree", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unchanged content\n", { mtime: 1_234 });
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        const record = {
            revision: "2-current",
            observedStorageMtime: file.stat.mtime,
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: file.stat.size,
        };
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, record);
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "2-current"));

        await expect(canSkipUnchangedFile(fixture.ctx, info, makeMetaEntry(filePath, "2-current"))).resolves.toBe(true);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledExactlyOnceWith(filePath, undefined, true);
        expect(fixture.db.getConflictedRevs).toHaveBeenCalledExactlyOnceWith(filePath);
        expect(fixture.storage.stat).toHaveBeenCalledExactlyOnceWith(filePath);
        expect(fixture.storage.hasPendingFileEvent).toHaveBeenCalledTimes(2);
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("does not use unsupported evidence or bypass a pending storage event", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unchanged content\n");
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, {
            revision: "2-current",
            observedStorageMtime: file.stat.mtime,
            contentHash: `sha1:${"a".repeat(64)}`,
            contentSize: file.stat.size,
        });
        const expected = makeMetaEntry(filePath, "2-current");

        await expect(canSkipUnchangedFile(fixture.ctx, info, expected)).resolves.toBe(false);
        expect(fixture.db.fetchEntryMeta).not.toHaveBeenCalled();

        fixture.provenance.get.mockClear();
        fixture.provenanceRecords.set(filePath, {
            revision: "2-current",
            observedStorageMtime: file.stat.mtime,
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: file.stat.size,
        });
        fixture.storage.hasPendingFileEvent.mockReturnValue(true);

        await expect(canSkipUnchangedFile(fixture.ctx, info, expected)).resolves.toBe(false);
        expect(fixture.provenance.get).not.toHaveBeenCalled();
        expect(fixture.storage.stat).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("does not certify a stale or conflicted database observation", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unchanged content\n");
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        const record = {
            revision: "2-recorded",
            observedStorageMtime: file.stat.mtime,
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: file.stat.size,
        };
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, record);
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "3-current"));

        await expect(canSkipUnchangedFile(fixture.ctx, info, makeMetaEntry(filePath, "2-recorded"))).resolves.toBe(
            false
        );
        expect(fixture.db.getConflictedRevs).not.toHaveBeenCalled();
        expect(fixture.storage.stat).not.toHaveBeenCalled();

        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "2-recorded"));
        fixture.db.getConflictedRevs.mockResolvedValue(["3-conflict"]);

        await expect(canSkipUnchangedFile(fixture.ctx, info, makeMetaEntry(filePath, "2-recorded"))).resolves.toBe(
            false
        );
        expect(fixture.storage.stat).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("upgrades legacy evidence only after exact current content and storage revalidation", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "current bytes\n", { mtime: 1_234 });
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, {
            revision: "2-current",
            observedStorageMtime: file.stat.mtime,
            contentHash: `sha1:${"a".repeat(64)}`,
        });
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "2-current"));
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-current", "current bytes\n"));

        await expect(tryRecordUntrackedFileRevision(fixture.ctx, info, "2-current")).resolves.toBe(true);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledTimes(2);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(1, filePath, undefined, true);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(2, filePath, undefined, true);
        expect(fixture.db.fetchEntry).toHaveBeenCalledExactlyOnceWith(filePath, "2-current", true, true);
        expect(fixture.provenance.set).toHaveBeenCalledExactlyOnceWith(
            filePath,
            expect.objectContaining({
                revision: "2-current",
                observedStorageMtime: file.stat.mtime,
                contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                contentSize: file.stat.size,
            })
        );
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("does not replace provenance for another branch or already supported evidence", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "current bytes\n");
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        const records = [
            { revision: "1-other" },
            {
                revision: "2-current",
                contentHash: `sha256:${"b".repeat(64)}`,
                contentSize: file.stat.size,
            },
        ];

        for (const record of records) {
            fixture.provenanceRecords.set(filePath, record);
            await expect(tryRecordUntrackedFileRevision(fixture.ctx, info, "2-current")).resolves.toBe(false);
        }

        expect(fixture.storage.getStub).not.toHaveBeenCalled();
        expect(fixture.db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("refuses empty revisions or a host without provenance before database inspection", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "current bytes\n");
        const info = makeFileStub(filePath, { mtime: file.stat.mtime, size: file.stat.size });
        const withoutProvenance = createFileHandlerFixture({ includeProvenance: false });

        await expect(tryRecordUntrackedFileRevision(fixture.ctx, info, "")).resolves.toBe(false);
        await expect(tryRecordUntrackedFileRevision(withoutProvenance.ctx, info, "2-current")).resolves.toBe(false);

        expect(fixture.db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(withoutProvenance.db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
    });
});
