import { vi } from "vitest";

import { DEFAULT_SETTINGS, EntryTypes } from "@lib/common/types";
import { EVEN } from "@lib/common/models/shared.const.symbols";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { createFileHandlerContext } from "@lib/serviceModules/ServiceFileHandlerBase/context";

import type {
    AnyEntry,
    DocumentID,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
} from "@lib/common/types";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type {
    FileReflectionProvenance,
    FileReflectionProvenanceRecord,
} from "@lib/interfaces/FileReflectionProvenance";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import type {
    ServiceFileHandlerDependencies,
    FileHandlerContext,
    FileHandlerHost,
} from "@lib/serviceModules/ServiceFileHandlerBase/context";
import type { IPathService, IVaultService } from "@lib/services/base/IService";
import type { LogFunction } from "@lib/services/lib/logUtils";

/** Timestamp defaults used by file and metadata constructors. */
const DEFAULT_TIMESTAMP = 1_000;

/** Options for constructing a real file observation. */
export interface TestFileOptions {
    /** Modification time recorded in the synthetic storage stat. */
    mtime?: number;
    /** Creation time recorded in the synthetic storage stat. */
    ctime?: number;
}

/** Options for constructing a metadata document. */
export interface TestMetaEntryOptions {
    /** Mark the document as a logical deletion. */
    deleted?: boolean;
    /** Mark the document as physically deleted. */
    _deleted?: boolean;
    /** Modification time recorded in the metadata. */
    mtime?: number;
    /** Creation time recorded in the metadata. */
    ctime?: number;
    /** Byte size recorded in the metadata. */
    size?: number;
}

/** Options for creating a file-handler fixture. */
export interface FileHandlerFixtureOptions {
    /** Omit the optional device-local provenance service from the captured context. */
    includeProvenance?: boolean;
}

/**
 * Build a real File observation with the path and timestamps expected by the file handler.
 * @param path - The storage path represented by the file.
 * @param contents - The bytes stored in the real File body.
 * @param options - Optional storage timestamps.
 * @returns A UXFileInfo whose body is a real File and therefore also a Blob.
 */
export function makeFile(
    path: FilePathWithPrefix,
    contents: string | readonly string[] | ArrayBuffer | Blob = "fixture content\n",
    options: TestFileOptions = {}
): UXFileInfo {
    const parts: BlobPart[] =
        typeof contents === "string" || contents instanceof ArrayBuffer || contents instanceof Blob
            ? [contents]
            : [...contents];
    const name = path.split("/").at(-1) || path;
    const body = new File(parts, name, { type: "text/plain" });
    return {
        name,
        path,
        stat: {
            type: "file",
            ctime: options.ctime ?? DEFAULT_TIMESTAMP,
            mtime: options.mtime ?? DEFAULT_TIMESTAMP,
            size: body.size,
        },
        body,
    };
}

/**
 * Build a stat-bearing stub without a body.
 * @param path - The storage path represented by the stub.
 * @param options - Optional size and timestamps.
 * @returns A typed UXFileInfoStub suitable for storage and handler calls.
 */
export function makeFileStub(
    path: FilePathWithPrefix,
    options: TestFileOptions & { size?: number } = {}
): UXFileInfoStub {
    return {
        name: path.split("/").at(-1) || path,
        path,
        stat: {
            type: "file",
            ctime: options.ctime ?? DEFAULT_TIMESTAMP,
            mtime: options.mtime ?? DEFAULT_TIMESTAMP,
            size: options.size ?? 0,
        },
    };
}

/**
 * Build a valid plain-note Metadata document for database boundary tests.
 * @param path - The document's storage path and synthetic ID.
 * @param revision - The exact database revision.
 * @param options - Optional deletion flags and file statistics.
 * @returns A typed Metadata document with no Chunk references.
 */
export function makeMetaEntry(
    path: FilePathWithPrefix,
    revision = "1-test",
    options: TestMetaEntryOptions = {}
): MetaEntry {
    return {
        _id: String(path) as DocumentID,
        _rev: revision,
        path,
        type: EntryTypes.NOTE_PLAIN,
        ctime: options.ctime ?? DEFAULT_TIMESTAMP,
        mtime: options.mtime ?? DEFAULT_TIMESTAMP,
        size: options.size ?? 0,
        children: [],
        eden: {},
        ...(options.deleted === undefined ? {} : { deleted: options.deleted }),
        ...(options._deleted === undefined ? {} : { _deleted: options._deleted }),
    };
}

/**
 * Create real file-handler context and typed boundary mocks for focused unit tests.
 * @param options - Optional fixture capabilities.
 * @returns A captured context and its configurable database, storage, path, conflict, and provenance mocks.
 * @remarks Mocking stays at the injected service boundary; responsibility modules and internal helpers remain real.
 */
