import { ContentReadError } from "@lib/common/LSError.ts";
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

import { applyDatabaseEntryToStorage, reflectDatabaseEntry, dbToStorage, dbToStorageWithSpecificRev } from "./reflection";
import { storeFileToDB } from "./saving";
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

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub, false, true)).resolves.toEqual({ status: "completed" });

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub, false, true)).resolves.toEqual({ status: "completed" });

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub)).resolves.toEqual({ status: "policy" });

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

        await expect(applyDatabaseEntryToStorage(ctx, deletion, stub)).resolves.toEqual({ status: "policy" });

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

        await expect(applyDatabaseEntryToStorage(ctx, oldEntry, stub)).resolves.toEqual({ status: "completed" });

        expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(path, "current bytes", expect.any(Object));
        expect(storage.writeFileAuto).not.toHaveBeenCalledWith(path, "older bytes", expect.any(Object));
    });

    it("leaves a current folder and an already-absent deletion untouched", async () => {
        const folderFixture = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming");
        folderFixture.storage.getStub.mockResolvedValue(makeFolder(path));

        await expect(applyDatabaseEntryToStorage(folderFixture.ctx, entry, null)).resolves.toEqual({ status: "policy" });

        expect(folderFixture.db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(folderFixture.storage.writeFileAuto).not.toHaveBeenCalled();
        expect(folderFixture.storage.deleteVaultItem).not.toHaveBeenCalled();

        const deletionFixture = createFileHandlerFixture();
        deletionFixture.provenanceRecords.set(path, { revision: "2-displayed" });
        await expect(
            applyDatabaseEntryToStorage(deletionFixture.ctx, makeMetaEntry(path, "3-deleted", { deleted: true }), null)
        ).resolves.toEqual({ status: "completed" });

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, null, forceWrite)).resolves.toEqual({ status: writeConflicted ? "completed" : "policy" });

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, null)).rejects.toThrow();

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

        await expect(applyDatabaseEntryToStorage(ctx, deletion, makeFileStub(path))).resolves.toEqual({ status: "policy" });

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

            await expect(applyDatabaseEntryToStorage(ctx, deletion, makeFileStub(path))).rejects.toThrow();

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, makeFileStub(path))).rejects.toThrow();

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, stub)).rejects.toThrow();

        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("edit after database check");
    });

    it("returns the storage write failure without publishing provenance", async () => {
        const { ctx, db, storage, provenance } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "2-incoming", { size: new Blob(["incoming bytes"]).size });
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming bytes"));
        storage.writeFileAuto.mockResolvedValue(false);

        await expect(applyDatabaseEntryToStorage(ctx, entry, null, true)).rejects.toThrow();

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

        await expect(applyDatabaseEntryToStorage(ctx, entry, makeFileStub(path))).rejects.toThrow();

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

describe("reflection content-read outcome", () => {
    it("throws the original read failure without changing its historical revision or storage", async () => {
        const { ctx, db, storage } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "3-incoming");
        const error = new ContentReadError({ documentId: entry._id, revision: "1-history", resources: ["remote"], cause: new Error("request failed") });
        db.fetchEntryMeta.mockResolvedValue(entry);
        db.fetchEntryFromMeta.mockRejectedValue(error);
        await expect(reflectDatabaseEntry(ctx, entry, null, false, { target: { documentId: entry._id, revision: entry._rev! }, source: "received" })).rejects.toBe(error);
        expect(error.failure.revision).toBe("1-history");
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(storage.triggerFileEvent).not.toHaveBeenCalled();
        await expect(dbToStorage(ctx, entry, null)).resolves.toBe(false);
    });

    it("consumes only an explicit owner checkpoint cancellation before reading", async () => {
        const { ctx, db, storage } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "3-incoming");
        await expect(reflectDatabaseEntry(ctx, entry, null, false, { target: { documentId: entry._id, revision: entry._rev! }, source: "received", checkpoint: () => false })).resolves.toEqual({ status: "cancelled" });
        expect(db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });
});

describe("Boolean reflection facade cleanup", () => {
    it("preserves a typed deferred conflict-hook error after unlocking", async () => {
        const { ctx, db, conflict } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "3-current");
        const error = new ContentReadError({ documentId: entry._id, revision: entry._rev, resources: ["local-database"], cause: new Error("conflict inspection failed") });
        db.fetchEntryMeta.mockResolvedValue(entry);
        db.getConflictedRevs.mockResolvedValue(["2-conflict"]);
        conflict.queueCheckForIfOpen.mockRejectedValue(error);
        await expect(dbToStorage(ctx, entry, null)).rejects.toBe(error);
    });
});

