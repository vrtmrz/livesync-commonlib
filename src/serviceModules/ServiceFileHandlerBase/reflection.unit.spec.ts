import {
    DEFAULT_SETTINGS,
    EntryTypes,
    type FilePathWithPrefix,
    type LoadedEntry,
    type MetaEntry,
    type UXFileInfo,
    type UXFolderInfo,
} from "@lib/common/types";
import { TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { computeFileContentHash } from "@lib/common/fileContentHash";
import { describe, expect, it, vi } from "vitest";

import { applyDatabaseEntryToStorage, dbToStorage, dbToStorageWithSpecificRev } from "./reflection";
import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";

const path = "note.md" as FilePathWithPrefix;

/** Build the decoded revision body consumed by database-to-storage reflection. */
function loaded(entry: MetaEntry, data: string): LoadedEntry {
    return { ...entry, data, datatype: EntryTypes.NOTE_PLAIN };
}

/** Build provenance that identifies the exact bytes currently represented by storage. */
async function makeProvenanceRecord(file: UXFileInfo, revision: string, observedStorageMtime = file.stat.mtime) {
    return {
        revision,
        observedStorageMtime,
        contentHash: await computeFileContentHash(file.body),
        contentSize: file.body.size,
    };
}

/** Build a current storage folder using the complete host shape. */
function makeFolder(folderPath: FilePathWithPrefix): UXFolderInfo {
    return {
        name: folderPath.split("/").at(-1) || folderPath,
        path: folderPath,
        isFolder: true,
        children: [],
        parent: undefined,
    };
}

describe("database-to-storage reflection", () => {
    it("accepts selected conflict content already present in storage without rewriting it", async () => {
        const { ctx, db, storage, path: pathService, provenance, files } = createFileHandlerFixture();
        const file = makeFile(path, "selected bytes", { mtime: 1_200 });
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const entry = makeMetaEntry(path, "2-selected", { size: file.stat.size, mtime: 1_100 });
        const decoded = loaded(entry, "selected bytes");
        db.getConflictedRevs.mockResolvedValue([entry._rev!]);
        db.fetchEntryFromMeta.mockResolvedValue(decoded);

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub, false, true)).resolves.toBe(true);

        expect(storage.readStubContent).toHaveBeenCalledExactlyOnceWith(stub);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(storage.touched).not.toHaveBeenCalled();
        expect(storage.triggerFileEvent).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith(
            path,
            expect.objectContaining({ revision: entry._rev, observedStorageMtime: file.stat.mtime })
        );
        expect(pathService.markChangesAreSame).toHaveBeenCalledExactlyOnceWith(decoded, decoded.mtime, file.stat.mtime);
    });

    it("writes a selected conflict leaf when its bytes differ and the configured policy permits writes", async () => {
        const { ctx, db, storage, setting, path: pathService, provenance, files } = createFileHandlerFixture();
        const file = makeFile(path, "displayed bytes");
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const entry = makeMetaEntry(path, "3-selected", { size: new Blob(["selected bytes"]).size });
        const decoded = loaded(entry, "selected bytes");
        setting.currentSettings.mockReturnValue({ ...DEFAULT_SETTINGS, writeDocumentsIfConflicted: true });
        pathService.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        db.getConflictedRevs.mockResolvedValue([entry._rev!]);
        db.fetchEntryFromMeta.mockResolvedValue(decoded);

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub, false, true)).resolves.toBe(true);

        expect(storage.readStubContent).toHaveBeenCalledExactlyOnceWith(stub);
        expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(path, "selected bytes", {
            ctime: decoded.ctime,
            mtime: decoded.mtime,
        });
        expect(storage.touched).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.triggerFileEvent).toHaveBeenCalledExactlyOnceWith("modify", path);
        expect(provenance.set).toHaveBeenCalledWith(path, expect.objectContaining({ revision: entry._rev }));
    });

    it("rechecks storage after directory preparation and preserves a concurrent edit", async () => {
        const { ctx, db, storage, path: pathService, provenance, files, conflict } = createFileHandlerFixture();
        const file = makeFile(path, "incoming bytes");
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const entry = makeMetaEntry(path, "2-incoming", { size: file.stat.size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        pathService.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        storage.ensureDir.mockImplementation(async () => {
            files.set(path, makeFile(path, "edit made during reflection", { mtime: 2_000 }));
            return true;
        });

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub)).resolves.toBe(true);

        expect(storage.ensureDir).toHaveBeenCalledExactlyOnceWith(path);
        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), true);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("edit made during reflection");
        expect(provenance.set).toHaveBeenCalledWith(path, expect.objectContaining({ revision: "1-independent" }));
        expect(conflict.queueCheckFor).toHaveBeenCalledWith(path);
    });

    it("does not delete storage when preservation of its current bytes is refused", async () => {
        const { ctx, db, storage, provenance, files } = createFileHandlerFixture();
        const file = makeFile(path, "only local copy");
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const deletion = makeMetaEntry(path, "3-deleted", { deleted: true });
        db.storeIndependentRevision.mockResolvedValue(false);

        await expect(applyDatabaseEntryToStorage(ctx, deletion, stub)).resolves.toBe(true);

        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), true);
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(provenance.delete).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("only local copy");
    });

    it("reflects the latest database revision found after the initial content read", async () => {
        const { ctx, db, storage, setting, path: pathService, files } = createFileHandlerFixture();
        const file = makeFile(path, "older bytes");
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const oldEntry = makeMetaEntry(path, "2-old", { size: new Blob(["older bytes"]).size });
        const newEntry = makeMetaEntry(path, "3-current", { size: new Blob(["current bytes"]).size });
        setting.currentSettings.mockReturnValue({ ...DEFAULT_SETTINGS, writeDocumentsIfConflicted: true });
        pathService.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        db.fetchEntryFromMeta.mockImplementation(async (entry) =>
            loaded(entry, entry._rev === oldEntry._rev ? "older bytes" : "current bytes")
        );
        db.fetchEntryMeta.mockResolvedValue(newEntry);

        await expect(applyDatabaseEntryToStorage(ctx, oldEntry, stub)).resolves.toBe(true);

        expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(path, "current bytes", expect.any(Object));
        expect(storage.writeFileAuto).not.toHaveBeenCalledWith(path, "older bytes", expect.any(Object));
    });

    it("leaves a current folder and an already-absent deletion untouched", async () => {
        const folderFixture = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming");
        folderFixture.storage.getStub.mockResolvedValue(makeFolder(path));

        await expect(applyDatabaseEntryToStorage(folderFixture.ctx, entry, null)).resolves.toBe(true);

        expect(folderFixture.db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(folderFixture.storage.writeFileAuto).not.toHaveBeenCalled();
        expect(folderFixture.storage.deleteVaultItem).not.toHaveBeenCalled();

        const deletionFixture = createFileHandlerFixture();
        deletionFixture.provenanceRecords.set(path, { revision: "2-displayed" });
        await expect(
            applyDatabaseEntryToStorage(deletionFixture.ctx, makeMetaEntry(path, "3-deleted", { deleted: true }), null)
        ).resolves.toBe(true);

        expect(deletionFixture.provenance.delete).toHaveBeenCalledExactlyOnceWith(path);
        expect(deletionFixture.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(deletionFixture.db.delete).not.toHaveBeenCalled();
    });

    it.each([
        ["defer while conflicts are unresolved", false, false],
        ["write when configured to reflect through conflicts", true, true],
    ] as const)("can %s", async (_description, writeConflicted, forceWrite) => {
        const { ctx, db, storage, setting, conflict } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming", { size: new Blob(["incoming bytes"]).size });
        db.getConflictedRevs.mockResolvedValue(["3-live-conflict"]);
        setting.currentSettings.mockReturnValue({
            ...DEFAULT_SETTINGS,
            writeDocumentsIfConflicted: writeConflicted,
        });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));

        await expect(applyDatabaseEntryToStorage(ctx, entry, null, forceWrite)).resolves.toBe(true);

        if (writeConflicted) {
            expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(path, "incoming bytes", expect.any(Object));
            expect(conflict.queueCheckForIfOpen).not.toHaveBeenCalled();
        } else {
            expect(storage.getStub).not.toHaveBeenCalled();
            expect(storage.writeFileAuto).not.toHaveBeenCalled();
            expect(conflict.queueCheckForIfOpen).toHaveBeenCalledExactlyOnceWith(path);
        }
    });

    it("refuses non-zero metadata whose decoded content has a different size", async () => {
        const { ctx, db, storage, provenance } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming", { size: 99 });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "short"));

        await expect(applyDatabaseEntryToStorage(ctx, entry, null)).resolves.toBe(false);

        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("retains edited storage when a deletion candidate becomes stale during database validation", async () => {
        const { ctx, db, storage, files, provenance, provenanceRecords } = createFileHandlerFixture();
        const file = makeFile(path, "displayed bytes");
        files.set(path, file);
        const record = await makeProvenanceRecord(file, "2-displayed");
        provenanceRecords.set(path, record);
        const deletion = makeMetaEntry(path, "3-deleted", { deleted: true });
        let currentRevisionReads = 0;
        db.fetchEntryMeta.mockImplementation(async (_target, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(path, "2-displayed");
            if (revision !== undefined) return false;
            currentRevisionReads += 1;
            if (currentRevisionReads === 1) {
                files.set(path, makeFile(path, "edit during deletion", { mtime: file.stat.mtime }));
            }
            return deletion;
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, makeFileStub(path))).resolves.toBe(true);

        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), true);
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(provenance.delete).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("edit during deletion");
    });

    it.each(["stat", "bytes", "provenance"] as const)(
        "refuses deletion when %s changes after the preservation candidate is rechecked",
        async (change) => {
            const { ctx, db, storage, files, provenance, provenanceRecords } = createFileHandlerFixture();
            const file = makeFile(path, "displayed bytes", { mtime: 1_000 });
            files.set(path, file);
            const originalRecord = await makeProvenanceRecord(file, "2-displayed");
            const recheckedRecord = { ...originalRecord, observedStorageMtime: 1_100 };
            provenanceRecords.set(path, originalRecord);
            const deletion = makeMetaEntry(path, "3-deleted", { deleted: true });
            let currentRevisionReads = 0;
            db.fetchEntryMeta.mockImplementation(async (_target, revision) => {
                if (revision !== undefined) return false;
                currentRevisionReads += 1;
                if (currentRevisionReads === 1) provenanceRecords.set(path, recheckedRecord);
                if (currentRevisionReads === 2) {
                    if (change === "stat") {
                        files.set(path, makeFile(path, "displayed bytes", { mtime: 1_200 }));
                    } else if (change === "bytes") {
                        files.set(path, makeFile(path, "late edit", { mtime: file.stat.mtime }));
                    } else {
                        provenanceRecords.set(path, { ...recheckedRecord, revision: "4-other" });
                    }
                }
                return deletion;
            });

            await expect(applyDatabaseEntryToStorage(ctx, deletion, makeFileStub(path))).resolves.toBe(false);

            expect(db.fetchEntryMeta).toHaveBeenCalledTimes(2);
            expect(storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(provenance.delete).not.toHaveBeenCalled();
            if (change === "bytes") expect(await files.get(path)?.body.text()).toBe("late edit");
            else expect(await files.get(path)?.body.text()).toBe("displayed bytes");
        }
    );

    it("does not write after the storage path disappears during the final candidate check", async () => {
        const { ctx, db, storage, files } = createFileHandlerFixture();
        const file = makeFile(path, "incoming bytes");
        files.set(path, file);
        const entry = makeMetaEntry(path, "2-incoming", { size: file.stat.size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        vi.mocked(ctx.path.compareFileFreshness).mockReturnValue(TARGET_IS_NEW);
        storage.ensureDir.mockImplementation(async () => {
            files.delete(path);
            return true;
        });

        await expect(applyDatabaseEntryToStorage(ctx, entry, makeFileStub(path))).resolves.toBe(false);

        expect(storage.ensureDir).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
    });

    it("does not write when storage changes after database revision validation", async () => {
        const { ctx, db, storage, path: pathService, files } = createFileHandlerFixture();
        const file = makeFile(path, "incoming bytes");
        files.set(path, file);
        const stub = makeFileStub(path, { mtime: file.stat.mtime, size: file.stat.size });
        const entry = makeMetaEntry(path, "2-incoming", { size: file.stat.size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        pathService.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        db.fetchEntryMeta.mockImplementation(async () => {
            files.set(path, makeFile(path, "edit after database check", { mtime: file.stat.mtime }));
            return entry;
        });

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub)).resolves.toBe(false);

        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("edit after database check");
    });

    it("returns the storage write failure without publishing provenance", async () => {
        const { ctx, db, storage, provenance } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming", { size: new Blob(["incoming bytes"]).size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        storage.writeFileAuto.mockResolvedValue(false);

        await expect(applyDatabaseEntryToStorage(ctx, entry, null, true)).resolves.toBe(false);

        expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(path, "incoming bytes", {
            ctime: entry.ctime,
            mtime: entry.mtime,
        });
        expect(storage.touched).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.triggerFileEvent).toHaveBeenCalledExactlyOnceWith("create", path);
        expect(storage.stat).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("refuses to write after repeated changes prevent a stable preservation candidate", async () => {
        const { ctx, db, storage, path: pathService, files, provenance } = createFileHandlerFixture();
        files.set(path, makeFile(path, "initial local bytes"));
        const entry = makeMetaEntry(path, "2-incoming", { size: new Blob(["incoming bytes"]).size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        pathService.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        let reads = 0;
        db.findLiveContentRevisions.mockImplementation(async () => {
            reads += 1;
            files.set(path, makeFile(path, `local edit ${reads}`, { mtime: 1_000 + reads }));
            return [];
        });

        await expect(applyDatabaseEntryToStorage(ctx, entry, makeFileStub(path))).resolves.toBe(false);

        expect(db.findLiveContentRevisions).toHaveBeenCalledTimes(2);
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("local edit 2");
    });

    it("rejects a selected revision which is no longer a live leaf", async () => {
        const { ctx, db, storage } = createFileHandlerFixture();
        const selected = makeMetaEntry(path, "2-stale");
        const current = makeMetaEntry(path, "3-current");
        db.fetchEntryMeta.mockImplementation(async (_target, revision) =>
            revision === selected._rev ? selected : current
        );
        db.getConflictedRevs.mockResolvedValue(["4-other-live-leaf"]);

        await expect(dbToStorageWithSpecificRev(ctx, path, selected._rev!)).resolves.toBe(false);

        expect(storage.readStubContent).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(db.fetchEntryFromMeta).not.toHaveBeenCalled();
    });

    it("rejects a revision selection without a path and a current metadata lookup without a document", async () => {
        const { ctx, db, storage } = createFileHandlerFixture();

        await expect(dbToStorageWithSpecificRev(ctx, null, "2-selected")).resolves.toBe(false);
        expect(await dbToStorage(ctx, path, null)).toBe(false);

        expect(db.fetchEntryMeta).toHaveBeenCalledExactlyOnceWith(path, undefined, true);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
    });
});