export function createFileHandlerFixture(options: FileHandlerFixtureOptions = {}) {
    const files = new Map<FilePathWithPrefix, UXFileInfo>();
    const provenanceRecords = new Map<FilePathWithPrefix, FileReflectionProvenanceRecord>();

    const db = {
        delete: vi.fn<DatabaseFileAccess["delete"]>(async () => true),
        store: vi.fn<DatabaseFileAccess["store"]>(async () => true),
        storeWithBaseRevision: vi.fn<DatabaseFileAccess["storeWithBaseRevision"]>(async () => "2-stored"),
        storeWithLiveBaseRevision: vi.fn<DatabaseFileAccess["storeWithLiveBaseRevision"]>(async () => "2-stored"),
        storeIndependentRevision: vi.fn<DatabaseFileAccess["storeIndependentRevision"]>(async () => "1-independent"),
        storeAsConflictedRevision: vi.fn<DatabaseFileAccess["storeAsConflictedRevision"]>(async () => true),
        storeAsConflictedRevisionWithResult: vi.fn<DatabaseFileAccess["storeAsConflictedRevisionWithResult"]>(
            async () => "2-conflicted"
        ),
        storeDeletionWithBaseRevision: vi.fn<DatabaseFileAccess["storeDeletionWithBaseRevision"]>(
            async () => "2-deleted"
        ),
        storeContent: vi.fn<DatabaseFileAccess["storeContent"]>(async () => true),
        createChunks: vi.fn<DatabaseFileAccess["createChunks"]>(async () => true),
        hasContentInRevisionHistory: vi.fn<DatabaseFileAccess["hasContentInRevisionHistory"]>(async () => false),
        findContentRevisions: vi.fn<DatabaseFileAccess["findContentRevisions"]>(async () => []),
        findLiveContentRevisions: vi.fn<DatabaseFileAccess["findLiveContentRevisions"]>(async () => []),
        fetch: vi.fn<DatabaseFileAccess["fetch"]>(async () => false),
        fetchEntryFromMeta: vi.fn<DatabaseFileAccess["fetchEntryFromMeta"]>(async () => false),
        fetchEntryMeta: vi.fn<DatabaseFileAccess["fetchEntryMeta"]>(async () => false),
        fetchEntry: vi.fn<DatabaseFileAccess["fetchEntry"]>(async () => false),
        getConflictedRevs: vi.fn<DatabaseFileAccess["getConflictedRevs"]>(async () => []),
    } satisfies DatabaseFileAccess;

    const storage = {
        normalisePath: vi.fn((path: string) => path),
        restoreState: vi.fn(async () => {}),
        hasPendingFileEvent: vi.fn((_path: string) => false),
        deleteVaultItem: vi.fn<StorageAccess["deleteVaultItem"]>(async (item) => {
            files.delete((typeof item === "string" ? item : item.path) as FilePathWithPrefix);
        }),
        renameFile: vi.fn<StorageAccess["renameFile"]>(async () => null),
        writeFileAuto: vi.fn<StorageAccess["writeFileAuto"]>(async () => true),
        readFileAuto: vi.fn<StorageAccess["readFileAuto"]>(async () => ""),
        readFileText: vi.fn<StorageAccess["readFileText"]>(async () => ""),
        isExists: vi.fn<StorageAccess["isExists"]>(async () => false),
        writeHiddenFileAuto: vi.fn<StorageAccess["writeHiddenFileAuto"]>(async () => true),
        appendHiddenFile: vi.fn<StorageAccess["appendHiddenFile"]>(async () => true),
        stat: vi.fn<StorageAccess["stat"]>(async (path) => files.get(path as FilePathWithPrefix)?.stat ?? null),
        statHidden: vi.fn<StorageAccess["statHidden"]>(async () => null),
        removeHidden: vi.fn<StorageAccess["removeHidden"]>(async () => true),
        readHiddenFileAuto: vi.fn<StorageAccess["readHiddenFileAuto"]>(async () => ""),
        readHiddenFileBinary: vi.fn<StorageAccess["readHiddenFileBinary"]>(async () => new ArrayBuffer(0)),
        readHiddenFileText: vi.fn<StorageAccess["readHiddenFileText"]>(async () => ""),
        isExistsIncludeHidden: vi.fn<StorageAccess["isExistsIncludeHidden"]>(async () => false),
        ensureDir: vi.fn<StorageAccess["ensureDir"]>(async () => true),
        triggerFileEvent: vi.fn<StorageAccess["triggerFileEvent"]>(),
        triggerHiddenFile: vi.fn<StorageAccess["triggerHiddenFile"]>(async () => {}),
        getFileStub: vi.fn<StorageAccess["getFileStub"]>(async (path) => {
            const file = files.get(path as FilePathWithPrefix);
            return file ? { name: file.name, path: file.path, stat: file.stat } : null;
        }),
        readStubContent: vi.fn<StorageAccess["readStubContent"]>(
            async (stub) => files.get(stub.path as FilePathWithPrefix) ?? false
        ),
        getStub: vi.fn<StorageAccess["getStub"]>(async (path) => {
            const file = files.get(path as FilePathWithPrefix);
            return file ? { name: file.name, path: file.path, stat: file.stat } : null;
        }),
        getFiles: vi.fn<StorageAccess["getFiles"]>(async () =>
            [...files.values()].map(({ name, path, stat }) => ({ name, path, stat }))
        ),
        getFileNames: vi.fn<StorageAccess["getFileNames"]>(async () => [...files.keys()]),
        touched: vi.fn<StorageAccess["touched"]>(async () => {}),
        recentlyTouched: vi.fn<StorageAccess["recentlyTouched"]>(async () => false),
        clearTouched: vi.fn<StorageAccess["clearTouched"]>(() => {}),
        delete: vi.fn<StorageAccess["delete"]>(async () => {}),
        trash: vi.fn<StorageAccess["trash"]>(async () => {}),
        getFilesIncludeHidden: vi.fn<StorageAccess["getFilesIncludeHidden"]>(async () => []),
    } satisfies StorageAccess & { hasPendingFileEvent: (path: string) => boolean };

    const path = {
        id2path: vi.fn<IPathService["id2path"]>((id, entry) => entry?.path ?? (String(id) as FilePathWithPrefix)),
        path2id: vi.fn<IPathService["path2id"]>(async (value) => String(value) as DocumentID),
        path2idWithSettings: vi.fn<IPathService["path2idWithSettings"]>(async (value) => String(value) as DocumentID),
        getPath: vi.fn<IPathService["getPath"]>((entry) => entry.path),
        markChangesAreSame: vi.fn<IPathService["markChangesAreSame"]>(() => undefined),
        unmarkChanges: vi.fn<IPathService["unmarkChanges"]>(() => {}),
        compareFileFreshness: vi.fn<IPathService["compareFileFreshness"]>(() => EVEN),
        isMarkedAsSameChanges: vi.fn<IPathService["isMarkedAsSameChanges"]>(() => undefined),
    };
    const setting = { currentSettings: vi.fn(() => ({ ...DEFAULT_SETTINGS })) };
    const vault = {
        isTargetFile: vi.fn<IVaultService["isTargetFile"]>(async () => true),
        isFileSizeTooLarge: vi.fn((_size: number) => false),
    };
    const conflict = {
        queueCheckFor: vi.fn(async (_path: FilePathWithPrefix) => {}),
        queueCheckForIfOpen: vi.fn(async (_path: FilePathWithPrefix) => {}),
    };
    const provenance = {
        get: vi.fn<FileReflectionProvenance["get"]>(async (key) => provenanceRecords.get(key)),
        set: vi.fn<FileReflectionProvenance["set"]>(async (key, record) => {
            provenanceRecords.set(key, record);
        }),
        delete: vi.fn<FileReflectionProvenance["delete"]>(async (key) => {
            provenanceRecords.delete(key);
        }),
        move: vi.fn<FileReflectionProvenance["move"]>(async (from, to) => {
            const record = provenanceRecords.get(from);
            if (record) provenanceRecords.set(to, record);
            provenanceRecords.delete(from);
        }),
    };
    const log = vi.fn<LogFunction>(() => {});

    const host: FileHandlerHost = {
        db: () => db,
        storage: () => storage,
        log,
        getPath: (entry) => entry.path,
        getPathWithoutPrefix: (entry) => entry.path,
        /** Reuse supplied content before asking the storage boundary to load a stub. */
        readFileFromStub: async (stub) => {
            if ("body" in stub && stub.body) return stub;
            const file = await storage.readStubContent(stub);
            if (!file) throw new Error(`File ${stub.path} is not exist on the storage`);
            return file;
        },
        storeFileToDB: vi.fn<FileHandlerHost["storeFileToDB"]>(async () => true),
    };
    const services = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess: db,
        storageAccess: storage,
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        conflict,
        path,
        setting,
        vault,
        fileReflectionProvenance: provenance,
    } as unknown as ServiceFileHandlerDependencies;
    const ctx: FileHandlerContext = createFileHandlerContext(
        options.includeProvenance === false ? { ...services, fileReflectionProvenance: undefined } : services,
        host
    );

    return { ctx, db, storage, path, setting, vault, conflict, provenance, provenanceRecords, files, log, host };
}
