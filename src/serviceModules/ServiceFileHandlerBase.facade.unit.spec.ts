import { describe, expect, it, vi } from "vitest";
import type {
    AnyEntry,
    DocumentID,
    FileEventItem,
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
    UXInternalFileInfoStub,
} from "@lib/common/types";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

/**
 * Build a real file body for observable save and chunk-repair assertions.
 * @param path - Physical path used by the fake storage.
 * @returns An immutable body and its storage metadata.
 */
function fileAt(path = "note.md"): UXFileInfo {
    const body = new Blob(["local content"]);
    return {
        path: path as FilePath,
        name: path,
        stat: { ctime: 1, mtime: 2, size: body.size, type: "file" },
        body,
    };
}

/**
 * Supply the host services exercised by the public facade contracts below.
 * @returns Services, observable side effects, and registration spies.
 * @remarks Unused service capabilities are omitted only at this test boundary.
 */
function fixture() {
    const file = fileAt();
    const db = {
        fetchEntry: vi.fn().mockResolvedValue(false),
        fetchEntryMeta: vi.fn().mockResolvedValue(false),
        getConflictedRevs: vi.fn().mockResolvedValue([]),
        storeWithBaseRevision: vi.fn().mockResolvedValue("1-local"),
        createChunks: vi.fn().mockResolvedValue(true),
    };
    const storage = {
        getFiles: vi.fn().mockResolvedValue([file]),
        getStub: vi.fn().mockResolvedValue(file),
        getFileStub: vi.fn().mockResolvedValue(file),
        readStubContent: vi.fn().mockResolvedValue(file),
    };
    const path = {
        path2id: vi.fn(async (value: string) => value.toLowerCase()),
        getPath: vi.fn((entry: MetaEntry) => entry.path),
    };
    const conflict = {
        queueCheckFor: vi.fn().mockResolvedValue(undefined),
        queueCheckForIfOpen: vi.fn().mockResolvedValue(undefined),
    };
    const fileHandler = vi.fn();
    const replicationHandler = vi.fn();
    const services = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        databaseFileAccess: db,
        storageAccess: storage,
        path,
        conflict,
        setting: { currentSettings: () => ({ writeDocumentsIfConflicted: false }) },
        vault: { isTargetFile: vi.fn().mockResolvedValue(true), isFileSizeTooLarge: vi.fn().mockReturnValue(false) },
        fileProcessing: { processFileEvent: { addHandler: fileHandler } },
        replication: { processSynchroniseResult: { addHandler: replicationHandler } },
    } as unknown as ServiceFileHandlerDependencies;
    return { services, db, storage, path, conflict, file, fileHandler, replicationHandler };
}

/** A concrete host with the base implementation unchanged. */
class PlainHandler extends ServiceFileHandlerBase {}

/**
 * Model a host which resolves database/storage capabilities through getters.
 * @remarks These fields initialise after the base constructor has run.
 */
class GetterHandler extends ServiceFileHandlerBase {
    selectedDB!: DatabaseFileAccess;
    selectedStorage!: StorageAccess;

    /** @returns The host's current database capability. */
    override get db(): DatabaseFileAccess {
        return this.selectedDB;
    }
    /** @returns The host's current storage capability. */
    override get storage(): StorageAccess {
        return this.selectedStorage;
    }
}

/** A host which supplies its own replication handler before registration. */
class ReplicationHandler extends ServiceFileHandlerBase {
    calls = 0;
    seen?: MetaEntry;

    /**
     * Record invocation through the registered callback.
     * @param entry - Replicated metadata passed by the host service.
     * @returns True after the host accepts the entry.
     */
    override async _anyProcessReplicatedDoc(entry: MetaEntry): Promise<boolean> {
        this.calls++;
        this.seen = entry;
        return true;
    }
}

/**
 * Make a live metadata entry for public replication operations.
 * @returns Metadata with no embedded content, following the Metadata/Chunks boundary.
 */
function metadata(): MetaEntry {
    return {
        _id: "document-id" as DocumentID,
        _rev: "1-remote",
        path: "note.md" as FilePath,
        ctime: 1,
        mtime: 2,
        size: 13,
        children: [],
        type: "plain",
        eden: {},
    };
}

