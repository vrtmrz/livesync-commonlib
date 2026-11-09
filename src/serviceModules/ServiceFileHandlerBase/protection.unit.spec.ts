import type { FilePathWithPrefix, MetaEntry, UXFolderInfo } from "@lib/common/types";
import { describe, expect, it } from "vitest";

import { preserveUnsyncedStorageAsConflict, recheckIncomingStorage } from "./protection";
import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";

const path = "note.md" as FilePathWithPrefix;
const folder: UXFolderInfo = { name: "note.md", path, isFolder: true, children: [], parent: undefined };

describe("incoming storage protection", () => {
    it("returns a revalidated candidate when storage already has the incoming bytes", async () => {
        const { ctx, db, storage, files } = createFileHandlerFixture();
        const file = makeFile(path, "same bytes");
        files.set(path, file);
        const entry = makeMetaEntry(path, "2-incoming", { size: file.stat.size });

        await expect(
            preserveUnsyncedStorageAsConflict(ctx, path, makeFileStub(path), entry, "same bytes")
        ).resolves.toEqual({
            preserved: false,
            snapshot: { file, revision: undefined },
        });

        expect(storage.readStubContent).toHaveBeenCalledTimes(2);
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("does not create a preservation revision without an incoming revision identity", async () => {
        const { ctx, db, files } = createFileHandlerFixture();
        const file = makeFile(path, "local bytes");
        files.set(path, file);
        const entry = { ...makeMetaEntry(path), _rev: undefined } as MetaEntry;

        await expect(preserveUnsyncedStorageAsConflict(ctx, path, makeFileStub(path), entry)).resolves.toEqual({
            preserved: false,
        });

        expect(db.findLiveContentRevisions).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("refuses a preservation candidate when storage changes during database classification", async () => {
        const { ctx, db, files, storage, provenance } = createFileHandlerFixture();
        const file = makeFile(path, "observed bytes");
        files.set(path, file);
        db.findLiveContentRevisions.mockImplementation(async () => {
            files.set(path, makeFile(path, "concurrent edit", { mtime: 2_000 }));
            return [];
        });

        await expect(
            preserveUnsyncedStorageAsConflict(ctx, path, makeFileStub(path), makeMetaEntry(path, "2-incoming"))
        ).resolves.toEqual({ preserved: false });

        expect(db.findLiveContentRevisions).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path }),
            expect.any(Blob)
        );
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("concurrent edit");
    });

    it("stops an incoming overwrite even when the preservation revision write is refused", async () => {
        const { ctx, db, storage, log, files } = createFileHandlerFixture();
        const file = makeFile(path, "unsynchronised bytes");
        files.set(path, file);
        db.storeIndependentRevision.mockResolvedValue(false);

        await expect(
            preserveUnsyncedStorageAsConflict(ctx, path, makeFileStub(path), makeMetaEntry(path, "2-incoming"))
        ).resolves.toEqual({ preserved: true });

        expect(db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), true);
        expect(log).toHaveBeenCalledWith(
            expect.stringContaining("Prevented overwriting unsynchronised local changes"),
            expect.any(Number)
        );
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(await files.get(path)?.body.text()).toBe("unsynchronised bytes");
    });

    it.each([
        ["missing storage", null],
        ["folder at the file path", folder],
    ] as const)("does not invent a candidate when rechecking %s", async (_description, current) => {
        const { ctx, db, storage } = createFileHandlerFixture();
        storage.getStub.mockResolvedValue(current);

        await expect(
            recheckIncomingStorage(ctx, path, makeMetaEntry(path, "2-incoming"), undefined, false)
        ).resolves.toEqual({
            preserved: false,
        });

        expect(storage.readStubContent).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("retains a conflicted operation after rechecking otherwise matching storage", async () => {
        const { ctx, db, storage, conflict, files } = createFileHandlerFixture();
        const file = makeFile(path, "incoming bytes");
        files.set(path, file);
        db.getConflictedRevs.mockResolvedValue(["3-live-conflict"]);

        await expect(
            recheckIncomingStorage(ctx, path, makeMetaEntry(path, "2-incoming"), "incoming bytes", false)
        ).resolves.toEqual({ preserved: true });

        expect(db.getConflictedRevs).toHaveBeenCalledExactlyOnceWith(path);
        expect(conflict.queueCheckForIfOpen).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
    });
});
