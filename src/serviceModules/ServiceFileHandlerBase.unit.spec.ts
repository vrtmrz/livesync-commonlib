import { describe, expect, it, vi } from "vitest";
import { EVEN } from "@lib/common/models/shared.const.symbols";
import type { MetaEntry } from "@lib/common/models/db.type";
import type { UXFileInfo, UXFileInfoStub } from "@lib/common/models/fileaccess.type";
import { createTextBlob } from "@lib/common/utils.database";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

class TestFileHandler extends ServiceFileHandlerBase {}

function byteLength(text: string) {
    return new Blob([text]).size;
}

function createMeta(path: string, body: string, rev = "2-remote"): MetaEntry {
    return {
        _id: "doc-id",
        _rev: rev,
        path,
        ctime: 1,
        mtime: 2,
        size: byteLength(body),
        children: [],
        datatype: "plain",
        type: "plain",
        eden: {},
    } as unknown as MetaEntry;
}

function createStorageFile(path: string, body: string): UXFileInfo {
    return {
        name: path.split("/").pop() || path,
        path,
        stat: {
            ctime: 1,
            mtime: 3,
            size: byteLength(body),
            type: "file",
        },
        body: createTextBlob(body),
    } as UXFileInfo;
}

function createHandler(localBody: string, remoteBody: string, localContentIsKnown: boolean) {
    const path = "note.md";
    const remoteMeta = createMeta(path, remoteBody);
    const remoteEntry = {
        ...remoteMeta,
        data: remoteBody,
    };
    const storageFile = createStorageFile(path, localBody);
    const storageStub = { ...storageFile };
    delete (storageStub as Partial<UXFileInfo>).body;

    const databaseFileAccess = {
        fetchEntryMeta: vi.fn().mockResolvedValue(remoteMeta),
        getConflictedRevs: vi.fn().mockResolvedValue([]),
        fetchEntryFromMeta: vi.fn().mockResolvedValue(remoteEntry),
        hasContentInRevisionHistory: vi.fn().mockResolvedValue(localContentIsKnown),
        storeAsConflictedRevision: vi.fn().mockResolvedValue(true),
    };
    const storageAccess = {
        getFileStub: vi.fn().mockResolvedValue(storageStub),
        getStub: vi.fn().mockResolvedValue(storageStub),
        readStubContent: vi.fn().mockResolvedValue(storageFile),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeFileAuto: vi.fn().mockResolvedValue(true),
        touched: vi.fn().mockResolvedValue(undefined),
        triggerFileEvent: vi.fn(),
    };
    const conflict = {
        queueCheckFor: vi.fn().mockResolvedValue(undefined),
        queueCheckForIfOpen: vi.fn().mockResolvedValue(undefined),
    };
    const pathService = {
        getPath: vi.fn().mockImplementation((entry: MetaEntry) => entry.path),
        compareFileFreshness: vi.fn().mockReturnValue(Symbol("target-is-new")),
        markChangesAreSame: vi.fn(),
    };
    const deps = {
        API: { addLog: vi.fn() },
        databaseFileAccess,
        storageAccess,
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict,
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({ writeDocumentsIfConflicted: false }) },
        vault: {},
    } as unknown as ServiceFileHandlerDependencies;

    return {
        handler: new TestFileHandler(deps),
        remoteMeta,
        storageStub: storageStub as UXFileInfoStub,
        databaseFileAccess,
        storageAccess,
        conflict,
        pathService,
    };
}

describe("ServiceFileHandlerBase.dbToStorage", () => {
    it("preserves unknown local storage content as a conflict before applying a remote revision", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "local unsynced",
            "remote update",
            false
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }),
            "2-remote",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("applies the remote revision when local storage content is already in database history", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "known old revision",
            "remote update",
            true
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevision).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "remote update", {
            ctime: 1,
            mtime: 2,
        });
    });

    it("does not run the protection path when the remote content matches storage", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, pathService } = createHandler(
            "same body",
            "same body",
            false
        );
        pathService.compareFileFreshness.mockReturnValue(EVEN);

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.hasContentInRevisionHistory).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });
});
