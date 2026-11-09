import type { DocumentID, FileEventItem, FilePathWithPrefix, UXFolderInfo } from "@lib/common/types";
import { describe, expect, it } from "vitest";

import {
    canApplyRestoredDeletion,
    canRecordStorageDeletion,
    getExactCurrentFile,
    isCurrentFileSelected,
    isCurrentPathSelected,
    logRestoredEventValidationFailure,
} from "./selection";
import { createFileHandlerFixture, makeFileStub } from "../../../_tools/fixtures/file-handler-context";

const path = "note.md" as FilePathWithPrefix;

/** Build an event carrying a current rename destination for deletion validation. */
function makeDeleteEvent(source: FilePathWithPrefix, target?: FilePathWithPrefix): FileEventItem {
    return {
        type: "DELETE",
        key: source,
        args: { file: makeFileStub(source), ...(target ? { renameTarget: target } : {}) },
    };
}

describe("current storage selection", () => {
    it.each([
        ["selected path", path, true, true],
        ["host-excluded path", path, false, false],
        ["built-in flag file", "redflag.md" as FilePathWithPrefix, true, false],
    ] as const)(
        "applies host and built-in selection to the %s",
        async (_description, candidate, hostSelected, expected) => {
            const { ctx, vault, log } = createFileHandlerFixture();
            vault.isTargetFile.mockResolvedValue(hostSelected);

            await expect(isCurrentPathSelected(ctx, candidate)).resolves.toBe(expected);

            expect(vault.isTargetFile).toHaveBeenCalledExactlyOnceWith(candidate);
            if (candidate === "redflag.md") {
                expect(log).toHaveBeenCalledWith(expect.stringContaining("should be ignored"), expect.any(Number));
            }
        }
    );

    it("returns only an exact non-folder observation", () => {
        const { ctx, storage } = createFileHandlerFixture();
        const file = makeFileStub(path);
        const folder: UXFolderInfo = {
            name: "note.md",
            path,
            isFolder: true,
            children: [],
            parent: undefined,
        };
        storage.normalisePath.mockImplementation((value) => value.toLowerCase());

        expect(getExactCurrentFile(ctx, file, path)).toBe(file);
        expect(getExactCurrentFile(ctx, { ...file, path: "NOTE.md" as FilePathWithPrefix }, path)).toEqual({
            ...file,
            path: "NOTE.md",
        });
        expect(getExactCurrentFile(ctx, { ...file, path: "other.md" as FilePathWithPrefix }, path)).toBeNull();
        expect(getExactCurrentFile(ctx, folder, path)).toBeNull();
        expect(getExactCurrentFile(ctx, null, path)).toBeNull();
    });

    it("applies the size limit only after the path remains selected", async () => {
        const { ctx, vault, log } = createFileHandlerFixture();
        const file = makeFileStub(path, { size: 500 });
        vault.isFileSizeTooLarge.mockReturnValue(true);

        await expect(isCurrentFileSelected(ctx, file)).resolves.toBe(false);

        expect(vault.isTargetFile).toHaveBeenCalledExactlyOnceWith(path);
        expect(vault.isFileSizeTooLarge).toHaveBeenCalledExactlyOnceWith(500);
        expect(log).toHaveBeenCalledWith(
            expect.stringContaining("exceeds the current maximum size"),
            expect.any(Number)
        );
    });

    it("retains a deletion when its current rename destination is still selected", async () => {
        const { ctx, storage, vault, db } = createFileHandlerFixture();
        const target = "renamed.md" as FilePathWithPrefix;
        const currentTarget = makeFileStub(target, { size: 120 });
        storage.getStub.mockImplementation(async (candidate) => (candidate === target ? currentTarget : null));

        await expect(canRecordStorageDeletion(ctx, makeDeleteEvent(path, target))).resolves.toBe(false);

        expect(storage.getStub).toHaveBeenCalledTimes(2);
        expect(vault.isTargetFile).toHaveBeenCalledExactlyOnceWith(target, { skipCaseCollisionCheck: true });
        expect(db.delete).not.toHaveBeenCalled();
        expect(storage.deleteVaultItem).not.toHaveBeenCalled();
    });

    it("allows deletion intent when the source is confirmed absent", async () => {
        const { ctx, storage, vault } = createFileHandlerFixture();
        storage.getStub.mockResolvedValue(null);

        await expect(canRecordStorageDeletion(ctx, makeDeleteEvent(path))).resolves.toBe(true);

        expect(storage.getStub).toHaveBeenCalledExactlyOnceWith(path);
        expect(vault.isTargetFile).not.toHaveBeenCalled();
    });

    it("preserves deletion intent as pending when restored selection inspection fails", async () => {
        const { ctx, vault, log } = createFileHandlerFixture();
        const failure = new Error("selection unavailable");
        vault.isTargetFile.mockRejectedValue(failure);

        await expect(canApplyRestoredDeletion(ctx, path)).rejects.toBe(failure);

        expect(log).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("the operation remains pending for recovery"),
            expect.any(Number)
        );
        expect(log).toHaveBeenNthCalledWith(2, failure, expect.any(Number));
    });

    it("logs saved-operation validation failures with their cause", () => {
        const { ctx, log } = createFileHandlerFixture();
        const failure = new Error("storage inspection failed");

        logRestoredEventValidationFailure(ctx, path, failure);

        expect(log).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("the operation remains pending for recovery"),
            expect.any(Number)
        );
        expect(log).toHaveBeenNthCalledWith(2, failure, expect.any(Number));
    });
});

describe("rename-deletion preservation decisions", () => {
    it("refuses a rename deletion when the target path now resolves to a folder", async () => {
        const f = createFileHandlerFixture();
        const target = "renamed.md" as FilePathWithPrefix;
        const folder: UXFolderInfo = {
            path: target,
            name: "renamed.md",
            isFolder: true,
            children: [],
            parent: undefined,
        };
        f.storage.getStub.mockImplementation(async (candidate) => (candidate === target ? folder : null));
        await expect(canRecordStorageDeletion(f.ctx, makeDeleteEvent(path, target))).resolves.toBe(false);
        expect(f.vault.isTargetFile).not.toHaveBeenCalled();
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.storage.deleteVaultItem).not.toHaveBeenCalled();
    });

    it("refuses ordinary deletion of a current folder", async () => {
        const f = createFileHandlerFixture();
        const folder: UXFolderInfo = { path, name: "note.md", isFolder: true, children: [], parent: undefined };
        f.storage.getStub.mockResolvedValue(folder);
        await expect(canRecordStorageDeletion(f.ctx, makeDeleteEvent(path))).resolves.toBe(false);
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.path.path2id).not.toHaveBeenCalled();
    });

    it("permits a case-only move out of selection without treating the destination as the old storage file", async () => {
        const f = createFileHandlerFixture();
        const target = "NOTE.md" as FilePathWithPrefix;
        const targetFile = makeFileStub(target);
        f.storage.getStub.mockResolvedValue(targetFile);
        f.vault.isTargetFile.mockResolvedValue(false);
        f.path.path2id.mockImplementation(async (value) => value.toLowerCase() as DocumentID);
        await expect(canRecordStorageDeletion(f.ctx, makeDeleteEvent(path, target))).resolves.toBe(true);
        expect(f.vault.isTargetFile).toHaveBeenCalledExactlyOnceWith(target, { skipCaseCollisionCheck: true });
        expect(f.db.delete).not.toHaveBeenCalled();
        expect(f.storage.deleteVaultItem).not.toHaveBeenCalled();
    });
});
