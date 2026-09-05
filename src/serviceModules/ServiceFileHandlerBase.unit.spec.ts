import { describe, expect, it, vi } from "vitest";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import type {
    FileEventItem,
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
} from "@lib/common/types";
import { createTextBlob } from "@lib/common/utils";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";
import { createLiveSyncEventHub } from "@lib/hub/hub";

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

function createStorageStub(path: string, body: string): UXFileInfoStub {
    const file = createStorageFile(path, body);
    delete (file as Partial<UXFileInfo>).body;
    return file;
}

function createHandler(
    localBody: string,
    remoteBody: string,
    localContentIsKnown: boolean,
    freshness: typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN = TARGET_IS_NEW,
    trackProvenance: boolean = false
) {
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
        storeAsConflictedRevisionWithResult: vi.fn().mockResolvedValue("3-local-preserved"),
    };
    const storageAccess = {
        getFileStub: vi.fn().mockResolvedValue(storageStub),
        getStub: vi.fn().mockResolvedValue(storageStub),
        readStubContent: vi.fn().mockResolvedValue(storageFile),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeFileAuto: vi.fn().mockResolvedValue(true),
        stat: vi.fn().mockResolvedValue(storageFile.stat),
        touched: vi.fn().mockResolvedValue(undefined),
        triggerFileEvent: vi.fn(),
        renameFile: vi.fn(),
    };
    const conflict = {
        queueCheckFor: vi.fn().mockResolvedValue(undefined),
        queueCheckForIfOpen: vi.fn().mockResolvedValue(undefined),
    };
    const pathService = {
        getPath: vi.fn().mockImplementation((entry: MetaEntry) => entry.path),
        path2id: vi.fn().mockImplementation(async (path: string) => path.toLowerCase()),
        compareFileFreshness: vi.fn().mockReturnValue(freshness),
        markChangesAreSame: vi.fn(),
    };
    const provenance = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
    };
    const deps = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess,
        storageAccess,
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict,
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({ writeDocumentsIfConflicted: false }) },
        vault: {},
        fileReflectionProvenance: trackProvenance ? provenance : undefined,
    } as unknown as ServiceFileHandlerDependencies;

    return {
        handler: new TestFileHandler(deps),
        remoteMeta,
        storageStub: storageStub as UXFileInfoStub,
        databaseFileAccess,
        storageAccess,
        conflict,
        pathService,
        provenance,
    };
}

function createRenameHandler(caseInsensitive: boolean, oldEntry: MetaEntry | false = createMeta("old.md", "body")) {
    let processFileEvent: ((item: FileEventItem) => Promise<boolean>) | undefined;
    const databaseFileAccess = {
        fetchEntryMeta: vi.fn().mockImplementation(async (path: UXFileInfoStub | FilePathWithPrefix) => {
            const filePath = typeof path === "string" ? path : path.path;
            return filePath === "new.md" ? false : oldEntry;
        }),
        getConflictedRevs: vi.fn().mockResolvedValue([]),
        fetchEntry: vi.fn().mockResolvedValue(oldEntry),
        delete: vi.fn().mockResolvedValue(true),
        storeWithBaseRevision: vi.fn().mockResolvedValue("4-renamed"),
    };
    const pathService = {
        path2id: vi.fn().mockImplementation(async (path: string) => (caseInsensitive ? path.toLowerCase() : path)),
    };
    const deps = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess,
        storageAccess: { getStub: vi.fn().mockResolvedValue(null) },
        fileProcessing: {
            processFileEvent: {
                addHandler: vi.fn((handler: (item: FileEventItem) => Promise<boolean>) => {
                    processFileEvent = handler;
                }),
            },
        },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict: {},
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({}) },
        vault: { isTargetFile: vi.fn().mockResolvedValue(true) },
    } as unknown as ServiceFileHandlerDependencies;
    const handler = new TestFileHandler(deps);
    if (!processFileEvent) throw new Error("File event handler was not registered");
    return { handler, processFileEvent, databaseFileAccess, pathService };
}

function createRestoredEvent(type: FileEventItem["type"], file: UXFileInfoStub, oldPath?: string): FileEventItem {
    return {
        type,
        key: `${type}-${file.path}`,
        args: { file, oldPath },
        restoredFromPreviousRuntime: true,
    };
}

function createRestoredEventHandler(
    options: {
        currentItems?: Record<string, UXFileInfoStub | { path: FilePath; isFolder: true } | null>;
        caseInsensitiveIds?: boolean;
        isTargetFile?: (path: string) => boolean;
        isTargetFileWithoutDuplication?: (path: string) => boolean;
        isFileSizeTooLarge?: (size: number) => boolean;
    } = {}
) {
    let processFileEvent: ((item: FileEventItem) => Promise<boolean>) | undefined;
    const currentItems = options.currentItems ?? {};
    const storageAccess = {
        normalisePath: vi.fn((path: string) => path.replaceAll("\\", "/")),
        getStub: vi.fn(async (path: string) => currentItems[path] ?? null),
    };
    const pathService = {
        path2id: vi.fn(async (path: string) => (options.caseInsensitiveIds ? path.toLowerCase() : path)),
    };
    const vault = {
        isTargetFile: vi.fn(async (path: string, check?: { skipCaseCollisionCheck?: boolean }) =>
            check?.skipCaseCollisionCheck
                ? (options.isTargetFileWithoutDuplication?.(path) ?? options.isTargetFile?.(path) ?? true)
                : (options.isTargetFile?.(path) ?? true)
        ),
        isFileSizeTooLarge: vi.fn((size: number) => options.isFileSizeTooLarge?.(size) ?? false),
    };
    const dependencies = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess: {},
        storageAccess,
        fileProcessing: {
            processFileEvent: {
                addHandler: vi.fn((handler: (item: FileEventItem) => Promise<boolean>) => {
                    processFileEvent = handler;
                }),
            },
        },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict: {},
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({}) },
        vault,
    } as unknown as ServiceFileHandlerDependencies;
    const handler = new TestFileHandler(dependencies);
    if (!processFileEvent) throw new Error("File event handler was not registered");
    const storeFileToDB = vi.spyOn(handler, "storeFileToDB").mockResolvedValue(true);
    const deleteFileFromDB = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
    const renameFileInDB = vi.spyOn(handler, "renameFileInDB").mockResolvedValue(true);
    return {
        handler,
        processFileEvent,
        storageAccess,
        vault,
        storeFileToDB,
        deleteFileFromDB,
        renameFileInDB,
    };
}

