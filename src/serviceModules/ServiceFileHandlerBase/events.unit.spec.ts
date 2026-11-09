import type { FileEventItem, FilePathWithPrefix, MetaEntry, UXFolderInfo } from "@lib/common/types";
import { describe, expect, it, vi } from "vitest";

import { processFileEvent, processReplicatedDocument } from "./events";
import { createFileHandlerFixture, makeFileStub, makeMetaEntry } from "../../../_tools/fixtures/file-handler-context";

const path = "note.md" as FilePathWithPrefix;

/** Build a file event with only the operation intent relevant to the case. */
function makeEvent(
    type: FileEventItem["type"],
    filePath: FilePathWithPrefix,
    options: { oldPath?: FilePathWithPrefix; restored?: boolean } = {}
): FileEventItem {
    return {
        type,
        key: filePath,
        args: { file: makeFileStub(filePath), ...(options.oldPath ? { oldPath: options.oldPath } : {}) },
        ...(options.restored ? { restoredFromPreviousRuntime: true as const } : {}),
    };
}

describe("file-handler storage events", () => {
    it("refuses an ordinary rename event without its source path", async () => {
        const { ctx, storage, db, log } = createFileHandlerFixture();

        await expect(processFileEvent(ctx, makeEvent("RENAME", path))).resolves.toBe(false);

        expect(storage.getStub).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining("has no source path"), expect.any(Number));
    });

    it("treats a queued create superseded by current storage absence as complete", async () => {
        const { ctx, storage, db, vault } = createFileHandlerFixture();

        await expect(processFileEvent(ctx, makeEvent("CREATE", path))).resolves.toBe(true);

        expect(vault.isTargetFile).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.getStub).toHaveBeenCalledExactlyOnceWith(path);
        expect(db.fetchEntry).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("does not replay a restored create when its current file is absent", async () => {
        const { ctx, storage, db } = createFileHandlerFixture();

        await expect(processFileEvent(ctx, makeEvent("CREATE", path, { restored: true }))).resolves.toBe(true);

        expect(storage.getStub).toHaveBeenCalledExactlyOnceWith(path);
        expect(db.fetchEntry).not.toHaveBeenCalled();
        expect(db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("keeps internal events for their owning module", async () => {
        const { ctx, storage, db } = createFileHandlerFixture();

        await expect(processFileEvent(ctx, makeEvent("INTERNAL", path))).resolves.toBe(false);

        expect(storage.getStub).not.toHaveBeenCalled();
        expect(db.fetchEntry).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
    });

    it.each([
        ["host-excluded path", makeMetaEntry(path), "excluded"],
        ["oversized metadata", makeMetaEntry(path, "2-large", { size: 500 }), "large"],
        ["built-in flag path", makeMetaEntry("redflag.md" as FilePathWithPrefix), "ignored"],
    ] as const)("skips replication for a %s before storage reflection", async (_description, entry, reason) => {
        const { ctx, storage, vault } = createFileHandlerFixture();
        const metadata: MetaEntry = entry;
        if (reason === "excluded") vault.isTargetFile.mockResolvedValue(false);
        if (reason === "large") vault.isFileSizeTooLarge.mockReturnValue(true);
        const emitEvent = vi.spyOn(ctx.events, "emitEvent");

        await expect(processReplicatedDocument(ctx, metadata)).resolves.toBe(false);

        expect(storage.getStub).not.toHaveBeenCalled();
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(emitEvent).not.toHaveBeenCalled();
    });

    it("does not reflect a replicated document into an existing folder", async () => {
        const { ctx, storage, db } = createFileHandlerFixture();
        const folder: UXFolderInfo = {
            name: "note.md",
            path,
            isFolder: true,
            children: [],
            parent: undefined,
        };
        storage.getStub.mockResolvedValue(folder);
        const emitEvent = vi.spyOn(ctx.events, "emitEvent");

        await expect(processReplicatedDocument(ctx, makeMetaEntry(path, "2-replicated"))).resolves.toBe(true);

        expect(storage.getStub).toHaveBeenCalledExactlyOnceWith(path);
        expect(storage.writeFileAuto).not.toHaveBeenCalled();
        expect(db.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(emitEvent).not.toHaveBeenCalled();
    });
});