describe("ServiceFileHandlerBase host facade contracts", () => {
    it.each([false, true])(
        "uses the internal database namespace for a statless deletion observation (present: %s)",
        async (present) => {
            const f = fixture();
            new PlainHandler(f.services);
            f.storage.getStub.mockResolvedValue(null);
            f.db.fetchEntryMeta.mockResolvedValue(present ? metadata() : false);
            const file: UXInternalFileInfoStub = {
                path: ".obsidian/workspace.json" as FilePath,
                name: "workspace.json",
                isInternal: true,
                stat: undefined,
            };
            const process = f.fileHandler.mock.calls[0][0] as (item: FileEventItem) => Promise<boolean>;

            await expect(process({ type: "DELETE", key: "internal-delete", args: { file } })).resolves.toBe(!present);

            expect(f.db.fetchEntryMeta).toHaveBeenCalledWith("i:.obsidian/workspace.json", undefined, true);
            expect(f.db.fetchEntry).not.toHaveBeenCalled();
            expect(f.db.storeWithBaseRevision).not.toHaveBeenCalled();
        }
    );

    it("uses host database/storage getters and resolves a replaced reader at operation time", async () => {
        const f = fixture();
        const supplied = fixture();
        const handler = new GetterHandler(supplied.services);
        handler.selectedDB = f.db as unknown as DatabaseFileAccess;
        handler.selectedStorage = f.storage as unknown as StorageAccess;
        const replacement = fileAt();
        replacement.body = new Blob(["host reader content"]);
        const reader = vi.fn(async (_stub: UXFileInfoStub | UXFileInfo) => replacement);
        handler.readFileFromStub = reader;

        await expect(handler.storeFileToDB("note.md" as FilePathWithPrefix, true)).resolves.toBe(true);

        expect(f.storage.getFileStub).toHaveBeenCalledWith("note.md");
        expect(supplied.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(supplied.storage.getFileStub).not.toHaveBeenCalled();
        expect(reader).toHaveBeenCalledWith(f.file);
        expect(f.storage.readStubContent).not.toHaveBeenCalled();
        expect(f.db.storeWithBaseRevision).toHaveBeenCalledWith(replacement, undefined, true);
        expect(await replacement.body.text()).toBe("host reader content");
    });

    it("retains the services supplied at construction if the input record is later changed", async () => {
        const f = fixture();
        const handler = new PlainHandler(f.services);
        const other = fixture();
        Object.assign(f.services, other.services);

        await expect(handler.storeFileToDB(f.file, true)).resolves.toBe(true);

        expect(f.db.storeWithBaseRevision).toHaveBeenCalledWith(f.file, undefined, true);
        expect(other.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(f.path.path2id).toHaveBeenCalledWith("note.md");
        expect(other.path.path2id).not.toHaveBeenCalled();
    });

    it("keeps path overrides and log replacement visible through replication processing", async () => {
        const f = fixture();
        const entry = metadata();
        f.db.fetchEntryMeta.mockResolvedValue(entry);
        f.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        const handler = new PlainHandler(f.services);
        handler.getPath = vi.fn((_entry: AnyEntry) => "canonical.md" as FilePathWithPrefix);
        handler.getPathWithoutPrefix = vi.fn((_entry: AnyEntry) => "physical.md" as FilePathWithPrefix);
        const log = vi.fn();
        handler._log = log;

        await expect(handler._anyProcessReplicatedDoc(entry)).resolves.toBe(true);

        expect(f.path.path2id).toHaveBeenCalledWith("canonical.md");
        expect(f.storage.getStub).toHaveBeenCalledWith("physical.md");
        expect(f.db.fetchEntryMeta).toHaveBeenCalledWith("canonical.md", undefined, true);
        expect(f.conflict.queueCheckForIfOpen).toHaveBeenCalledWith("canonical.md");
        expect(log).toHaveBeenCalledWith(expect.stringContaining("Done"));
    });

    it("registers the subclass replication callback with its receiver and original binding", async () => {
        const f = fixture();
        const handler = new ReplicationHandler(f.services);
        const entry = metadata();
        const registered = f.replicationHandler.mock.calls[0][0] as (entry: MetaEntry) => Promise<boolean>;
        const replacement = vi.fn().mockResolvedValue(false);
        handler._anyProcessReplicatedDoc = replacement;

        await expect(registered(entry)).resolves.toBe(true);

        expect(f.replicationHandler).toHaveBeenCalledWith(expect.any(Function), 100);
        expect(handler.calls).toBe(1);
        expect(handler.seen).toBe(entry);
        expect(replacement).not.toHaveBeenCalled();
    });

    it("keeps the operation error authoritative when a deferred conflict callback also fails", async () => {
        const f = fixture();
        const entry = metadata();
        f.db.fetchEntryMeta.mockResolvedValue(entry);
        f.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        const operationError = new Error("operation failed after queuing a conflict check");
        f.conflict.queueCheckForIfOpen.mockRejectedValue(new Error("conflict callback failed"));
        const handler = new PlainHandler(f.services);
        handler._log = (message) => {
            if (typeof message === "string" && message.endsWith("Done")) throw operationError;
        };

        await expect(handler._anyProcessReplicatedDoc(entry)).rejects.toBe(operationError);
        expect(f.conflict.queueCheckForIfOpen).toHaveBeenCalledOnce();

        f.db.getConflictedRevs.mockResolvedValue([]);
        await expect(handler.storeFileToDB(f.file, false, true)).resolves.toBe(true);
        expect(f.db.createChunks).toHaveBeenCalledWith(f.file, false, true);
    });

    it("dispatches chunk repair through the host save override and releases permits after save failure", async () => {
        const f = fixture();
        const files = Array.from({ length: 13 }, (_, i) => fileAt(`file-${i}.md`));
        f.storage.getFiles.mockResolvedValue(files);
        const handler = new PlainHandler(f.services);
        let active = 0;
        let peak = 0;
        let entered = 0;
        let release!: () => void;
        let reportFull!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const full = new Promise<void>((resolve) => {
            reportFull = resolve;
        });
        const save = vi.fn(async () => {
            active++;
            peak = Math.max(peak, active);
            entered++;
            const attempt = entered;
            if (entered === 10) reportFull();
            try {
                await held;
                if (attempt === 10) throw new Error("chunk creation failed");
                return true;
            } finally {
                active--;
            }
        });
        handler.storeFileToDB = save;
        const repairing = handler.createAllChunks();
        try {
            await full;
            expect(entered).toBe(10);
            release();
            await repairing;
        } finally {
            release();
        }
        expect(peak).toBe(10);
        expect(save).toHaveBeenCalledTimes(13);
        for (const file of files) expect(save).toHaveBeenCalledWith(file, false, true);
        expect(f.db.createChunks).not.toHaveBeenCalled();
    });
});
