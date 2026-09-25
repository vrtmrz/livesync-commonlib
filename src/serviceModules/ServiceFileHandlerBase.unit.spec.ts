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
import { createBinaryBlob, createTextBlob } from "@lib/common/utils";
import { encodeBinary } from "@lib/string_and_binary/convert";
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
        fetchEntry: vi.fn().mockResolvedValue(remoteEntry),
        hasContentInRevisionHistory: vi.fn().mockResolvedValue(localContentIsKnown),
        storeAsConflictedRevision: vi.fn().mockResolvedValue(true),
        storeAsConflictedRevisionWithResult: vi.fn().mockResolvedValue("3-local-preserved"),
        storeWithBaseRevision: vi.fn().mockResolvedValue("3-local-edit"),
        storeIndependentRevision: vi.fn().mockResolvedValue("1-independent"),
        delete: vi.fn().mockResolvedValue(true),
        findLiveContentRevisions: vi.fn().mockResolvedValue([]),
        createChunks: vi.fn().mockResolvedValue(true),
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

describe("ServiceFileHandlerBase.tryRecordUntrackedFileRevision", () => {
    function fixture(localBody = "same content", databaseBody = "same content") {
        return createHandler(localBody, databaseBody, false, EVEN, true);
    }

    it("records matching current content without writing a file or database revision", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess, provenance } = fixture();

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(true);

        expect(provenance.set).toHaveBeenCalledExactlyOnceWith("note.md", {
            revision: "2-remote", observedStorageMtime: storageStub.stat.mtime,
        });
        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("keeps an existing displayed revision even when current bytes match another revision", async () => {
        const { handler, storageStub, databaseFileAccess, provenance } = fixture();
        provenance.get.mockResolvedValue({ revision: "1-displayed" });

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(databaseFileAccess.fetchEntry).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("does not treat a provenance read failure as a missing record", async () => {
        const { handler, storageStub, databaseFileAccess, provenance } = fixture();
        provenance.get.mockRejectedValue(new Error("store unavailable"));

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(databaseFileAccess.fetchEntry).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("leaves an equal-time local edit unrecorded", async () => {
        const { handler, storageStub, provenance } = fixture("local edit", "current database content");

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("leaves a conflicted revision tree unrecorded", async () => {
        const { handler, storageStub, databaseFileAccess, provenance } = fixture();
        databaseFileAccess.getConflictedRevs.mockResolvedValue(["2-other"]);

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("leaves an unreadable current body unrecorded", async () => {
        const { handler, storageStub, databaseFileAccess, provenance } = fixture();
        databaseFileAccess.fetchEntry.mockResolvedValue(false);

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("rejects a database revision which advances during verification", async () => {
        const { handler, storageStub, databaseFileAccess, provenance } = fixture();
        databaseFileAccess.fetchEntryMeta
            .mockResolvedValueOnce(createMeta("note.md", "same content", "2-remote"))
            .mockResolvedValueOnce(createMeta("note.md", "new content", "3-new"));

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("rejects an external storage edit during verification", async () => {
        const { handler, storageStub, storageAccess, provenance } = fixture();
        storageAccess.getStub
            .mockResolvedValueOnce(storageStub)
            .mockResolvedValueOnce(createStorageFile("note.md", "edited while checking"));

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("does not replace a record created during verification", async () => {
        const { handler, storageStub, provenance } = fixture();
        provenance.get
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ revision: "1-displayed" });

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);

        expect(provenance.set).not.toHaveBeenCalled();
    });

    it("reports a failed record write as unrecorded", async () => {
        const { handler, storageStub, provenance } = fixture();
        provenance.set.mockRejectedValue(new Error("store unavailable"));

        await expect(handler.tryRecordUntrackedFileRevision(storageStub, "2-remote")).resolves.toBe(false);
    });
});

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
    // Event handlers already own the document lock and therefore dispatch to
    // their core operations. Keep the planner fixture focused on that dispatch.
    const storeFileToDB = vi.fn(async (_info: unknown) => true);
    const deleteFileFromDB = vi.fn(async (_info: unknown) => true);
    const renameFileInDB = vi.fn(async (_info: unknown, _oldPath: unknown) => true);
    vi.spyOn(handler as unknown as { storeFileToDBFromRevision: (...args: unknown[]) => Promise<boolean> },
        "storeFileToDBFromRevision").mockImplementation(async (info) => storeFileToDB(info));
    vi.spyOn(handler as unknown as { deleteFileFromDBCore: (...args: unknown[]) => Promise<boolean> },
        "deleteFileFromDBCore").mockImplementation(async (info) => deleteFileFromDB(info));
    vi.spyOn(handler as unknown as { renameFileInDBCore: (...args: unknown[]) => Promise<boolean> },
        "renameFileInDBCore").mockImplementation(async (info, oldPath) => renameFileInDB(info, oldPath));
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
    let processFileEvent: ((item: FileEventItem) => Promise<boolean>) | undefined;
    const displayedRevision = "3-displayed";
    const winner = {
        ...createMeta("note.md", "winner", "3-winner"),
        data: "winner",
    };
    const storageFile = createStorageFile("note.md", "edited displayed content");
    const databaseFileAccess = {
        fetchEntry: vi.fn().mockImplementation(async (file: UXFileInfoStub | FilePathWithPrefix, rev?: string) => {
            const path = typeof file === "string" ? file : file.path;
            if (path === "new.md") return false;
            return rev === displayedRevision
                ? { ...createMeta("note.md", "displayed content", displayedRevision), data: "displayed content" }
                : winner;
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
        storeIndependentRevision: vi.fn().mockResolvedValue("1-independent"),
        createChunks: vi.fn().mockResolvedValue(true),
        storeDeletionWithBaseRevision: vi.fn().mockResolvedValue("4-local-delete"),
        findContentRevisions: vi.fn().mockResolvedValue([]),
        findLiveContentRevisions: vi.fn().mockResolvedValue([]),
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
        normalisePath: vi.fn((path: string) => path),
        getFileStub: vi.fn().mockResolvedValue(storageFile),
        getStub: vi.fn().mockResolvedValue(storageFile),
        triggerFileEvent: vi.fn(),
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
        fileProcessing: { processFileEvent: { addHandler: vi.fn((handler: (item: FileEventItem) => Promise<boolean>) => {
            processFileEvent = handler;
        }) } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict,
        path: pathService,
        setting: { currentSettings: vi.fn().mockReturnValue({}) },
        vault: { isTargetFile: vi.fn().mockResolvedValue(true), isFileSizeTooLarge: vi.fn().mockReturnValue(false) },
        fileReflectionProvenance: provenance,
    } as unknown as ServiceFileHandlerDependencies;
    const handler = new TestFileHandler(deps);
    if (!processFileEvent) throw new Error("File event handler was not registered");
    return {
        handler,
        processFileEvent,
        databaseFileAccess,
        provenance,
        conflict,
        storageAccess,
        storageFile,
        displayedRevision,
    };
}

describe("ServiceFileHandlerBase.renameFileInDB", () => {
    it("finishes concurrent renames which request the same two documents in reverse order", async () => {
        const { handler } = createRenameHandler(false);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const renameCore = vi.spyOn(handler as unknown as {
            renameFileInDBCore: (...args: unknown[]) => Promise<boolean>
        }, "renameFileInDBCore").mockImplementationOnce(async () => {
            await firstGate;
            return true;
        }).mockResolvedValue(true);

        const forward = handler.renameFileInDB(createStorageFile("swap-b.md", "A"), "swap-a.md" as FilePath);
        const backward = handler.renameFileInDB(createStorageFile("swap-a.md", "B"), "swap-b.md" as FilePath);
        try {
            await vi.waitFor(() => expect(renameCore).toHaveBeenCalledTimes(1));
        } finally {
            releaseFirst();
        }
        await expect(Promise.all([forward, backward])).resolves.toEqual([true, true]);
        expect(renameCore).toHaveBeenCalledTimes(2);
    });

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
        const storeSpy = vi.spyOn(handler as unknown as {
            storeFileToDBFromRevision: (...args: unknown[]) => Promise<boolean>
        }, "storeFileToDBFromRevision").mockResolvedValue(true);
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
        vi.spyOn(handler as unknown as {
            storeFileToDBFromRevision: (...args: unknown[]) => Promise<boolean>
        }, "storeFileToDBFromRevision").mockResolvedValue(false);
        const deleteSpy = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
        const file = createStorageFile("new.md", "body");

        await expect(handler.renameFileInDB(file, "old.md" as FilePath)).resolves.toBe(false);

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("does not fail when the rename source is already absent", async () => {
        const { handler } = createRenameHandler(false, false);
        vi.spyOn(handler as unknown as {
            storeFileToDBFromRevision: (...args: unknown[]) => Promise<boolean>
        }, "storeFileToDBFromRevision").mockResolvedValue(true);
        const deleteSpy = vi.spyOn(handler, "deleteFileFromDB").mockResolvedValue(true);
        const file = createStorageFile("new.md", "body");

        await expect(handler.renameFileInDB(file, "old.md" as FilePath)).resolves.toBe(true);

        expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("dispatches a rename event to the atomic rename handler", async () => {
        const { handler, processFileEvent } = createRenameHandler(true);
        const renameSpy = vi.spyOn(handler as unknown as {
            renameFileInDBCore: (...args: unknown[]) => Promise<boolean>
        }, "renameFileInDBCore").mockResolvedValue(true);
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
        vi.spyOn(handler as unknown as {
            deleteFileFromDBCore: (...args: unknown[]) => Promise<boolean>
        }, "deleteFileFromDBCore").mockImplementation(async () => {
            notifyDeleteStarted?.();
            await deleteGate;
            return true;
        });
        const storeSpy = vi.spyOn(handler as unknown as {
            storeFileToDBFromRevision: (...args: unknown[]) => Promise<boolean>
        }, "storeFileToDBFromRevision").mockResolvedValue(true);
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
    it.each(["touched", "stat"] as const)(
        "does not replace newer provenance set while an earlier reflection awaits %s",
        async (pauseAt) => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "displayed body", "remote body", false, TARGET_IS_NEW, true
        );
        let record = { revision: "1-displayed", observedStorageMtime: 3 };
        provenance.get.mockImplementation(async () => record);
        provenance.set.mockImplementation(async (_path: string, next: typeof record) => { record = next; });
        databaseFileAccess.fetchEntry.mockResolvedValue({
            ...createMeta("note.md", "displayed body", "1-displayed"), data: "displayed body"
        });
        let currentFile = createStorageFile("note.md", "displayed body");
        storageAccess.getStub.mockImplementation(async () => createStorageStub("note.md", await currentFile.body.text()));
        storageAccess.readStubContent.mockImplementation(async () => currentFile);
        storageAccess.writeFileAuto.mockImplementation(async (_path: string, body: string) => {
            currentFile = createStorageFile("note.md", body);
            return true;
        });
        let finishPending!: () => void;
        if (pauseAt === "touched") {
            storageAccess.touched.mockImplementation(() => new Promise<void>((resolve) => {
                finishPending = resolve;
            }));
        } else {
            storageAccess.stat.mockImplementation(() => new Promise((resolve) => {
                finishPending = () => resolve(currentFile.stat);
            }));
        }

        const applying = handler.dbToStorage(remoteMeta, storageStub);
        await vi.waitFor(() => expect(storageAccess[pauseAt]).toHaveBeenCalled());
        currentFile = createStorageFile("note.md", "newer reflected branch");
        record = { revision: "4-newer-reflection", observedStorageMtime: currentFile.stat.mtime };
        finishPending();
        await expect(applying).resolves.toBe(true);

        expect(record.revision).toBe("4-newer-reflection");
        expect(provenance.set).not.toHaveBeenCalledWith("note.md", expect.objectContaining({ revision: remoteMeta._rev }));
    });

    it("does not overwrite a local edit made while directory preparation is pending", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "displayed body", "remote body", false, TARGET_IS_NEW, true
        );
        provenance.get.mockResolvedValue({ revision: "1-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) => ({
            ...createMeta("note.md", "displayed body", rev ?? "1-displayed"), data: "displayed body"
        }));
        let currentFile = createStorageFile("note.md", "displayed body");
        storageAccess.getStub.mockImplementation(async () => createStorageStub("note.md", await currentFile.body.text()));
        storageAccess.readStubContent.mockImplementation(async () => currentFile);
        storageAccess.writeFileAuto.mockImplementation(async (_path: string, body: string) => {
            currentFile = createStorageFile("note.md", body);
            return true;
        });
        let finishDirectory!: () => void;
        storageAccess.ensureDir.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finishDirectory = resolve;
        }));

        const applying = handler.dbToStorage(remoteMeta, storageStub);
        await vi.waitFor(() => expect(storageAccess.ensureDir).toHaveBeenCalled());
        currentFile = createStorageFile("note.md", "local edit while waiting");
        finishDirectory();
        await expect(applying).resolves.toBe(true);

        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), "1-displayed", true
        );
        await expect(currentFile.body.text()).resolves.toBe("local edit while waiting");
    });

    it("does not overwrite when a local save changes provenance during directory preparation", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, provenance, conflict } =
            createHandler("displayed body", "remote body", false, TARGET_IS_NEW, true);
        let recorded = "1-displayed";
        provenance.get.mockImplementation(async () => ({ revision: recorded, observedStorageMtime: 3 }));
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) => ({
            ...createMeta("note.md", "displayed body", rev ?? "1-displayed"), data: "displayed body"
        }));
        let finishDirectory!: () => void;
        storageAccess.ensureDir.mockImplementation(() => new Promise<void>((resolve) => {
            finishDirectory = resolve;
        }));

        const applying = handler.dbToStorage(remoteMeta, storageStub);
        await vi.waitFor(() => expect(storageAccess.ensureDir).toHaveBeenCalled());
        recorded = "4-locally-saved";
        databaseFileAccess.getConflictedRevs.mockResolvedValue(["4-locally-saved"]);
        finishDirectory();
        await expect(applying).resolves.toBe(true);

        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
        expect(conflict.queueCheckForIfOpen).toHaveBeenCalledWith("note.md");
    });

    it("does not apply an obsolete incoming revision after the database advances during preparation", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "displayed body", "remote body", false, TARGET_IS_NEW, true
        );
        const newerMeta = createMeta("note.md", "newer body", "4-newer");
        let currentMeta = remoteMeta;
        let currentFile = createStorageFile("note.md", "displayed body");
        let recorded = "1-displayed";
        provenance.get.mockImplementation(async () => ({ revision: recorded, observedStorageMtime: 3 }));
        databaseFileAccess.fetchEntryMeta.mockImplementation(async () => currentMeta);
        databaseFileAccess.fetchEntryFromMeta.mockImplementation(async (meta: MetaEntry) => ({
            ...meta, data: meta._rev === newerMeta._rev ? "newer body" : "remote body"
        }));
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) => ({
            ...createMeta("note.md", rev === newerMeta._rev ? "newer body" : "displayed body", rev ?? "1-displayed"),
            data: rev === newerMeta._rev ? "newer body" : "displayed body"
        }));
        storageAccess.getStub.mockImplementation(async () => createStorageStub("note.md", await currentFile.body.text()));
        storageAccess.readStubContent.mockImplementation(async () => currentFile);
        storageAccess.writeFileAuto.mockImplementation(async (_path: string, body: string) => {
            currentFile = createStorageFile("note.md", body);
            return true;
        });
        let finishDirectory!: () => void;
        storageAccess.ensureDir.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finishDirectory = resolve;
        }));

        const applying = handler.dbToStorage(remoteMeta, storageStub);
        await vi.waitFor(() => expect(storageAccess.ensureDir).toHaveBeenCalled());
        currentMeta = newerMeta;
        currentFile = createStorageFile("note.md", "newer body");
        recorded = newerMeta._rev;
        finishDirectory();
        await expect(applying).resolves.toBe(true);

        expect(storageAccess.writeFileAuto).not.toHaveBeenCalledWith("note.md", "remote body", expect.anything());
        await expect(currentFile.body.text()).resolves.toBe("newer body");
    });

    it("reflects a recorded stale file despite equal coarse timestamps", async () => {
        const { handler, storageStub, databaseFileAccess, storageAccess, provenance, remoteMeta, pathService } =
            createHandler("old content", "new content", false, EVEN, true);
        provenance.get.mockResolvedValue({ revision: "1-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) =>
            rev === "1-displayed"
                ? { ...createMeta("note.md", "old content", "1-displayed"), data: "old content" }
                : { ...remoteMeta, data: "new content" }
        );
        pathService.compareFileFreshness.mockReturnValue(EVEN);

        await expect(handler.storeFileToDB(storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeIndependentRevision).not.toHaveBeenCalled();
        expect(storageAccess.writeFileAuto).toHaveBeenCalledWith("note.md", "new content", {
            ctime: remoteMeta.ctime, mtime: remoteMeta.mtime
        });
    });

    it("preserves an intentional revert to historical bytes when the recorded reflection differs", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, provenance } = createHandler(
            "historical body", "remote body", true, TARGET_IS_NEW, true
        );
        provenance.get.mockResolvedValue({ revision: "2-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockResolvedValue({ ...createMeta("note.md", "displayed body", "2-displayed"), data: "displayed body" });

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), "2-displayed", true
        );
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("does not infer that a historical byte match proves an unknown storage base", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess } = createHandler(
            "historical body", "remote body", true, TARGET_IS_NEW, true
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), true
        );
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });
    it("still reflects a remote logical deletion to an unchanged storage file", async () => {
        const { handler, remoteMeta, storageAccess, provenance, databaseFileAccess } = createHandler(
            "known body", "known body", true, TARGET_IS_NEW, true
        );
        remoteMeta.deleted = true;
        provenance.get.mockResolvedValue({ revision: "1-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockResolvedValue({
            ...createMeta("note.md", "known body", "1-displayed"), data: "known body"
        });
        const deleteVaultItem = vi.fn().mockResolvedValue(undefined);
        Object.assign(storageAccess, { deleteVaultItem });

        await expect(handler.dbToStorage(remoteMeta)).resolves.toBe(true);

        expect(deleteVaultItem).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves a local edit made after deletion checks but before removing storage", async () => {
        const { handler, remoteMeta, storageAccess, provenance, databaseFileAccess } = createHandler(
            "known body", "known body", true, TARGET_IS_NEW, true
        );
        remoteMeta.deleted = true;
        provenance.get.mockResolvedValue({ revision: "1-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockResolvedValue({
            ...createMeta("note.md", "known body", "1-displayed"), data: "known body"
        });
        let currentFile = createStorageFile("note.md", "known body");
        storageAccess.getStub.mockImplementation(async () => currentFile);
        storageAccess.readStubContent.mockImplementation(async () => currentFile);
        let metadataReads = 0;
        databaseFileAccess.fetchEntryMeta.mockImplementation(async () => {
            if (++metadataReads === 2) currentFile = createStorageFile("note.md", "local edit");
            return remoteMeta;
        });
        const deleteVaultItem = vi.fn().mockResolvedValue(undefined);
        Object.assign(storageAccess, { deleteVaultItem });

        await expect(handler.dbToStorage(remoteMeta)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ body: currentFile.body }), "1-displayed", true
        );
        expect(deleteVaultItem).not.toHaveBeenCalled();
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

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), true
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

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), true
        );
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "1-independent",
            observedStorageMtime: storageStub.stat.mtime,
        });
    });

    it("applies a remote addition without conflict when local storage is an unmodified older copy (#994)", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict, provenance } = createHandler(
            "existing synced content\n",
            "existing synced content\nnew desktop paragraph\n",
            false,
            TARGET_IS_NEW,
            true
        );
        provenance.get.mockResolvedValue({ revision: "1-displayed", observedStorageMtime: 3 });
        databaseFileAccess.fetchEntry.mockResolvedValue({
            ...createMeta("note.md", "existing synced content\n", "1-displayed"),
            data: "existing synced content\n"
        });

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

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), true
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

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(
            expect.objectContaining({ path: "note.md" }), true
        );
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
    });

    it("preserves unknown storage even when its content is in database history", async () => {
        const { handler, remoteMeta, storageStub, databaseFileAccess, storageAccess, conflict } = createHandler(
            "known old revision",
            "remote update",
            true,
            EVEN
        );

        await expect(handler.dbToStorage(remoteMeta, storageStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalled();
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
        expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
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
    it("runs an awaited conflict callback after releasing the document lock", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } =
            createConflictedOperationHandler();
        let sawRecordedRevision = false;
        conflict.queueCheckFor.mockImplementation(async () => {
            sawRecordedRevision = provenance.set.mock.calls.some(([_path, record]) =>
                record.revision === "4-local-edit"
            );
            await handler.deleteRevisionFromDB("note.md" as FilePath, "3-displayed");
        });

        let deadline!: ReturnType<typeof setTimeout>;
        try {
            const outcome = await Promise.race([
                handler.storeFileToDB(storageFile),
                new Promise<"blocked">((resolve) => {
                    deadline = setTimeout(() => resolve("blocked"), 100);
                }),
            ]);
            expect(outcome).toBe(true);
            expect(sawRecordedRevision).toBe(true);
            expect(databaseFileAccess.delete).toHaveBeenCalledWith("note.md", "3-displayed");
        } finally {
            clearTimeout(deadline);
        }
    });

    it("keeps conflict callback errors visible and releases the document lock", async () => {
        const { handler, databaseFileAccess, conflict, provenance, storageFile } =
            createConflictedOperationHandler();
        conflict.queueCheckFor.mockRejectedValueOnce(new Error("conflict callback failed"));

        await expect(handler.storeFileToDB(storageFile)).rejects.toThrow("conflict callback failed");
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit", observedStorageMtime: storageFile.stat.mtime
        });
        await expect(handler.deleteRevisionFromDB("note.md" as FilePath, "3-displayed")).resolves.toBe(true);
        expect(databaseFileAccess.delete).toHaveBeenCalledWith("note.md", "3-displayed");
    });

    it("runs an awaited open-conflict callback after releasing the document lock", async () => {
        const { handler, databaseFileAccess, conflict, remoteMeta, storageStub } =
            createHandler("local", "remote", false, TARGET_IS_NEW, true);
        databaseFileAccess.getConflictedRevs.mockResolvedValue(["1-conflict"]);
        conflict.queueCheckForIfOpen.mockImplementation(async () => {
            await handler.deleteRevisionFromDB("note.md" as FilePath, "1-conflict");
        });

        let deadline!: ReturnType<typeof setTimeout>;
        try {
            const outcome = await Promise.race([
                handler.dbToStorage(remoteMeta, storageStub),
                new Promise<"blocked">((resolve) => {
                    deadline = setTimeout(() => resolve("blocked"), 100);
                }),
            ]);
            expect(outcome).toBe(true);
            expect(databaseFileAccess.delete).toHaveBeenCalledWith("note.md", "1-conflict");
        } finally {
            clearTimeout(deadline);
        }
    });

    it("reads an ordinary changed-file stub only once", async () => {
        const { handler, storageAccess, storageFile } = createConflictedOperationHandler();
        const stub = { ...storageFile } as UXFileInfoStub;
        delete (stub as Partial<UXFileInfo>).body;
        storageAccess.getStub.mockResolvedValue(stub);

        await expect(handler.storeFileToDB(stub)).resolves.toBe(true);

        expect(storageAccess.readStubContent).toHaveBeenCalledTimes(1);
    });

    it.each(["note.md", "NOTE.md"])(
        "waits for an in-flight save before reflecting the same document through %s",
        async (incomingPath) => {
        const { handler, databaseFileAccess, storageAccess, storageStub } =
            createHandler("local edit", "remote edit", false, TARGET_IS_NEW, true);
        let releaseSave!: () => void;
        let notifySaveStarted!: () => void;
        const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        databaseFileAccess.storeIndependentRevision.mockImplementationOnce(async () => {
            notifySaveStarted();
            await saveGate;
            return "1-local";
        });

        const saving = handler.storeFileToDB(storageStub);
        await saveStarted;
        const metadataReadsBeforeReflection = databaseFileAccess.fetchEntryMeta.mock.calls.length;
        const reflecting = handler.dbToStorage(incomingPath as FilePathWithPrefix, storageStub);
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(databaseFileAccess.fetchEntryMeta).toHaveBeenCalledTimes(metadataReadsBeforeReflection);
            expect(storageAccess.writeFileAuto).not.toHaveBeenCalled();
        } finally {
            releaseSave();
            await saving;
            await reflecting;
        }
        }
    );

    it("loads a queued local edit after the prior save records its revision", async () => {
        const { handler, databaseFileAccess, storageAccess, provenance, storageStub, remoteMeta } =
            createHandler("first edit", "remote", false, TARGET_IS_NEW, true);
        let current = createStorageFile("note.md", "first edit");
        let recorded = "2-remote";
        provenance.get.mockImplementation(async () => ({ revision: recorded }));
        provenance.set.mockImplementation(async (_path, record) => { recorded = record.revision; });
        storageAccess.readStubContent.mockImplementation(async () => current);
        databaseFileAccess.fetchEntry.mockImplementation(async (_file, rev?: string) =>
            rev === "3-first"
                ? { ...createMeta("note.md", "first edit", "3-first"), data: "first edit" }
                : { ...remoteMeta, data: "remote" }
        );
        let releaseFirst!: () => void;
        let notifyFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        databaseFileAccess.storeWithBaseRevision.mockImplementationOnce(async () => {
            notifyFirstStarted();
            await firstGate;
            return "3-first";
        }).mockResolvedValueOnce("4-second");

        const firstSave = handler.storeFileToDB(storageStub);
        await firstStarted;
        current = createStorageFile("note.md", "second edit");
        const secondSave = handler.storeFileToDB(storageStub);
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(storageAccess.readStubContent).toHaveBeenCalledTimes(1);
            expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledTimes(1);
        } finally {
            releaseFirst();
        }
        await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([true, true]);
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenNthCalledWith(
            2, expect.objectContaining({ body: current.body }), "3-first", true
        );
        expect(recorded).toBe("4-second");
    });

    it("lets a different document proceed while a save is waiting", async () => {
        const { handler, databaseFileAccess, storageStub } =
            createHandler("local edit", "remote edit", false, TARGET_IS_NEW, true);
        let releaseSave!: () => void;
        let notifySaveStarted!: () => void;
        const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        databaseFileAccess.storeIndependentRevision.mockImplementationOnce(async () => {
            notifySaveStarted();
            await saveGate;
            return "1-local";
        });

        const saving = handler.storeFileToDB(storageStub);
        await saveStarted;
        try {
            await expect(handler.deleteRevisionFromDB("other.md" as FilePath, "2-other")).resolves.toBe(true);
            expect(databaseFileAccess.delete).toHaveBeenCalledWith("other.md", "2-other");
        } finally {
            releaseSave();
            await saving;
        }
    });

    it("keeps a burst of distinct reflections concurrent while repeated writes to one document wait", async () => {
        const { handler, databaseFileAccess, storageAccess, provenance } =
            createHandler("unused", "remote", false, TARGET_IS_NEW, true);
        storageAccess.getFileStub.mockResolvedValue(null);
        storageAccess.getStub.mockResolvedValue(null);
        databaseFileAccess.fetchEntryMeta.mockImplementation(async (info) => {
            const path = typeof info === "string" ? info : info.path;
            return { ...createMeta(path, "remote"), _id: path.toLowerCase() };
        });
        databaseFileAccess.fetchEntryFromMeta.mockImplementation(async (meta) => ({ ...meta, data: "remote" }));
        let releaseBusy!: () => void;
        let releaseOthers!: () => void;
        const busyGate = new Promise<void>((resolve) => { releaseBusy = resolve; });
        const othersGate = new Promise<void>((resolve) => { releaseOthers = resolve; });
        const startedOthers = new Set<string>();
        let activeBusy = 0;
        let maxActiveBusy = 0;
        storageAccess.writeFileAuto.mockImplementation(async (path) => {
            if (path === "busy.md") {
                activeBusy++;
                maxActiveBusy = Math.max(maxActiveBusy, activeBusy);
                await busyGate;
                activeBusy--;
            } else {
                startedOthers.add(path);
                await othersGate;
            }
            return true;
        });

        const busyWrites = Array.from({ length: 16 }, () =>
            handler.dbToStorage("busy.md" as FilePathWithPrefix, null, true)
        );
        const paths = Array.from({ length: 32 }, (_, index) => `batch/note-${index}.md` as FilePathWithPrefix);
        const otherWrites = paths.map((path) => handler.dbToStorage(path, null, true));
        try {
            // All distinct writes must reach storage before either gate opens.
            // This checks scheduling rather than elapsed time or throughput.
            await vi.waitFor(() => {
                expect(activeBusy).toBe(1);
                expect(startedOthers.size).toBe(paths.length);
            });
            releaseOthers();
            await expect(Promise.all(otherWrites)).resolves.toEqual(paths.map(() => true));
            expect(activeBusy).toBe(1);
            expect(provenance.set).toHaveBeenCalledTimes(paths.length);
        } finally {
            releaseOthers();
            releaseBusy();
            await Promise.all([...busyWrites, ...otherWrites]);
        }
        expect(maxActiveBusy).toBe(1);
        expect(storageAccess.writeFileAuto).toHaveBeenCalledTimes(48);
    });

    it("uses the reflected revision as the base for a save queued behind an incoming write", async () => {
        const { handler, databaseFileAccess, storageAccess, provenance, storageStub } =
            createHandler("old", "remote", false, TARGET_IS_NEW, true);
        let recorded: string | undefined;
        let current = createStorageFile("note.md", "old");
        provenance.get.mockImplementation(async () => recorded ? { revision: recorded } : undefined);
        provenance.set.mockImplementation(async (_path, record) => { recorded = record.revision; });
        storageAccess.readStubContent.mockImplementation(async () => current);
        let releaseWrite!: () => void;
        let notifyWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });
        const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
        storageAccess.writeFileAuto.mockImplementationOnce(async () => {
            notifyWriteStarted();
            await writeGate;
            return true;
        });

        const reflecting = handler.dbToStorageWithSpecificRev(storageStub, "2-remote", true);
        await writeStarted;
        current = createStorageFile("note.md", "edit after reflection");
        const saving = handler.storeFileToDB(storageStub);
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(storageAccess.readStubContent).not.toHaveBeenCalled();
        } finally {
            releaseWrite();
        }
        await expect(Promise.all([reflecting, saving])).resolves.toEqual([true, true]);
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ body: current.body }), "2-remote", true
        );
    });

    it("releases a document lock after a failed save", async () => {
        const { handler, databaseFileAccess, storageStub } =
            createHandler("local edit", "remote edit", false, TARGET_IS_NEW, true);
        databaseFileAccess.storeIndependentRevision.mockRejectedValueOnce(new Error("save failed"));

        await expect(handler.storeFileToDB(storageStub)).rejects.toThrow("save failed");
        await expect(handler.deleteRevisionFromDB("note.md" as FilePath, "2-remote")).resolves.toBe(true);
        expect(databaseFileAccess.delete).toHaveBeenCalledWith("note.md", "2-remote");
    });

    it("reports a repeatedly changing restored file without assigning stale provenance", async () => {
        const { processFileEvent, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        let current = storageFile;
        let nextEdit = 0;
        storageAccess.getStub.mockImplementation(async () => current);
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) => {
            if (!rev) current = createStorageFile("note.md", `changing edit ${++nextEdit}`);
            return rev
                ? { ...createMeta("note.md", "displayed content", rev), data: "displayed content" }
                : { ...createMeta("note.md", "winner", "3-winner"), data: "winner" };
        });

        await expect(processFileEvent(createRestoredEvent("CHANGED", storageFile))).resolves.toBe(false);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(provenance.set).not.toHaveBeenCalled();
        expect(storageAccess.triggerFileEvent).not.toHaveBeenCalled();
    });

    it("directly reconciles a restored file after two snapshot changes without a watcher", async () => {
        const { processFileEvent, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        let current = storageFile;
        let currentFetches = 0;
        storageAccess.getStub.mockImplementation(async () => current);
        databaseFileAccess.fetchEntry.mockImplementation(async (_file: UXFileInfoStub, rev?: string) => {
            if (!rev) {
                currentFetches++;
                if (currentFetches === 1) current = createStorageFile("note.md", "second local edit");
                if (currentFetches === 2) current = createStorageFile("note.md", "third local edit");
                return { ...createMeta("note.md", "winner", "3-winner"), data: "winner" };
            }
            return { ...createMeta("note.md", "displayed content", rev), data: "displayed content" };
        });

        await expect(processFileEvent(createRestoredEvent("CHANGED", storageFile))).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ body: current.body }), "3-displayed", true
        );
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit", observedStorageMtime: current.stat.mtime
        });
        expect(storageAccess.triggerFileEvent).not.toHaveBeenCalled();
    });

    it("reconciles a storage change after a durable save without relying on a watcher", async () => {
        const { processFileEvent, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        let current = storageFile;
        storageAccess.getStub.mockImplementation(async () => current);
        databaseFileAccess.storeWithBaseRevision.mockImplementationOnce(async () => {
            current = createStorageFile("note.md", "edit after first save");
            return "4-first-save";
        });

        await expect(processFileEvent(createRestoredEvent("CHANGED", storageFile))).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledTimes(2);
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenLastCalledWith(
            expect.objectContaining({ body: current.body }), "3-displayed", true
        );
        expect(provenance.set).toHaveBeenCalledTimes(1);
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit", observedStorageMtime: current.stat.mtime
        });
    });

    it("reuses the current loaded entry when checking known current provenance", async () => {
        const { handler, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        provenance.get.mockResolvedValue({ revision: "3-winner", observedStorageMtime: 2 });
        databaseFileAccess.getConflictedRevs.mockResolvedValue([]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.fetchEntry).toHaveBeenCalledTimes(1);
        expect(databaseFileAccess.fetchEntry).toHaveBeenCalledWith(storageFile, undefined, true, true, true);
        expect(databaseFileAccess.fetchEntryMeta).not.toHaveBeenCalled();
        expect(databaseFileAccess.findLiveContentRevisions).not.toHaveBeenCalled();
        expect(storageAccess.getStub).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, "3-winner", true);
    });

    it.each([
        { localBytes: [0, 255, 31], edited: false },
        { localBytes: [0, 255, 32], edited: true },
    ])("compares a binary Vault file with decoded known provenance (edited=$edited)", async ({ localBytes, edited }) => {
        const { handler, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        const binary = new Uint8Array([0, 255, 31]);
        const encoded = await encodeBinary(binary);
        const revision = "3-winner";
        const entry = {
            ...createMeta("attachment.bin", "", revision),
            type: "newnote",
            datatype: "newnote",
            size: binary.byteLength,
            data: encoded,
        };
        storageFile.path = "attachment.bin" as FilePath;
        storageFile.name = "attachment.bin";
        storageFile.body = createBinaryBlob(new Uint8Array(localBytes));
        storageFile.stat.size = localBytes.length;
        provenance.get.mockResolvedValue({ revision, observedStorageMtime: 2 });
        databaseFileAccess.fetchEntry.mockResolvedValue(entry);
        databaseFileAccess.getConflictedRevs.mockResolvedValue([]);
        storageAccess.getStub.mockResolvedValue(storageFile);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        if (edited) {
            expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(storageFile, revision, true);
        } else {
            expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
            expect(databaseFileAccess.storeIndependentRevision).not.toHaveBeenCalled();
            expect(databaseFileAccess.findLiveContentRevisions).not.toHaveBeenCalled();
        }
    });

    it("saves the body and base captured before an external edit during a delayed read", async () => {
        const { handler, databaseFileAccess, provenance, storageAccess, storageFile } =
            createConflictedOperationHandler();
        let current = storageFile;
        let revision = "3-displayed";
        provenance.get.mockImplementation(async () => ({ revision, observedStorageMtime: 2 }));
        storageAccess.getStub.mockImplementation(async () => current);
        const staleStub = { ...storageFile } as UXFileInfoStub;
        delete (staleStub as Partial<UXFileInfo>).body;
        storageAccess.readStubContent.mockImplementationOnce(async () => {
            current = createStorageFile("note.md", "winner");
            revision = "3-winner";
            return createStorageFile("note.md", "edited displayed content");
        });

        await expect(handler.storeFileToDB(staleStub)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ body: storageFile.body }), "3-displayed", true
        );
        expect(databaseFileAccess.storeIndependentRevision).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "4-local-edit", observedStorageMtime: storageFile.stat.mtime
        });
    });

    it("repairs chunks without consulting provenance or creating a document revision", async () => {
        const { handler, databaseFileAccess, provenance, storageFile } = createConflictedOperationHandler();

        await expect(handler.storeFileToDB(storageFile, false, true)).resolves.toBe(true);

        expect(databaseFileAccess.createChunks).toHaveBeenCalledWith(storageFile, false, true);
        expect(provenance.get).not.toHaveBeenCalled();
        expect(databaseFileAccess.fetchEntry).not.toHaveBeenCalled();
    });

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

    it("deduplicates a missing displayed revision from a matching live leaf", async () => {
        const { handler, databaseFileAccess, provenance, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findLiveContentRevisions.mockResolvedValue(["3-reconstructed"]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeIndependentRevision).not.toHaveBeenCalled();
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "3-reconstructed", observedStorageMtime: storageFile.stat.mtime
        });
    });

    it("preserves an edit as a new conflict when the displayed revision cannot be proved", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue(["1-historical-match"]);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(storageFile, true);
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("preserves an edit when conflicted winner content is unavailable but its metadata remains", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue([]);
        databaseFileAccess.fetchEntry.mockResolvedValue(false);

        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.fetchEntryMeta).toHaveBeenCalledWith(storageFile, undefined, true);
        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(storageFile, true);
        expect(conflict.queueCheckFor).toHaveBeenCalledWith("note.md");
    });

    it("preserves unknown storage beside a generation-one unreadable winner", async () => {
        const { handler, databaseFileAccess, provenance, conflict, storageFile } = createConflictedOperationHandler();
        provenance.get.mockResolvedValue(undefined);
        databaseFileAccess.findContentRevisions.mockResolvedValue([]);
        databaseFileAccess.fetchEntry.mockResolvedValue(false);
        databaseFileAccess.fetchEntryMeta.mockResolvedValue({
            _id: "note.md",
            _rev: "1-root",
            path: "note.md",
        });
        await expect(handler.storeFileToDB(storageFile)).resolves.toBe(true);

        expect(databaseFileAccess.storeIndependentRevision).toHaveBeenCalledWith(storageFile, true);
        expect(provenance.set).toHaveBeenCalledWith("note.md", {
            revision: "1-independent", observedStorageMtime: storageFile.stat.mtime
        });
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
