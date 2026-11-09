import { describe, expect, it } from "vitest";
import { EntryTypes, type LoadedEntry, type FilePath } from "@lib/common/types";
import { createFileHandlerFixture, makeFile, makeMetaEntry } from "../../../_tools/fixtures/file-handler-context";
import {
    deleteFileFromDB,
    deleteFileFromDBIfPresent,
    deleteRevisionFromDB,
    resolveConflictedByDeletingRevision,
} from "./deletion";

const path = "note.md" as FilePath;

/** Return the decoded database entry promised by fetchEntry, including its content datatype. */
function loaded(revision: string, options: { deleted?: boolean; _deleted?: boolean } = {}): LoadedEntry {
    return { ...makeMetaEntry(path, revision, options), data: "database bytes", datatype: EntryTypes.NOTE_PLAIN };
}

/** Seed readable storage and a real provenance record while mocking only the database service. */
function fixture(present: boolean) {
    const f = createFileHandlerFixture();
    const file = makeFile(path, "displayed bytes");
    if (present) f.files.set(path, file);
    f.provenanceRecords.set(path, { revision: "1-displayed" });
    f.db.fetchEntry.mockResolvedValue(loaded("2-current"));
    f.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(path, "1-displayed"));
    return { ...f, file, info: present ? file : path };
}

