import type { FilePathWithPrefix, MetaEntry } from "@lib/common/types";
import { describe, expect, it } from "vitest";

import { renameFileInDB, renameFileInDBCore } from "./renaming";
import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";

const sourcePath = "old.md" as FilePathWithPrefix;
const targetPath = "new.md" as FilePathWithPrefix;

/** Resolve either a path or storage observation to the database lookup path. */
function lookupPath(target: string | { path: string }): string {
    return typeof target === "string" ? target : target.path;
}

describe("database rename handling", () => {
    it("refuses to replace a live destination before saving or deleting anything", async () => {
        const { ctx, db, storage, files } = createFileHandlerFixture();
        const file = makeFile(targetPath, "renamed content");
        files.set(targetPath, file);
        const source = makeMetaEntry(sourcePath, "2-source");
        const destination = makeMetaEntry(targetPath, "3-existing");
        db.fetchEntryMeta.mockImplementation(async (target) =>
            lookupPath(target as string | { path: string }) === sourcePath ? source : destination
        );

        await expect(renameFileInDBCore(ctx, makeFileStub(targetPath), sourcePath)).resolves.toBe(false);

        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
    });

    it("keeps the source database entry when saving the rename destination fails", async () => {
        const { ctx, db, storage, files } = createFileHandlerFixture();
        const file = makeFile(targetPath, "renamed content");
        files.set(targetPath, file);
        const source = makeMetaEntry(sourcePath, "2-source");
        db.fetchEntryMeta.mockImplementation(async (target) =>
            lookupPath(target as string | { path: string }) === sourcePath ? source : false
        );
        db.storeWithBaseRevision.mockResolvedValue(false);

        await expect(renameFileInDBCore(ctx, makeFileStub(targetPath), sourcePath)).resolves.toBe(false);

        expect(db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: targetPath }),
            undefined,
            true
        );
        expect(db.delete).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
    });

    it("stores the destination before deleting a known source", async () => {
        const { ctx, db, storage, files, provenance } = createFileHandlerFixture();
        const file = makeFile(targetPath, "renamed content");
        files.set(targetPath, file);
        const source = makeMetaEntry(sourcePath, "2-source");
        const effects: string[] = [];
        db.fetchEntryMeta.mockImplementation(async (target) =>
            lookupPath(target as string | { path: string }) === sourcePath ? source : false
        );
        db.storeWithBaseRevision.mockImplementation(async () => {
            effects.push("save destination");
            return "3-destination";
        });
        db.delete.mockImplementation(async () => {
            effects.push("delete source");
            return true;
        });

        await expect(renameFileInDB(ctx, makeFileStub(targetPath), sourcePath)).resolves.toBe(true);

        expect(effects).toEqual(["save destination", "delete source"]);
        expect(db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: targetPath }),
            undefined,
            true
        );
        expect(db.delete).toHaveBeenCalledExactlyOnceWith(sourcePath);
        expect(provenance.delete).toHaveBeenCalledWith(sourcePath);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("retains all source conflict branches when the displayed ancestry cannot be identified", async () => {
        const { ctx, db, conflict, files } = createFileHandlerFixture();
        files.set(targetPath, makeFile(targetPath, "renamed content"));
        const source = makeMetaEntry(sourcePath, "2-source");
        db.fetchEntryMeta.mockImplementation(async (target) =>
            lookupPath(target as string | { path: string }) === sourcePath ? source : false
        );
        db.getConflictedRevs.mockImplementation(async (target) =>
            lookupPath(target as string | { path: string }) === sourcePath ? ["3-source-conflict"] : []
        );

        await expect(renameFileInDB(ctx, makeFileStub(targetPath), sourcePath)).resolves.toBe(true);

        expect(db.storeWithBaseRevision).toHaveBeenCalled();
        expect(db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(sourcePath, expect.any(Blob));
        expect(db.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(sourcePath);
    });

    it("stores a case-only rename through the shared document identity", async () => {
        const { ctx, db, path, files } = createFileHandlerFixture();
        const oldSpelling = "Note.md" as FilePathWithPrefix;
        const newSpelling = "note.md" as FilePathWithPrefix;
        const current = makeMetaEntry(newSpelling, "2-current");
        files.set(newSpelling, makeFile(newSpelling, "same document"));
        path.path2id.mockImplementation(async (candidate) => candidate.toLowerCase() as typeof current._id);
        db.fetchEntryMeta.mockResolvedValue(current);

        await expect(renameFileInDB(ctx, makeFileStub(newSpelling), oldSpelling)).resolves.toBe(true);

        expect(db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: newSpelling }),
            current._rev,
            true
        );
        expect(db.delete).not.toHaveBeenCalled();
    });
});