function createConflictedOperationHandler() {
    const displayedRevision = "3-displayed";
    const winner = {
        ...createMeta("note.md", "winner", "3-winner"),
        data: "winner",
    };
    const storageFile = createStorageFile("note.md", "edited displayed content");
    const databaseFileAccess = {
        fetchEntry: vi.fn().mockImplementation(async (file: UXFileInfoStub | FilePathWithPrefix) => {
            const path = typeof file === "string" ? file : file.path;
            return path === "new.md" ? false : winner;
        }),
        fetchEntryMeta: vi.fn().mockImplementation(async (file: UXFileInfoStub | FilePathWithPrefix) => {
            const path = typeof file === "string" ? file : file.path;
            return path === "new.md" ? false : winner;
        }),
        getConflictedRevs: vi.fn().mockImplementation(async (file: UXFileInfoStub | FilePathWithPrefix) => {
            const path = typeof file === "string" ? file : file.path;
            return path === "new.md" ? [] : [displayedRevision];
        }),
        store: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(true),
        storeWithBaseRevision: vi.fn().mockResolvedValue("4-local-edit"),
        storeAsConflictedRevisionWithResult: vi.fn().mockResolvedValue("4-unknown-edit"),
        storeDeletionWithBaseRevision: vi.fn().mockResolvedValue("4-local-delete"),
        findContentRevisions: vi.fn().mockResolvedValue([]),
    };
    const provenance = {
        get: vi
            .fn()
            .mockImplementation(async (path: FilePathWithPrefix) =>
                path === "note.md" || path === "old.md"
                    ? { revision: displayedRevision, observedStorageMtime: 2 }
                    : undefined
            ),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
    };
    const storageAccess = {
        getFileStub: vi.fn().mockResolvedValue(storageFile),
        readStubContent: vi
            .fn()
            .mockImplementation(async (file: UXFileInfoStub) => ({ ...storageFile, path: file.path })),
        stat: vi.fn().mockImplementation(async () => storageFile.stat),
    };
    const conflict = {
        queueCheckFor: vi.fn().mockResolvedValue(undefined),
        queueCheckForIfOpen: vi.fn().mockResolvedValue(undefined),
    };
    const pathService = {
        path2id: vi.fn().mockImplementation(async (path: string) => path.toLowerCase()),
        compareFileFreshness: vi.fn().mockReturnValue(TARGET_IS_NEW),
        markChangesAreSame: vi.fn(),
    };
    const deps = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess,
        storageAccess,
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict,
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({}) },
        vault: {},
        fileReflectionProvenance: provenance,
    } as unknown as ServiceFileHandlerDependencies;
    return {
        handler: new TestFileHandler(deps),
        databaseFileAccess,
        provenance,
        conflict,
        storageFile,
        displayedRevision,
    };
}