describe("exported deletion decisions", () => {
    it.each([
        { present: false, state: "absent" },
        { present: true, state: "absent" },
        { present: false, state: "deleted" },
        { present: true, state: "deleted" },
        { present: false, state: "tombstone" },
        { present: true, state: "tombstone" },
    ])("refuses an ordinary deletion with storage=$present and database=$state", async ({ present, state }) => {
        const f = fixture(present);
        f.db.fetchEntry.mockResolvedValue(
            state === "absent" ? false : loaded("1-old", state === "deleted" ? { deleted: true } : { _deleted: true })
        );
        await expect(deleteFileFromDB(f.ctx, f.info)).resolves.toBe(false);
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.db.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
        expect(f.provenance.delete).not.toHaveBeenCalled();
        expect(f.provenanceRecords.get(path)).toEqual({ revision: "1-displayed" });
    });

    it.each([
        { present: false, deleted: false },
        { present: true, deleted: false },
        { present: false, deleted: true },
        { present: true, deleted: true },
    ])(
        "clears provenance only after an accepted unconflicted delete: $present/$deleted",
        async ({ present, deleted }) => {
            const f = fixture(present);
            f.db.delete.mockResolvedValue(deleted);
            await expect(deleteFileFromDB(f.ctx, f.info)).resolves.toBe(deleted);
            expect(f.db.delete).toHaveBeenCalledExactlyOnceWith(f.info);
            expect(f.db.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
            expect(f.provenance.delete).toHaveBeenCalledTimes(deleted ? 1 : 0);
            expect(f.provenanceRecords.has(path)).toBe(!deleted);
        }
    );

    it.each([false, true])("preserves unknown conflict ancestry when storage exists: %s", async (present) => {
        const f = fixture(present);
        f.provenanceRecords.clear();
        f.db.getConflictedRevs.mockResolvedValue(["1-displayed", "2-other"]);
        await expect(deleteFileFromDB(f.ctx, f.info)).resolves.toBe(true);
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.db.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
        expect(f.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(path);
        expect(f.provenance.delete).not.toHaveBeenCalled();
        if (present) {
            expect(f.db.findContentRevisions).toHaveBeenCalledWith(f.file, f.file.body);
            expect(await f.files.get(path)?.body.text()).toBe("displayed bytes");
        }
    });

    it.each([
        { present: false, accepted: false },
        { present: true, accepted: false },
        { present: false, accepted: true },
        { present: true, accepted: true },
    ])("targets only the proven displayed branch: $present/$accepted", async ({ present, accepted }) => {
        const f = fixture(present);
        f.db.getConflictedRevs.mockResolvedValue(["1-displayed", "2-other"]);
        f.db.storeDeletionWithBaseRevision.mockResolvedValue(accepted ? "2-deleted" : false);
        await expect(deleteFileFromDB(f.ctx, f.info)).resolves.toBe(accepted);
        expect(f.db.storeDeletionWithBaseRevision).toHaveBeenCalledExactlyOnceWith(path, "1-displayed");
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.provenance.delete).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(f.conflict.queueCheckFor).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(f.provenanceRecords.has(path)).toBe(!accepted);
    });

    it("refuses a reconstructed branch deletion without clearing its unacknowledged provenance", async () => {
        const f = fixture(true);
        f.provenanceRecords.clear();
        f.db.getConflictedRevs.mockResolvedValue(["1-displayed", "2-other"]);
        f.db.findContentRevisions.mockResolvedValue(["1-displayed"]);
        f.db.storeDeletionWithBaseRevision.mockResolvedValue(false);
        await expect(deleteFileFromDB(f.ctx, f.file)).resolves.toBe(false);
        expect(f.db.storeDeletionWithBaseRevision).toHaveBeenCalledExactlyOnceWith(path, "1-displayed");
        expect(f.provenance.delete).not.toHaveBeenCalled();
        expect(f.conflict.queueCheckFor).not.toHaveBeenCalled();
        expect(await f.files.get(path)?.body.text()).toBe("displayed bytes");
    });

    it.each(["absent", "deleted", "tombstone"])("accepts an already represented deletion: %s", async (state) => {
        const f = fixture(false);
        f.db.fetchEntryMeta.mockResolvedValue(
            state === "absent"
                ? false
                : makeMetaEntry(path, "2-deleted", state === "deleted" ? { deleted: true } : { _deleted: true })
        );
        await expect(deleteFileFromDBIfPresent(f.ctx, path)).resolves.toBe(true);
        expect(f.db.fetchEntry).not.toHaveBeenCalled();
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.provenance.delete).not.toHaveBeenCalled();
    });

    it.each([
        { target: "1-displayed", accepted: true, cleared: true },
        { target: "2-other", accepted: true, cleared: false },
        { target: "1-displayed", accepted: false, cleared: false },
    ])(
        "clears provenance only for an accepted exact displayed revision: $target/$accepted",
        async ({ target, accepted, cleared }) => {
            const f = fixture(true);
            f.db.delete.mockResolvedValue(accepted);
            await expect(deleteRevisionFromDB(f.ctx, path, target)).resolves.toBe(accepted);
            expect(f.db.delete).toHaveBeenCalledExactlyOnceWith(path, target);
            expect(f.provenance.delete).toHaveBeenCalledTimes(cleared ? 1 : 0);
            expect(f.provenanceRecords.has(path)).toBe(!cleared);
        }
    );

    it.each(["missing metadata", "delete refused", "body unavailable"])(
        "stops legacy conflict resolution at %s",
        async (condition) => {
            const f = fixture(false);
            if (condition === "missing metadata") f.db.fetchEntryMeta.mockResolvedValue(false);
            if (condition === "delete refused") f.db.delete.mockResolvedValue(false);
            await expect(resolveConflictedByDeletingRevision(f.ctx, path, "1-displayed")).resolves.toBe(false);
            expect(f.db.delete).toHaveBeenCalledTimes(condition === "missing metadata" ? 0 : 1);
            expect(f.db.fetchEntryFromMeta).toHaveBeenCalledTimes(condition === "body unavailable" ? 1 : 0);
            expect(f.storage.writeFileAuto).not.toHaveBeenCalled();
            expect(f.storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(f.db.storeWithBaseRevision).not.toHaveBeenCalled();
        }
    );

    it("propagates database deletion errors and keeps provenance for retry", async () => {
        const f = fixture(false);
        const error = new Error("database unavailable");
        f.db.delete.mockRejectedValue(error);
        await expect(deleteFileFromDB(f.ctx, path)).rejects.toBe(error);
        expect(f.provenance.delete).not.toHaveBeenCalled();
        expect(f.provenanceRecords.get(path)).toEqual({ revision: "1-displayed" });
    });
});