describe("selected-revision Boolean compatibility", () => {
    it("returns false for an unreadable selected live revision", async () => {
        const { ctx, db, storage } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "3-selected");
        const error = new ContentReadError({ documentId: entry._id, revision: entry._rev, resources: ["remote"], cause: new Error("request failed") });
        db.fetchEntryMeta.mockResolvedValue(entry);
        db.fetchEntryFromMeta.mockRejectedValue(error);
        await expect(dbToStorageWithSpecificRev(ctx, path, entry._rev!)).resolves.toBe(false);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves a post-unlock hook error after protecting a selected-revision write", async () => {
        const { ctx, db, conflict, files, storage } = createFileHandlerFixture();
        const entry = makeMetaEntry(path, "3-selected", { size: new Blob(["incoming"]).size });
        files.set(path, makeFile(path, "unique local edits"));
        const error = new ContentReadError({ documentId: entry._id, resources: ["local-database"], cause: new Error("review failed") });
        db.fetchEntryMeta.mockResolvedValue(entry);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(entry, "incoming"));
        conflict.queueCheckFor.mockRejectedValue(error);
        await expect(dbToStorageWithSpecificRev(ctx, path, entry._rev!)).rejects.toBe(error);
        expect(db.storeIndependentRevision).toHaveBeenCalledOnce();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });
});