describe("ServiceFileHandlerBase.renameFileInDB", () => {
    it("updates one document without deleting it for a case-only rename", async () => {
        const { handler, databaseFileAccess, pathService } = createRenameHandler(true);
        const deleteSpy = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
        const file = createStorageFile("calculus.md", "body");

        await expect(handler.renameFileInDB(file, "Calculus.md" as FilePath)).resolves.toBe(true);

        expect(pathService.path2id).toHaveBeenNthCalledWith(1, "Calculus.md");
        expect(pathService.path2id).toHaveBeenNthCalledWith(2, "calculus.md");
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(file, "2-remote", true);
        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("stores the target before deleting the source for an ordinary rename", async () => {
        const { handler, databaseFileAccess } = createRenameHandler(false);
        const storeSpy = vi.spyOn(handler, "storeFileToDB").mockResolvedValue(true);
        const file = createStorageFile("new.md", "body");

        await expect(handler.renameFileInDB(file, "old.md" as FilePath)).resolves.toBe(true);

        expect(databaseFileAccess.fetchEntryMeta).toHaveBeenCalledWith("old.md", undefined, true);
        expect(storeSpy.mock.invocationCallOrder[0]).toBeLessThan(
            databaseFileAccess.delete.mock.invocationCallOrder[0]
        );
        expect(databaseFileAccess.delete).toHaveBeenCalledWith("old.md");
    });

    it("preserves the source when storing the rename target fails", async () => {
        const { handler } = createRenameHandler(false);
        vi.spyOn(handler, "storeFileToDB").mockResolvedValue(false);
        const deleteSpy = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
        const file = createStorageFile("new.md", "body");

        await expect(handler.renameFileInDB(file, "old.md" as FilePath)).resolves.toBe(false);

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("does not fail when the rename source is already absent", async () => {
        const { handler } = createRenameHandler(false, false);
        vi.spyOn(handler, "storeFileToDB").mockResolvedValue(true);
        const deleteSpy = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
        const file = createStorageFile("new.md", "body");

        await expect(handler.renameFileInDB(file, "old.md" as FilePath)).resolves.toBe(true);

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("dispatches a rename event to the atomic rename handler", async () => {
        const { handler, processFileEvent } = createRenameHandler(true);
        const renameSpy = vi.spyOn(handler, "renameFileInDB").mockResolvedValue(true);
        const file = createStorageFile("calculus.md", "body");
        const event: FileEventItem = {
            type: "RENAME",
            args: { file, oldPath: "Calculus.md" },
            key: "rename",
        };

        await expect(processFileEvent(event)).resolves.toBe(true);

        expect(renameSpy).toHaveBeenCalledWith(file, "Calculus.md");
    });

    it("serialises case variants by their canonical document ID", async () => {
        const { handler, processFileEvent } = createRenameHandler(true);
        let notifyDeleteStarted: (() => void) | undefined;
        let releaseDelete: (() => void) | undefined;
        const deleteStarted = new Promise<void>((resolve) => {
            notifyDeleteStarted = resolve;
        });
        const deleteGate = new Promise<void>((resolve) => {
            releaseDelete = resolve;
        });
        vi.spyOn(handler, "deleteFileFromDB").mockImplementation(async () => {
            notifyDeleteStarted?.();
            await deleteGate;
            return true;
        });
        const storeSpy = vi.spyOn(handler, "storeFileToDB").mockResolvedValue(true);
        const oldFile = createStorageFile("Calculus.md", "body");
        const newFile = createStorageFile("calculus.md", "body");

        const deletePromise = processFileEvent({ type: "DELETE", args: { file: oldFile }, key: "delete" });
        await deleteStarted;
        const createPromise = processFileEvent({ type: "CREATE", args: { file: newFile }, key: "create" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(storeSpy).not.toHaveBeenCalled();
        releaseDelete?.();
        await Promise.all([deletePromise, createPromise]);
        expect(storeSpy).toHaveBeenCalledTimes(1);
    });
});

describe("ServiceFileHandlerBase current storage deletions", () => {
    it.each(["parent/test3/note.md", "parent/Test3/note.md"])(
        "preserves a current file at %s when an older deletion is processed (#1168)",
        async (currentPath) => {
            const saved = createStorageStub("parent/test3/note.md", "unchanged body");
            const current = createStorageStub(currentPath, "unchanged body");
            const { processFileEvent, deleteFileFromDB, storeFileToDB } = createRestoredEventHandler({
                caseInsensitiveIds: true,
                currentItems: { [saved.path]: current },
            });

            await expect(
                processFileEvent({ type: "DELETE", args: { file: saved }, key: "stale-delete" })
            ).resolves.toBe(true);

            expect(deleteFileFromDB).not.toHaveBeenCalled();
            expect(storeFileToDB).not.toHaveBeenCalled();
        }
    );

    it.each([false, true])(
        "does not infer an excluded rename target from an ordinary deletion (restored: %s)",
        async (restored) => {
            const saved = createStorageStub("parent/test3/note.md", "unchanged body");
            const current = createStorageStub("parent/Test3/note.md", "unchanged body");
            const { processFileEvent, deleteFileFromDB, vault } = createRestoredEventHandler({
                caseInsensitiveIds: true,
                currentItems: { [saved.path]: current },
                isTargetFile: (path) => path === saved.path,
            });

            await processFileEvent({
                type: "DELETE",
                args: { file: saved },
                key: "ordinary-delete-with-excluded-current-path",
                ...(restored ? { restoredFromPreviousRuntime: true } : {}),
            });

            expect(deleteFileFromDB).not.toHaveBeenCalled();
            expect(vault.isTargetFile.mock.calls.map(([path]) => path)).not.toContain(current.path);
        }
    );

    it("does not interpret a storage inspection failure as permission to delete", async () => {
        const saved = createStorageStub("note.md", "body");
        const { processFileEvent, storageAccess, deleteFileFromDB } = createRestoredEventHandler();
        storageAccess.getStub.mockRejectedValue(new Error("Storage inspection failed"));

        await processFileEvent({ type: "DELETE", args: { file: saved }, key: "unverified-delete" });

        expect(deleteFileFromDB).not.toHaveBeenCalled();
    });

    it("still deletes a selected file which is absent from current storage", async () => {
        const saved = createStorageStub("note.md", "body");
        const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler();

        await expect(
            processFileEvent({ type: "DELETE", args: { file: saved }, key: "confirmed-delete" })
        ).resolves.toBe(true);

        expect(deleteFileFromDB).toHaveBeenCalledWith(saved);
    });

    it("does not mistake a distinct document returned by storage for the deleted document", async () => {
        const saved = createStorageStub("Note.md", "old body");
        const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler({
            caseInsensitiveIds: false,
            currentItems: { "Note.md": createStorageStub("note.md", "other body") },
        });

        await processFileEvent({ type: "DELETE", args: { file: saved }, key: "distinct-document-delete" });

        expect(deleteFileFromDB).toHaveBeenCalledWith(saved);
    });

    it.each([false, true])(
        "does not turn transient rename-target rejection into deletion (restored: %s)",
        async (restored) => {
            const saved = createStorageStub("old.md", "body");
            const target = createStorageStub("new.md", "body");
            const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler({
                currentItems: { "new.md": target },
                isTargetFile: (path) => path !== "new.md",
                isTargetFileWithoutDuplication: () => true,
            });
            const item = {
                type: "DELETE",
                args: { file: saved, renameTarget: "new.md" },
                key: "temporarily-excluded-target",
                ...(restored ? { restoredFromPreviousRuntime: true } : {}),
            } as FileEventItem;

            await processFileEvent(item);

            expect(deleteFileFromDB).not.toHaveBeenCalled();
        }
    );

    it.each([false, true])(
        "preserves deliberate same-ID moves out of selection (restored: %s)",
        async (restored) => {
            const saved = createStorageStub("Note.md", "body");
            const target = createStorageStub("note.md", "body");
            const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler({
                caseInsensitiveIds: true,
                currentItems: { "Note.md": target, "note.md": target },
                isTargetFile: (path) => path === "Note.md",
            });

            await processFileEvent({
                type: "DELETE",
                args: { file: saved, renameTarget: "note.md" },
                key: "deliberately-excluded-target",
                ...(restored ? { restoredFromPreviousRuntime: true } : {}),
            } as FileEventItem);

            expect(deleteFileFromDB).toHaveBeenCalledOnce();
        }
    );

    it("preserves a recreated source after a rename out of selection", async () => {
        const saved = createStorageStub("Note.md", "body");
        const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler({
            currentItems: {
                "Note.md": createStorageStub("Note.md", "recreated body"),
                "excluded.txt": createStorageStub("excluded.txt", "body"),
            },
            isTargetFile: (path) => path !== "excluded.txt",
        });

        await processFileEvent({
            type: "DELETE",
            args: { file: saved, renameTarget: "excluded.txt" },
            key: "recreated-source",
        } as FileEventItem);

        expect(deleteFileFromDB).not.toHaveBeenCalled();
    });
});

describe("ServiceFileHandlerBase restored storage events", () => {
    it.each(["CREATE", "CHANGED"] as const)("uses the current storage stub for a restored %s event", async (type) => {
        const saved = createStorageStub("note.md", "saved");
        const current = createStorageStub("note.md", "current");
        const { processFileEvent, storeFileToDB } = createRestoredEventHandler({
            currentItems: { "note.md": current },
        });

        await expect(processFileEvent(createRestoredEvent(type, saved))).resolves.toBe(true);

        expect(storeFileToDB).toHaveBeenCalledWith(current);
    });

    it("omits a restored inclusion when its exact path no longer contains that file", async () => {
        const saved = createStorageStub("Note.md", "saved");
        const current = createStorageStub("note.md", "current");
        const { processFileEvent, storeFileToDB, deleteFileFromDB, renameFileInDB } = createRestoredEventHandler({
            currentItems: { "Note.md": current },
        });

        await expect(processFileEvent(createRestoredEvent("CHANGED", saved))).resolves.toBe(true);

        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("suppresses a restored deletion when the path is occupied now", async () => {
        const saved = createStorageStub("note.md", "saved");
        const current = createStorageStub("note.md", "current");
        const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler({
            currentItems: { "note.md": current },
        });

        await expect(processFileEvent(createRestoredEvent("DELETE", saved))).resolves.toBe(true);

        expect(deleteFileFromDB).not.toHaveBeenCalled();
    });

    it("applies a restored deletion by path only after confirming current absence", async () => {
        const saved = createStorageStub("note.md", "saved");
        const { processFileEvent, deleteFileFromDB } = createRestoredEventHandler();

        await expect(processFileEvent(createRestoredEvent("DELETE", saved))).resolves.toBe(true);

        expect(deleteFileFromDB).toHaveBeenCalledWith("note.md");
    });

    it("suppresses a restored deletion when current storage inspection fails", async () => {
        const saved = createStorageStub("note.md", "saved");
        const { processFileEvent, storageAccess, deleteFileFromDB } = createRestoredEventHandler();
        storageAccess.getStub.mockRejectedValueOnce(new Error("storage unavailable"));

        await expect(processFileEvent(createRestoredEvent("DELETE", saved))).resolves.toBe(true);

        expect(deleteFileFromDB).not.toHaveBeenCalled();
    });

    it.each(["CHANGED", "DELETE"] as const)(
        "does not apply a restored %s operation after the path is deselected",
        async (type) => {
            const saved = createStorageStub("note.md", "saved");
            const currentItems = type === "CHANGED" ? { "note.md": createStorageStub("note.md", "current") } : {};
            const { processFileEvent, storeFileToDB, deleteFileFromDB } = createRestoredEventHandler({
                currentItems,
                isTargetFile: () => false,
            });

            await expect(processFileEvent(createRestoredEvent(type, saved))).resolves.toBe(true);

            expect(storeFileToDB).not.toHaveBeenCalled();
            expect(deleteFileFromDB).not.toHaveBeenCalled();
        }
    );

    it("uses the current target for a restored cross-document rename", async () => {
        const saved = createStorageStub("new.md", "saved");
        const current = createStorageStub("new.md", "current");
        const { processFileEvent, renameFileInDB } = createRestoredEventHandler({
            currentItems: { "new.md": current, "old.md": null },
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(renameFileInDB).toHaveBeenCalledWith(current, "old.md");
    });

    it("includes the current rename target without deleting a source which still exists", async () => {
        const saved = createStorageStub("new.md", "saved");
        const currentNew = createStorageStub("new.md", "current new");
        const currentOld = createStorageStub("old.md", "current old");
        const { processFileEvent, storeFileToDB, deleteFileFromDB, renameFileInDB } = createRestoredEventHandler({
            currentItems: { "new.md": currentNew, "old.md": currentOld },
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(storeFileToDB).toHaveBeenCalledWith(currentNew);
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("deletes an absent rename source when the target is also absent", async () => {
        const saved = createStorageStub("new.md", "saved");
        const { processFileEvent, storeFileToDB, deleteFileFromDB, renameFileInDB } = createRestoredEventHandler();

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(deleteFileFromDB).toHaveBeenCalledWith("old.md");
        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("preserves the rename source when a current target cannot be included", async () => {
        const saved = createStorageStub("new.md", "saved");
        const current = createStorageStub("new.md", "current");
        const { processFileEvent, storeFileToDB, deleteFileFromDB, renameFileInDB } = createRestoredEventHandler({
            currentItems: { "new.md": current, "old.md": null },
            isFileSizeTooLarge: () => true,
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("updates one document from the current target for a restored case-only rename", async () => {
        const saved = createStorageStub("note.md", "saved");
        const current = createStorageStub("note.md", "current");
        const { processFileEvent, renameFileInDB } = createRestoredEventHandler({
            currentItems: { "note.md": current, "Note.md": current },
            caseInsensitiveIds: true,
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "Note.md"))).resolves.toBe(true);

        expect(renameFileInDB).toHaveBeenCalledWith(current, "Note.md");
    });

    it("does not replay a case-only rename whose current target is absent", async () => {
        const saved = createStorageStub("note.md", "saved");
        const { processFileEvent, storeFileToDB, deleteFileFromDB, renameFileInDB } = createRestoredEventHandler({
            caseInsensitiveIds: true,
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "Note.md"))).resolves.toBe(true);

        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("still includes a current rename target when source inspection fails", async () => {
        const saved = createStorageStub("new.md", "saved");
        const current = createStorageStub("new.md", "current");
        const { processFileEvent, storageAccess, storeFileToDB, deleteFileFromDB, renameFileInDB } =
            createRestoredEventHandler({ currentItems: { "new.md": current } });
        storageAccess.getStub.mockImplementation(async (path: string) => {
            if (path === "old.md") throw new Error("source unavailable");
            return current;
        });

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(storeFileToDB).toHaveBeenCalledWith(current);
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(renameFileInDB).not.toHaveBeenCalled();
    });

    it("does not delete a rename source when target inspection fails", async () => {
        const saved = createStorageStub("new.md", "saved");
        const { processFileEvent, storageAccess, deleteFileFromDB } = createRestoredEventHandler();
        storageAccess.getStub.mockRejectedValueOnce(new Error("target unavailable"));

        await expect(processFileEvent(createRestoredEvent("RENAME", saved, "old.md"))).resolves.toBe(true);

        expect(deleteFileFromDB).not.toHaveBeenCalled();
    });

    it("reports a failure from an admitted restored operation", async () => {
        const saved = createStorageStub("note.md", "saved");
        const current = createStorageStub("note.md", "current");
        const { processFileEvent, storeFileToDB } = createRestoredEventHandler({
            currentItems: { "note.md": current },
        });
        storeFileToDB.mockRejectedValueOnce(new Error("database unavailable"));

        await expect(processFileEvent(createRestoredEvent("CHANGED", saved))).rejects.toThrow("database unavailable");
    });
});

describe("ServiceFileHandlerBase.dbToStorage", () => {
    it("still reflects a remote logical deletion to an unchanged storage file", async () => {
        const { handler, remoteMeta, storageAccess } = createHandler("known body", "known body", true);
        remoteMeta.deleted = true;
        const deleteVaultItem = vi.fn().mockResolvedValue(undefined);
        Object.assign(storageAccess, { deleteVaultItem });

        await expect(handler.dbToStorage(remoteMeta)).resolves.toBe(true);

        expect(deleteVaultItem).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("applies a canonical filename case change before comparing content", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess, pathService } = createHandler(
            "same body",
            "same body",
            false,
            EVEN
        );
        const remoteMeta = createMeta("calculus.md", "same body");
        const existingFile = {
            ...storageStub,
            name: "Calculus.md",
            path: "Calculus.md" as FilePath,
        };
        const renamedFile = {
            ...existingFile,
            name: "calculus.md",
            path: "calculus.md" as FilePath,
        };
        databaseFileAccess.fetchEntryMeta.mockResolvedValue(remoteMeta);
        databaseFileAccess.fetchEntryFromMeta.mockResolvedValue({ ...remoteMeta, data: "same body" });
        storageAccess.getStub.mockResolvedValue(existingFile);
        storageAccess.renameFile.mockResolvedValue(renamedFile);
        storageAccess.readStubContent.mockResolvedValue(createStorageFile("calculus.md", "same body"));

        await expect(handler.dbToStorage(remoteMeta, existingFile)).resolves.toBe(true);

        expect(pathService.path2id).toHaveBeenCalledWith("Calculus.md");
        expect(pathService.path2id).toHaveBeenCalledWith("calculus.md");
        expect(storageAccess.renameFile).toHaveBeenCalledWith(existingFile, "calculus.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves a file when the canonical path change also changes parent directory case", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess } = createHandler(
            "same body",
            "same body",
            false,
            EVEN
        );
        const remoteMeta = createMeta("renamed/calculus.md", "same body");
        const existingFile = {
            ...storageStub,
            name: "Calculus.md",
            path: "Renamed/Calculus.md" as FilePath,
        };
        databaseFileAccess.fetchEntryMeta.mockResolvedValue(remoteMeta);
        storageAccess.getStub.mockResolvedValue(existingFile);

        await expect(handler.dbToStorage(remoteMeta, existingFile)).resolves.toBe(false);

        expect(storageAccess.renameFile).not.toHaveBeenCalled();
        expect(databaseFileAccess.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("stops remote reflection when the canonical filename case cannot be applied", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess } = createHandler(
            "same body",
            "same body",
            false,
            EVEN
        );
        const remoteMeta = createMeta("calculus.md", "same body");
        const existingFile = {
            ...storageStub,
            name: "Calculus.md",
            path: "Calculus.md" as FilePath,
        };
        databaseFileAccess.fetchEntryMeta.mockResolvedValue(remoteMeta);
        storageAccess.getStub.mockResolvedValue(existingFile);
        storageAccess.renameFile.mockResolvedValue(null);

        await expect(handler.dbToStorage(remoteMeta, existingFile)).resolves.toBe(false);

        expect(databaseFileAccess.fetchEntryFromMeta).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves unknown local storage content as a conflict before applying a remote revision", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "local unsynced",
            "remote update",
            false,
            BASE_IS_NEW
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }),
            "2-remote",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("records the exact revision created while preserving unknown local storage content", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, provenance } = createHandler(
            "local unsynchronised edit",
            "remote update",
            false,
            BASE_IS_NEW,
            true
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }),
            "2-remote",
            true
        );
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "3-local-preserved",
            observedStorageMtime: storageStub.stat.mtime,
        });
    });

    it("applies a remote addition without conflict when local storage is an unmodified older copy (#994)", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "existing synced content\n",
            "existing synced content\nnew desktop paragraph\n",
            false,
            TARGET_IS_NEW
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith(
            "note.md",
            "existing synced content\nnew desktop paragraph\n",
            {
                ctime: 1,
                mtime: 2,
            }
        );
    });

    it("preserves unknown local storage content even when the incoming entry is newer", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "mobile-only local edit\n",
            "desktop-only remote edit\n",
            false,
            TARGET_IS_NEW
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }),
            "2-remote",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves unknown local storage content when freshness is ambiguous", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "local edit in same timestamp window",
            "remote update in same timestamp window",
            false,
            EVEN
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
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
            true,
            EVEN
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
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

    it("rebinds provenance to the surviving revision when duplicate content already matches storage", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, pathService, provenance } =
            createHandler("same body", "same body", false, EVEN, true);
        provenance.get.mockResolvedValue({
            revision: "1-deleted-duplicate",
            observedStorageMtime: storageStub.stat.mtime,
        });
        pathService.compareFileFreshness.mockReturnValue(EVEN);

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: remoteMeta._rev,
            observedStorageMtime: storageStub.stat.mtime,
        });
    });

    it("reflects the explicitly selected revision instead of refetching the winner", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess } = createHandler(
            "old storage",
            "unused",
            false
        );
        const selected = createMeta("note.md", "selected content", "2-selected");
        const winner = createMeta("note.md", "winner content", "3-winner");
        databaseFileAccess.getConflictedRevs.mockResolvedValue([selected._rev]);
        databaseFileAccess.fetchEntryMeta.mockReset();
        databaseFileAccess.fetchEntryMeta.mockResolvedValueOnce(selected).mockResolvedValueOnce(winner);
        databaseFileAccess.fetchEntryFromMeta.mockImplementation(async (meta: MetaEntry) => ({
            ...meta,
            data: meta._rev === selected._rev ? "selected content" : "winner content",
        }));

        await expect(handler.dbToStorageWithSpecificRev(storageStub, selected._rev, true)).resolves.toBe(true);

        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "selected content", {
            ctime: 1,
            mtime: 2,
        });
        expect(databaseFileAccess.fetchEntryMeta).toHaveBeenCalledTimes(2);
    });

    it("refuses to reflect an explicitly selected revision which is no longer live", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "old storage",
            "unused",
            false
        );
        const selected = createMeta("note.md", "selected content", "2-obsolete");
        const winner = createMeta("note.md", "winner content", "3-winner");
        databaseFileAccess.fetchEntryMeta.mockReset();
        databaseFileAccess.fetchEntryMeta.mockResolvedValueOnce(selected).mockResolvedValueOnce(winner);
        databaseFileAccess.getConflictedRevs.mockResolvedValue([]);

        await expect(handler.dbToStorageWithSpecificRev(storageStub, selected._rev, true)).resolves.toBe(false);

        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("reflects an explicitly selected conflict revision while other conflicts remain", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "old storage",
            "unused",
            false,
            TARGET_IS_NEW,
            true
        );
        const selected = createMeta("note.md", "selected content", "2-selected");
        databaseFileAccess.getConflictedRevs.mockResolvedValue(["3-other"]);
        databaseFileAccess.fetchEntryMeta.mockResolvedValue(selected);
        databaseFileAccess.fetchEntryFromMeta.mockResolvedValue({
            ...selected,
            data: "selected content",
        });

        await expect(handler.dbToStorageWithSpecificRev(storageStub, selected._rev, true)).resolves.toBe(true);

        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "selected content", {
            ctime: 1,
            mtime: 2,
        });
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: selected._rev,
            observedStorageMtime: storageStub.stat.mtime,
        });
    });

    it("restores an explicitly selected revision when the Vault file is missing", async () => {
        const { handler, databaseFileAccess, storageAccess, provenance } = createHandler(
            "unused",
            "unused",
            false,
            TARGET_IS_NEW,
            true
        );
        const selected = createMeta("note.md", "selected content", "2-selected");
        databaseFileAccess.getConflictedRevs.mockResolvedValue(["3-other"]);
        databaseFileAccess.fetchEntryMeta.mockResolvedValue(selected);
        databaseFileAccess.fetchEntryFromMeta.mockResolvedValue({
            ...selected,
            data: "selected content",
        });
        storageAccess.getFileStub.mockResolvedValue(null);
        storageAccess.getStub.mockResolvedValue(null);
        storageAccess.stat.mockResolvedValue({ ctime: 1, mtime: 22, size: 16, type: "file" });

        await expect(handler.dbToStorageWithSpecificRev("note.md" as FilePath, selected._rev, true)).resolves.toBe(
            true
        );

        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "selected content", {
            ctime: 1,
            mtime: 2,
        });
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: selected._rev,
            observedStorageMtime: 22,
        });
    });
});

describe("ServiceFileHandlerBase conflicted storage operations", () => {
    it("clears matching Vault provenance when an exact live branch is discarded", async () => {
        const { handler, databaseFileAccess, storageStub, provenance } = createHandler(
            "Vault content",
            "winner content",
            false,
            TARGET_IS_NEW,
            true
        );
        const selectedRevision = "2-selected";
        provenance.get.mockResolvedValue({
            revision: selectedRevision,
            observedStorageMtime: storageStub.stat.mtime,
        });
        Object.assign(databaseFileAccess, {
            delete: vi.fn().mockResolvedValue(true),
        });

        await expect(handler.deleteRevisionFromDB(storageStub, selectedRevision)).resolves.toBe(true);

        expect(databaseFileAccess.delete).toHaveBeenCalledWith(storageStub, selectedRevision);
        expect(provenance.delete).toHaveBeenCalledWith("note.md");
    });

    it("keeps Vault provenance which names another live branch", async () => {
        const { handler, databaseFileAccess, storageStub, provenance } = createHandler(
            "Vault content",
            "winner content",
            false,
            TARGET_IS_NEW,
            true
        );
        provenance.get.mockResolvedValue({
            revision: "3-other",
            observedStorageMtime: storageStub.stat.mtime,
        });
        Object.assign(databaseFileAccess, {
            delete: vi.fn().mockResolvedValue(true),
        });

        await expect(handler.deleteRevisionFromDB(storageStub, "2-selected")).resolves.toBe(true);

        expect(provenance.delete).not.toHaveBeenCalled();
    });

    it("keeps matching Vault provenance when exact branch deletion fails", async () => {
        const { handler, databaseFileAccess, storageStub, provenance } = createHandler(
            "Vault content",
            "winner content",
            false,
            TARGET_IS_NEW,
            true
        );
        provenance.get.mockResolvedValue({
            revision: "2-selected",
            observedStorageMtime: storageStub.stat.mtime,
        });
        Object.assign(databaseFileAccess, {
            delete: vi.fn().mockResolvedValue(false),
        });

        await expect(handler.deleteRevisionFromDB(storageStub, "2-selected")).resolves.toBe(false);

        expect(provenance.delete).not.toHaveBeenCalled();
    });

    it("applies a discarded conflict branch after removing it from the live revision tree", async () => {
        const { handler, databaseFileAccess, storageAccess, storageStub, provenance } = createHandler(
            "Vault content",
            "winner content",
            false,
            TARGET_IS_NEW,
            true
        );
        const discardedRevision = "2-discarded";
        const discarded = createMeta("note.md", "discarded content", discardedRevision);
        const winner = createMeta("note.md", "winner content", "3-winner");
        let deleted = false;
        Object.assign(databaseFileAccess, {
            delete: vi.fn().mockImplementation(async () => {
                deleted = true;
                return true;
            }),
        });
        databaseFileAccess.fetchEntryMeta.mockImplementation(
            async (_file: UXFileInfoStub | FilePathWithPrefix, revision?: string) =>
                revision === discardedRevision ? discarded : winner
        );
        databaseFileAccess.getConflictedRevs.mockImplementation(async () => (deleted ? [] : [discardedRevision]));
        databaseFileAccess.fetchEntryFromMeta.mockImplementation(async (meta: MetaEntry) => ({
            ...meta,
            data: meta._rev === discardedRevision ? "discarded content" : "winner content",
        }));

        await expect(
            handler.resolveConflictedByDeletingRevision(storageStub, discardedRevision)
        ).resolves.toBeUndefined();

        expect(databaseFileAccess.delete).toHaveBeenCalledWith(storageStub, discardedRevision);
        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "discarded content", {
            ctime: 1,
            mtime: 2,
        });
        expect(provenance.delete).toHaveBeenCalledWith("note.md");
    });

    it("stores Vault content as a child of an explicitly selected live revision", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        const selectedRevision = "3-winner";

        await expect(handler.storeFileToDBWithBaseRevision(storageFile, selectedRevision)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, selectedRevision, true);
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit",
            observedStorageMtime: storageFile.stat.mtime,
        });
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("refuses to extend a revision which is no longer live", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        const selectedRevision = "2-obsolete";
        const obsolete = createMeta("note.md", "obsolete", selectedRevision);
        const winner = createMeta("note.md", "winner", "3-winner");
        databaseFileAccess.fetchEntryMeta.mockImplementation(
            async (_file: UXFileInfoStub | FilePathWithPrefix, revision?: string) =>
                revision === selectedRevision ? obsolete : winner
        );

        await expect(handler.storeFileToDBWithBaseRevision(storageFile, selectedRevision)).resolves.toBe(false);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).not.toHaveBeenCalled();
    });

    it("records the selected revision without creating a child when its content already matches the Vault", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        const selectedRevision = "3-winner";
        databaseFileAccess.fetchEntry.mockResolvedValue({
            ...createMeta("note.md", storageFile.body, selectedRevision),
            data: storageFile.body,
        });

        await expect(handler.storeFileToDBWithBaseRevision(storageFile, selectedRevision, false)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: selectedRevision,
            observedStorageMtime: storageFile.stat.mtime,
        });
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("does not create a child when asked only to mark a selected revision which differs from the Vault", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        const selectedRevision = "3-winner";

        await expect(handler.storeFileToDBWithBaseRevision(storageFile, selectedRevision, false)).resolves.toBe(false);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).not.toHaveBeenCalled();
    });

    it("extends the revision displayed in storage when a conflicted file is edited", async () => {
        const { handler, databaseFileAccess, provenance, storageFile, displayedRevision } =
            createConflictedOperationHandler();

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, displayedRevision, true);
        expect(databaseFileAccess.store).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit",
            observedStorageMtime: storageFile.stat.mtime,
        });
    });

    it("keeps the recorded displayed branch when edited content also matches another branch", async () => {
        const { handler, databaseFileAccess, storageFile, displayedRevision } = createConflictedOperationHandler();
        databaseFileAccess.findContentRevisions.mockResolvedValue(["3-other-branch"]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, displayedRevision, true);
    });

    it("reconstructs a missing displayed revision only from a unique exact content match", async () => {
        const { handler, databaseFileAccess, provenance, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue(["3-reconstructed"]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, "3-reconstructed", true);
        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
    });

    it("preserves an edit as a new conflict when the displayed revision cannot be proved", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue(["3-first-match", "3-second-match"]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            storageFile,
            "3-winner",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("preserves an edit when conflicted winner content is unavailable but its metadata remains", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue([]);
        databaseFileAccess.fetchEntry.mockResolvedValue(false);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.fetchEntryMeta).toHaveBeenCalledWith(storageFile, undefined, true);
        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            storageFile,
            "3-winner",
            true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("keeps a generation-one unreadable winner unresolved when no sibling base can exist", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue([]);
        databaseFileAccess.fetchEntry.mockResolvedValue(false);
        databaseFileAccess.fetchEntryMeta.mockResolvedValue({
            _id: "note.md",
            _rev: "1-root",
            path: "note.md",
        });
        databaseFileAccess.storeAsConflictedRevisionWithResult.mockResolvedValue(false);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(false);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).toHaveBeenCalledWith(
            storageFile,
            "1-root",
            true
        );
        expect(provenance.set).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("stores a soft-delete child of the displayed revision instead of deleting the winner", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile, displayedRevision } =
            createConflictedOperationHandler();

        await expect(handler.deleteFileFromDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeDeletionWithBaseRevision).toHaveBeenCalledWith("note.md", displayedRevision);
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
        expect(provenance.delete).toHaveBeenCalledWith("note.md");
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("preserves every branch when a deleted file has no provable displayed revision", async () => {
        const { handler, databaseFileAccess, provenance, conflict } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);

        await expect(handler.deleteFileFromDB("note.md" as FilePath)).resolves.toBe(true);

        expect(databaseFileAccess.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("extends the displayed revision for a case-only rename", async () => {
        const { handler, databaseFileAccess, provenance, displayedRevision } = createConflictedOperationHandler();
        const renamedFile = createStorageFile("note.md", "renamed case content");

        await expect(handler.renameFileInDB(renamedFile, "Note.md" as FilePath)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(renamedFile, displayedRevision, true);
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
        expect(provenance.delete).toHaveBeenCalledWith("Note.md");
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit",
            observedStorageMtime: renamedFile.stat.mtime,
        });
    });

    it("soft-deletes only the displayed source branch for a cross-path rename", async () => {
        const { handler, databaseFileAccess, provenance, conflict, displayedRevision } =
            createConflictedOperationHandler();
        const renamedFile = createStorageFile("new.md", "renamed content");

        await expect(handler.renameFileInDB(renamedFile, "old.md" as FilePath)).resolves.toBe(true);

        expect(databaseFileAccess.storeDeletionWithBaseRevision).toHaveBeenCalledWith("old.md", displayedRevision);
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
        expect(provenance.delete).toHaveBeenCalledWith("old.md");
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("old.md");
    });

    it("preserves every source branch when a cross-path rename has no provable displayed revision", async () => {
        const { handler, databaseFileAccess, provenance, conflict } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue([]);
        vi.spyOn(handler, "storeFileToDB").mockResolvedValue(true);
        const renamedFile = createStorageFile("new.md", "renamed content");

        await expect(handler.renameFileInDB(renamedFile, "old.md" as FilePath)).resolves.toBe(true);

        expect(databaseFileAccess.storeDeletionWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.delete).not.toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("old.md");
    });
});