describe("case-only rename provenance preservation (#1378)", () => {
    function createCaseAwareFixture(options: {
        pathNormalizationVersion?: 0 | 1;
        handleFilenameCaseSensitive?: boolean;
        insensitiveStorageLookup?: boolean;
        preserveRenamedPath?: (oldPath: FilePathWithPrefix, targetPath: FilePathWithPrefix) => FilePathWithPrefix;
    } = {}) {
        const version = options.pathNormalizationVersion ?? 0;
        const caseSensitive = options.handleFilenameCaseSensitive ?? false;
        const insensitiveLookup = options.insensitiveStorageLookup ?? !caseSensitive;
        const fixture = createFileHandlerFixture();
        fixture.setting.currentSettings.mockReturnValue({
            ...DEFAULT_SETTINGS,
            handleFilenameCaseSensitive: caseSensitive,
            pathNormalizationVersion: version,
        });
        const normaliseKey = (value: string) => (version === 1 ? value.normalize("NFC") : value);
        const lookupKey = (value: string) => {
            const norm = normaliseKey(value);
            return insensitiveLookup ? norm.toLowerCase() : norm;
        };
        const findStoredFile = (requested: string): UXFileInfo | undefined => {
            const exact = fixture.files.get(requested as FilePathWithPrefix);
            if (exact) return exact;
            const target = lookupKey(requested);
            for (const file of fixture.files.values()) {
                if (lookupKey(file.path) === target) return file;
            }
            return undefined;
        };
        fixture.path.path2id.mockImplementation(async (value) => {
            const norm = normaliseKey(String(value));
            return (caseSensitive ? norm : norm.toLowerCase()) as never;
        });
        fixture.path.compareFileFreshness.mockReturnValue(TARGET_IS_NEW);
        fixture.storage.getStub.mockImplementation(async (requested) => {
            const found = findStoredFile(String(requested));
            return found ? { name: found.name, path: found.path, stat: found.stat } : null;
        });
        fixture.storage.getFileStub.mockImplementation(async (requested) => {
            const found = findStoredFile(String(requested));
            return found ? { name: found.name, path: found.path, stat: found.stat } : null;
        });
        fixture.storage.stat.mockImplementation(async (requested) => findStoredFile(String(requested))?.stat ?? null);
        fixture.storage.readStubContent.mockImplementation(async (stub) => findStoredFile(stub.path) ?? false);
        fixture.storage.renameFile.mockImplementation(async (file, targetPath) => {
            const oldPath = (typeof file === "string" ? file : file.path) as FilePathWithPrefix;
            const existing = findStoredFile(oldPath);
            if (!existing) return null;
            const finalPath = options.preserveRenamedPath ? options.preserveRenamedPath(existing.path, targetPath) : targetPath;
            const bodyText = await existing.body.text();
            const moved = makeFile(finalPath, bodyText, { ctime: existing.stat.ctime, mtime: existing.stat.mtime });
            fixture.files.delete(existing.path);
            fixture.files.set(finalPath, moved);
            return { name: moved.name, path: moved.path, stat: moved.stat };
        });
        fixture.storage.writeFileAuto.mockImplementation(async (targetPath, data, opt) => {
            const existing = findStoredFile(targetPath);
            const finalPath = (existing?.path ?? targetPath) as FilePathWithPrefix;
            const body = Array.isArray(data) ? data.join("") : data;
            const written = makeFile(finalPath, body, { ctime: opt?.ctime, mtime: opt?.mtime });
            fixture.files.set(finalPath, written);
            return true;
        });
        fixture.storage.deleteVaultItem.mockImplementation(async (item) => {
            const target = typeof item === "string" ? item : item.path;
            const existing = findStoredFile(target);
            if (existing) fixture.files.delete(existing.path);
        });
        return fixture;
    }

    it.each([0, 1] as const)(
        "applies a case-only rename with changed content and observed filename (v=%s)",
        async (pathNormalizationVersion) => {
            const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
            const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
            const oldBody = '---\ntitle: "[[example note]]"\n---\nold body\n';
            const newBody = '---\ntitle: "[[Example note]]"\n---\nnew body\n';
            const { ctx, db, storage, provenanceRecords, files, conflict } = createCaseAwareFixture({
                pathNormalizationVersion,
            });
            const localFile = makeFile(oldPath, oldBody, { mtime: 1_000 });
            files.set(oldPath, localFile);
            provenanceRecords.set(oldPath, { revision: "1-base", observedStorageMtime: localFile.stat.mtime });
            Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
            const incoming = makeMetaEntry(newPath, "2-renamed", { mtime: 2_000, size: new Blob([newBody]).size });
            db.fetchEntryMeta.mockImplementation(async (_target, rev) => {
                if (rev === "1-base") return makeMetaEntry(oldPath, "1-base");
                return incoming;
            });
            db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, newBody));
            db.fetchEntry.mockImplementation(async (_target, rev) => {
                if (rev === "1-base") return loaded(makeMetaEntry(oldPath, "1-base"), oldBody);
                return false;
            });

            await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "completed" });

            expect(storage.renameFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: oldPath }), newPath);
            expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(newPath, newBody, {
                ctime: incoming.ctime,
                mtime: incoming.mtime,
            });
            expect(db.storeIndependentRevision).not.toHaveBeenCalled();
            expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
            expect(conflict.queueCheckFor).not.toHaveBeenCalled();
            expect([...files.keys()]).toEqual([newPath]);
            expect(await files.get(newPath)?.body.text()).toBe(newBody);
            expect(provenanceRecords.has(oldPath)).toBe(false);
            expect(provenanceRecords.get(newPath)?.revision).toBe("2-renamed");
        }
    );

    it("preserves a real local edit as a child of the displayed revision across a case-only rename", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const baseBody = "original body\n";
        const editedBody = "locally edited body\n";
        const incomingBody = "remote renamed body\n";
        const { ctx, db, storage, provenanceRecords, files, conflict } = createCaseAwareFixture();
        const baseFile = makeFile(oldPath, baseBody, { mtime: 1_000 });
        const editedFile = makeFile(oldPath, editedBody, { mtime: 1_500 });
        files.set(oldPath, editedFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(baseFile, "1-base"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
        const incoming = makeMetaEntry(newPath, "2-renamed", { mtime: 2_000, size: new Blob([incomingBody]).size });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, incomingBody));
        db.fetchEntry.mockImplementation(async (_target, rev) =>
            rev === "1-base" ? loaded(makeMetaEntry(oldPath, "1-base"), baseBody) : false
        );
        db.storeWithBaseRevision.mockResolvedValue("2-local-edit");

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "policy" });

        expect(db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: newPath }),
            "1-base",
            true
        );
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledWith(newPath);
        expect(await files.get(newPath)?.body.text()).toBe(editedBody);
        expect(provenanceRecords.has(oldPath)).toBe(false);
        expect(provenanceRecords.get(newPath)?.revision).toBe("2-local-edit");
    });

    it.each(["read-error", "size-mismatch", "cancelled"] as const)(
        "remains retry-safe when %s occurs after the physical case-only rename",
        async (failureKind) => {
            const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
            const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
            const oldBody = "old body\n";
            const newBody = "new body\n";
            const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
            const localFile = makeFile(oldPath, oldBody, { mtime: 1_000 });
            files.set(oldPath, localFile);
            provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
            Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
            const incoming = makeMetaEntry(newPath, "2-renamed", {
                mtime: 2_000,
                size: failureKind === "size-mismatch" ? 999 : new Blob([newBody]).size,
            });
            db.fetchEntryMeta.mockResolvedValue(incoming);
            if (failureKind === "read-error") {
                db.fetchEntryFromMeta
                    .mockRejectedValueOnce(
                        new ContentReadError({
                            documentId: incoming._id,
                            revision: incoming._rev,
                            resources: ["remote"],
                            cause: new Error("chunk missing"),
                        })
                    )
                    .mockResolvedValue(loaded(incoming, newBody));
            } else {
                db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, newBody));
            }

            if (failureKind === "cancelled") {
                await expect(
                    applyDatabaseEntryToStorage(ctx, incoming, null, false, false, 0, {
                        target: { documentId: incoming._id, revision: incoming._rev! },
                        source: "received",
                        checkpoint: () => false,
                    })
                ).resolves.toEqual({ status: "cancelled" });
            } else {
                await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).rejects.toThrow();
            }

            expect(provenanceRecords.has(oldPath)).toBe(false);
            expect(provenanceRecords.get(newPath)?.revision).toBe("1-base");
            expect(db.storeIndependentRevision).not.toHaveBeenCalled();

            const fixedIncoming = makeMetaEntry(newPath, "2-renamed", {
                mtime: 2_000,
                size: new Blob([newBody]).size,
            });
            db.fetchEntryMeta.mockResolvedValue(fixedIncoming);
            db.fetchEntryFromMeta.mockResolvedValue(loaded(fixedIncoming, newBody));

            await expect(applyDatabaseEntryToStorage(ctx, fixedIncoming, null)).resolves.toEqual({
                status: "completed",
            });
            expect(db.storeIndependentRevision).not.toHaveBeenCalled();
            expect(storage.writeFileAuto).toHaveBeenCalledExactlyOnceWith(newPath, newBody, {
                ctime: fixedIncoming.ctime,
                mtime: fixedIncoming.mtime,
            });
            expect(await files.get(newPath)?.body.text()).toBe(newBody);
            expect(provenanceRecords.get(newPath)?.revision).toBe("2-renamed");
        }
    );

    it("aborts before renaming when reading old provenance fails", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "old body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        provenance.get.mockRejectedValueOnce(new Error("kv unavailable"));
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: 9 });

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).rejects.toThrow();

        expect(storage.renameFile).not.toHaveBeenCalled();
        expect(db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });

    it("preserves old provenance and avoids false conflict if writing destination provenance fails", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "old body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
        provenance.set.mockRejectedValueOnce(new Error("kv write failed"));
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: 9 });

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).rejects.toThrow();

        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it.each(["same body", "different body"])("preserves an unobserved filename before incoming reflection with %s", async (incomingBody) => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const localBody = "same body";
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, localBody);
        files.set(oldPath, localFile);
        provenanceRecords.set(newPath, await makeProvenanceRecord(localFile, "9-stale"));
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: new Blob([incomingBody]).size });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, incomingBody));

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "policy" });

        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(localFile, true);
        expect(storage.renameFile).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(oldPath)?.body.text()).toBe(localBody);
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-independent");
        expect(provenanceRecords.get(newPath)?.revision).toBe("9-stale");
    });

    it("protects the scanner's fresh observation on a host with exact path lookup", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, files } = createCaseAwareFixture({ insensitiveStorageLookup: false });
        const file = makeFile(oldPath, "local body");
        const incoming = makeMetaEntry(newPath, "2-other-name");
        files.set(oldPath, file);
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, "remote body"));

        await expect(reflectDatabaseEntry(ctx, incoming, file)).resolves.toEqual({ status: "policy" });
        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(file, true);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect([...files.keys()]).toEqual([oldPath]);
    });

    it.each(["other filename", "pruned revision"])("does not rename from hash evidence for %s", async (previous) => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const file = makeFile(oldPath, "same bytes");
        const incoming = makeMetaEntry(newPath, "2-other-name", { size: file.stat.size });
        files.set(oldPath, file);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(file, "1-recorded"));
        Object.assign(db, {
            readRevisionPath: vi.fn().mockResolvedValue(previous === "other filename" ? newPath : undefined),
        });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, "same bytes"));

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "policy" });
        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(file, true);
        expect(storage.renameFile).not.toHaveBeenCalled();
        expect([...files.keys()]).toEqual([oldPath]);
    });

    it("keeps different original spellings out of equal-byte watcher matches", async () => {
        const localPath = "Tasks/example note.md" as FilePathWithPrefix;
        const databasePath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, provenanceRecords, files } = createCaseAwareFixture();
        const file = makeFile(localPath, "same bytes");
        const projected = makeMetaEntry(localPath, "2-other-name", { size: file.stat.size });
        files.set(localPath, file);
        db.fetchEntryMeta.mockResolvedValue(projected);
        db.fetchEntry.mockResolvedValue(loaded(projected, "same bytes"));
        db.findLiveContentRevisions.mockResolvedValue([]);
        const readRevisionPath = vi.fn().mockResolvedValue(databasePath);
        Object.assign(db, { readRevisionPath });

        // A previous content-only scan could already have certified the other name.
        provenanceRecords.set(localPath, await makeProvenanceRecord(file, "2-other-name"));
        await expect(storeFileToDB(ctx, file)).resolves.toBe(true);
        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(file, true);
        expect(provenanceRecords.get(localPath)?.revision).toBe("1-independent");

        db.getConflictedRevs.mockResolvedValue(["1-independent"]);
        db.findLiveContentRevisions.mockResolvedValue(["1-independent"]);
        readRevisionPath.mockImplementation(async (_id, revision) => revision === "2-other-name" ? databasePath : localPath);
        provenanceRecords.delete(localPath);
        await expect(storeFileToDB(ctx, file)).resolves.toBe(true);
        expect(db.storeIndependentRevision).toHaveBeenCalledTimes(1);
        expect(db.findLiveContentRevisions).toHaveBeenLastCalledWith(file, file.body, {
            path: localPath,
            normalizationVersion: 0,
        });
        expect(provenanceRecords.get(localPath)?.revision).toBe("1-independent");
    });

    it("preserves a newer out-of-lock destination provenance written while renameFile is awaiting", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "old body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
        const originalRename = storage.renameFile.getMockImplementation()!;
        storage.renameFile.mockImplementationOnce(async (file, targetPath) => {
            const renamed = await originalRename(file, targetPath);
            provenanceRecords.set(newPath, { revision: "4-concurrent-host", observedStorageMtime: 9_999 });
            return renamed;
        });
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: 9 });

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).rejects.toThrow();

        expect(provenanceRecords.get(newPath)?.revision).toBe("4-concurrent-host");
        expect(db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("refuses to proceed when renameFile returns a path with a different provenance key", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const weirdPath = "Tasks/EXAMPLE NOTE.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture({
            preserveRenamedPath: () => weirdPath,
        });
        const localFile = makeFile(oldPath, "old body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: 9 });

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).rejects.toThrow();

        expect(db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("handles simultaneous NFD parent and filename case change in NFC mode without conflict", async () => {
        const nfdParent = "Cafe\u0301";
        const nfcParent = "Caf\u00e9";
        const oldPhysical = `${nfdParent}/Note.md` as FilePathWithPrefix;
        const oldCanonical = `${nfcParent}/Note.md` as FilePathWithPrefix;
        const newCanonical = `${nfcParent}/note.md` as FilePathWithPrefix;
        const newPhysical = `${nfdParent}/note.md` as FilePathWithPrefix;
        const oldBody = "old unicode body\n";
        const newBody = "new unicode body\n";
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture({
            pathNormalizationVersion: 1,
            preserveRenamedPath: () => newPhysical,
        });
        const localFile = makeFile(oldPhysical, oldBody);
        files.set(oldPhysical, localFile);
        provenanceRecords.set(oldCanonical, await makeProvenanceRecord(localFile, "1-base"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldCanonical) });
        const incoming = makeMetaEntry(newCanonical, "2-renamed", {
            mtime: 2_000,
            size: new Blob([newBody]).size,
        });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, newBody));

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "completed" });

        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).toHaveBeenCalledWith(newCanonical, newBody, {
            ctime: incoming.ctime,
            mtime: incoming.mtime,
        });
        expect(provenanceRecords.has(oldCanonical)).toBe(false);
        expect(provenanceRecords.get(newCanonical)?.revision).toBe("2-renamed");
    });

    it("applies incoming deletion to an unchanged differently-cased file and clears old-case provenance", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "unchanged body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        db.fetchEntryMeta.mockResolvedValue(deletion);

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).resolves.toEqual({ status: "completed" });

        expect(storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(incomingPath);
        expect(files.size).toBe(0);
        expect(provenanceRecords.size).toBe(0);
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("preserves a locally edited differently-cased file as a child of its displayed revision on incoming deletion", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files, conflict } = createCaseAwareFixture();
        const baseFile = makeFile(oldPath, "base body\n");
        const editedFile = makeFile(oldPath, "local edit\n", { mtime: 1_500 });
        files.set(oldPath, editedFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(baseFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        db.fetchEntryMeta.mockResolvedValue(deletion);
        db.fetchEntry.mockResolvedValue(loaded(makeMetaEntry(oldPath, "1-base"), "base body\n"));
        db.storeWithBaseRevision.mockResolvedValue("2-preserved-edit");

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).resolves.toEqual({ status: "policy" });

        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: oldPath }),
            "1-base",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith(incomingPath);
        expect(provenanceRecords.get(oldPath)?.revision).toBe("2-preserved-edit");
    });

    it.each([
        { label: "ordinary", force: false, writeDocumentsIfConflicted: false },
        { label: "forced", force: true, writeDocumentsIfConflicted: false },
        { label: "writeDocumentsIfConflicted", force: false, writeDocumentsIfConflicted: true },
    ])(
        "refuses $label incoming deletion when insensitive storage resolves a distinct document ID",
        async ({ force, writeDocumentsIfConflicted }) => {
            const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
            const incomingPath = "Tasks/Example note.md" as FilePathWithPrefix;
            const { ctx, setting, storage, provenanceRecords, files } = createCaseAwareFixture({
                handleFilenameCaseSensitive: true,
                insensitiveStorageLookup: true,
            });
            setting.currentSettings.mockReturnValue({
                ...DEFAULT_SETTINGS,
                handleFilenameCaseSensitive: true,
                writeDocumentsIfConflicted,
            });
            const localFile = makeFile(oldPath, "distinct document\n");
            files.set(oldPath, localFile);
            provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-distinct"));
            const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });

            await expect(applyDatabaseEntryToStorage(ctx, deletion, null, force)).rejects.toThrow();

            expect(storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(files.has(oldPath)).toBe(true);
            expect(provenanceRecords.get(oldPath)?.revision).toBe("1-distinct");
        }
    );

    it("clears both old-case and incoming provenance keys after a forced same-ID deletion", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "stale body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-old"));
        provenanceRecords.set(incomingPath, await makeProvenanceRecord(localFile, "1-incoming"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null, true)).resolves.toEqual({ status: "completed" });

        expect(storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(incomingPath);
        expect(provenanceRecords.size).toBe(0);
    });

    it("refuses incoming deletion when the incoming lookup resolves to a newly created folder instead of the validated file", async () => {
        const oldPath = "Tasks/note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "unchanged body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let substituted = false;
        db.fetchEntryMeta.mockImplementation(async () => {
            substituted = true;
            return deletion;
        });
        const originalGetStub = storage.getStub.getMockImplementation()!;
        storage.getStub.mockImplementation(async (requested) => {
            if (substituted && requested === incomingPath) {
                return makeFolder(incomingPath);
            }
            return await originalGetStub(requested);
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).rejects.toThrow(
            "Reflection could not establish a safe current result"
        );

        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(files.has(oldPath)).toBe(true);
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });

    it("aborts before renaming when forced rename cannot clear stale destination provenance", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const localBody = "unknown local content\n";
        const incomingBody = "remote body\n";
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, localBody);
        files.set(oldPath, localFile);
        provenanceRecords.set(newPath, await makeProvenanceRecord(localFile, "9-stale"));
        provenance.delete.mockRejectedValueOnce(new Error("kv delete failed"));
        const incoming = makeMetaEntry(newPath, "2-renamed", { size: new Blob([incomingBody]).size });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, incomingBody));

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null, true)).rejects.toThrow(
            "Reflection could not establish a safe current result"
        );

        expect(storage.renameFile).not.toHaveBeenCalled();
        expect(files.has(oldPath)).toBe(true);
        expect(await files.get(oldPath)?.body.text()).toBe(localBody);

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null, true)).resolves.toEqual({ status: "completed" });

        expect(provenance.delete).toHaveBeenLastCalledWith(newPath);
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(await files.get(newPath)?.body.text()).toBe(incomingBody);
        expect(provenanceRecords.get(newPath)?.revision).toBe("2-renamed");
    });

    it("does not create a duplicate revision when both local and renamed incoming notes are empty", async () => {
        const oldPath = "Tasks/empty note.md" as FilePathWithPrefix;
        const newPath = "Tasks/Empty note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files, conflict } = createCaseAwareFixture();
        const oldNonEmpty = makeFile(oldPath, "previous non-empty body\n");
        const localEmpty = makeFile(oldPath, "", { mtime: 1_500 });
        files.set(oldPath, localEmpty);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(oldNonEmpty, "1-nonempty"));
        Object.assign(db, { readRevisionPath: vi.fn().mockResolvedValue(oldPath) });
        const incoming = makeMetaEntry(newPath, "2-empty-renamed", { mtime: 2_000, size: 0 });
        db.fetchEntryMeta.mockResolvedValue(incoming);
        db.fetchEntryFromMeta.mockResolvedValue(loaded(incoming, ""));
        db.fetchEntry.mockResolvedValue(loaded(makeMetaEntry(oldPath, "1-nonempty"), "previous non-empty body\n"));

        await expect(applyDatabaseEntryToStorage(ctx, incoming, null)).resolves.toEqual({ status: "completed" });

        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).not.toHaveBeenCalled();
        expect(await files.get(newPath)?.body.text()).toBe("");
        expect(provenanceRecords.has(oldPath)).toBe(false);
        expect(provenanceRecords.get(newPath)?.revision).toBe("2-empty-renamed");
    });

    it("clears initial, rechecked, and incoming provenance keys when recheck validates a third same-ID spelling on deletion", async () => {
        const initialPath = "Tasks/note.md" as FilePathWithPrefix;
        const recheckedPath = "Tasks/nOTE.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const initialFile = makeFile(initialPath, "unchanged body\n", { mtime: 1_000 });
        const recheckedFile = makeFile(recheckedPath, "unchanged body\n", { mtime: 1_000 });
        files.set(initialPath, initialFile);
        provenanceRecords.set(initialPath, await makeProvenanceRecord(initialFile, "1-base"));
        provenanceRecords.set(recheckedPath, await makeProvenanceRecord(recheckedFile, "1-base"));
        provenanceRecords.set(incomingPath, await makeProvenanceRecord(initialFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let movedOnce = false;
        db.fetchEntryMeta.mockImplementation(async () => {
            if (!movedOnce) {
                movedOnce = true;
                files.delete(initialPath);
                files.set(recheckedPath, recheckedFile);
            }
            return deletion;
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).resolves.toEqual({ status: "completed" });

        expect(storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(incomingPath);
        expect(files.size).toBe(0);
        expect(provenanceRecords.size).toBe(0);
    });

    it("records matching-leaf provenance under the observed spelling and queues conflict review under incoming path on deletion", async () => {
        const oldPath = "Tasks/example note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Example note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files, conflict } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "matching live leaf body\n");
        files.set(oldPath, localFile);
        const deletion = makeMetaEntry(incomingPath, "3-deleted", { deleted: true });
        db.fetchEntryMeta.mockResolvedValue(deletion);
        db.findLiveContentRevisions.mockResolvedValue(["2-live-leaf"]);

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).resolves.toEqual({ status: "policy" });

        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(provenanceRecords.get(oldPath)?.revision).toBe("2-live-leaf");
        expect(provenanceRecords.has(incomingPath)).toBe(false);
        expect(conflict.queueCheckFor).toHaveBeenCalledWith(incomingPath);
    });

    it("clears NFC/NFD shared provenance exactly once on incoming deletion", async () => {
        const nfcPath = "Caf\u00e9.md" as FilePathWithPrefix;
        const nfdPath = nfcPath.normalize("NFD") as FilePathWithPrefix;
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture({
            pathNormalizationVersion: 1,
            handleFilenameCaseSensitive: true,
        });
        const localFile = makeFile(nfdPath, "unchanged unicode body\n");
        files.set(nfdPath, localFile);
        provenanceRecords.set(nfcPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(nfcPath, "2-deleted", { deleted: true });
        db.fetchEntryMeta.mockResolvedValue(deletion);

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).resolves.toEqual({ status: "completed" });

        expect(storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(nfcPath);
        expect(provenance.delete).toHaveBeenCalledExactlyOnceWith(nfcPath);
        expect(files.size).toBe(0);
        expect(provenanceRecords.size).toBe(0);
    });

    it("honours cancellation occurring while the pre-delete incoming target lookup is awaiting", async () => {
        const oldPath = "Tasks/note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "unchanged body\n");
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let dbChecked = false;
        let active = true;
        db.fetchEntryMeta.mockImplementation(async () => {
            dbChecked = true;
            return deletion;
        });
        const originalGetStub = storage.getStub.getMockImplementation()!;
        storage.getStub.mockImplementation(async (requested) => {
            const result = await originalGetStub(requested);
            if (dbChecked && requested === incomingPath) {
                active = false;
            }
            return result;
        });

        await expect(
            applyDatabaseEntryToStorage(ctx, deletion, null, false, false, 0, {
                target: { documentId: deletion._id, revision: deletion._rev! },
                source: "received",
                checkpoint: () => active,
            })
        ).resolves.toEqual({ status: "cancelled" });

        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(files.has(oldPath)).toBe(true);
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });

    it("refuses deletion when local bytes change while the pre-delete incoming target lookup is awaiting", async () => {
        const oldPath = "Tasks/note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "unchanged body\n", { mtime: 1_000 });
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let dbChecked = false;
        db.fetchEntryMeta.mockImplementation(async () => {
            dbChecked = true;
            return deletion;
        });
        const originalGetStub = storage.getStub.getMockImplementation()!;
        storage.getStub.mockImplementation(async (requested) => {
            if (dbChecked && requested === incomingPath) {
                files.set(oldPath, makeFile(oldPath, "local edit during target lookup\n", { mtime: 2_500 }));
            }
            return await originalGetStub(requested);
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).rejects.toThrow(
            "Reflection could not establish a safe current result"
        );

        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(await files.get(oldPath)?.body.text()).toBe("local edit during target lookup\n");
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });

    it("refuses deletion when same-mtime bytes change during the final pre-delete provenance read", async () => {
        const oldPath = "Tasks/note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "aaaa\n", { mtime: 1_000 });
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let dbChecked = false;
        let postValidationReads = 0;
        db.fetchEntryMeta.mockImplementation(async () => {
            dbChecked = true;
            return deletion;
        });
        const originalGet = provenance.get.getMockImplementation()!;
        provenance.get.mockImplementation(async (key) => {
            const result = await originalGet(key);
            if (dbChecked && key === oldPath) {
                postValidationReads += 1;
                // 1st post-validation read is currentStorageSnapshotMatches; 2nd is the final pre-delete provenance read.
                if (postValidationReads === 2) {
                    files.set(oldPath, makeFile(oldPath, "bbbb\n", { mtime: 1_000 }));
                }
            }
            return result;
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).rejects.toThrow(
            "Reflection could not establish a safe current result"
        );

        expect(postValidationReads).toBe(2);
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(await files.get(oldPath)?.body.text()).toBe("bbbb\n");
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });

    it("refuses deletion when an exact-spelling file appears during the final pre-delete provenance read", async () => {
        const oldPath = "Tasks/note.md" as FilePathWithPrefix;
        const incomingPath = "Tasks/Note.md" as FilePathWithPrefix;
        const { ctx, db, storage, provenance, provenanceRecords, files } = createCaseAwareFixture();
        const localFile = makeFile(oldPath, "unchanged body\n", { mtime: 1_000 });
        files.set(oldPath, localFile);
        provenanceRecords.set(oldPath, await makeProvenanceRecord(localFile, "1-base"));
        const deletion = makeMetaEntry(incomingPath, "2-deleted", { deleted: true });
        let dbChecked = false;
        let postValidationReads = 0;
        db.fetchEntryMeta.mockImplementation(async () => {
            dbChecked = true;
            return deletion;
        });
        const originalGet = provenance.get.getMockImplementation()!;
        provenance.get.mockImplementation(async (key) => {
            const result = await originalGet(key);
            if (dbChecked && key === oldPath) {
                postValidationReads += 1;
                // 1st post-validation read is currentStorageSnapshotMatches; 2nd is the final pre-delete provenance read.
                if (postValidationReads === 2) {
                    files.set(incomingPath, makeFile(incomingPath, "newly created exact-case file\n", { mtime: 2_000 }));
                }
            }
            return result;
        });

        await expect(applyDatabaseEntryToStorage(ctx, deletion, null)).rejects.toThrow(
            "Reflection could not establish a safe current result"
        );

        expect(postValidationReads).toBe(2);
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(await files.get(oldPath)?.body.text()).toBe("unchanged body\n");
        expect(await files.get(incomingPath)?.body.text()).toBe("newly created exact-case file\n");
        expect(provenanceRecords.get(oldPath)?.revision).toBe("1-base");
    });
});
