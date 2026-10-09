import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import Replication from "pouchdb-replication";
import type { EntryDoc, FilePathWithPrefix, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import { compareMTime, createTextBlob, readContent } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EntryManager, type EntryManagerOptions } from "@lib/managers/EntryManager/EntryManager";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "./ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

PouchDB.plugin(MemoryAdapter).plugin(Replication);
let nextDatabase = 0;
const databases: PouchDB.Database<EntryDoc>[] = [];
const oldPath = "diagnostic-old.md" as FilePathWithPrefix;
const newPath = "diagnostic-new.md" as FilePathWithPrefix;
const original = "Unchanged synthetic document\n";
const initialTime = 1_000_000;

class TestHandler extends ServiceFileHandlerBase {}

function makeFile(path: FilePathWithPrefix, body: string | string[], mtime = initialTime): UXFileInfo {
    const blob = createTextBlob(body);
    return {
        name: path,
        path,
        stat: { type: "file", ctime: initialTime, mtime, size: blob.size },
        body: blob,
    } as UXFileInfo;
}

function createPeer(deleteMetadataOfDeletedFiles: boolean) {
    const db = new PouchDB<EntryDoc>(`file-deletion-${++nextDatabase}`, { adapter: "memory" });
    databases.push(db);
    const files = new Map<string, UXFileInfo>();
    const reflection = new Map<FilePathWithPrefix, { revision: string; observedStorageMtime?: number }>();
    const settings = {
        ...DEFAULT_SETTINGS,
        useOnlyLocalChunk: true,
        writeDocumentsIfConflicted: false,
        deleteMetadataOfDeletedFiles,
    };
    const setting = { currentSettings: () => settings };
    const pathService = {
        path2id: async (value: string) => value,
        id2path: (id: string, entry?: { path?: string }) => entry?.path ?? id,
        getPath: (entry: { path: FilePathWithPrefix }) => entry.path,
        compareFileFreshness: (file: UXFileInfo, entry: { mtime: number }) =>
            compareMTime(file.stat.mtime, entry.mtime),
        markChangesAreSame: vi.fn(),
    };
    const chunkManager = {
        getChunkIDFromCache: () => false,
        transaction: async (callback: () => Promise<unknown>) => await callback(),
        write: async (chunks: EntryDoc[]) => {
            const results = await db.bulkDocs(chunks);
            return {
                result: results.every((result) => result.ok || result.status === 409),
                processed: { written: results.filter((result) => result.ok).length, cached: 0, duplicated: 0 },
            };
        },
        read: async (ids: string[]) =>
            await Promise.all(
                ids.map(async (id) => {
                    try {
                        return await db.get(id);
                    } catch {
                        return false;
                    }
                })
            ),
    };
    const entries = new EntryManager({
        database: db,
        settingService: setting as unknown as EntryManagerOptions["settingService"],
        pathService: pathService as unknown as EntryManagerOptions["pathService"],
        chunkManager: chunkManager as unknown as EntryManagerOptions["chunkManager"],
        hashManager: {
            usesIndependentIdKey: () => false,
            computeHash: async (value: string) => createHash("sha256").update(value).digest("hex"),
        } as EntryManagerOptions["hashManager"],
        splitter: {
            initialised: Promise.resolve(),
            splitContent: async (note: { data: Blob }) => [await note.data.text()],
        } as EntryManagerOptions["splitter"],
    });
    // Keep the real EntryManager and PouchDB revision tree behind the same
    // forwarding methods provided by LiveSyncLocalDB in maintained hosts.
    const localDatabase = {
        getDBEntry: entries.getDBEntry.bind(entries),
        getDBEntryMeta: entries.getDBEntryMeta.bind(entries),
        getDBEntryFromMeta: entries.getDBEntryFromMeta.bind(entries),
        putDBEntry: entries.putDBEntry.bind(entries),
        putDBEntryAsIndependentRoot: entries.putDBEntryAsIndependentRoot.bind(entries),
        deleteDBEntry: entries.deleteDBEntry.bind(entries),
        getRaw: db.get.bind(db),
    };
    const storageAccess = {
        getStub: async (path: string) => files.get(path) ?? null,
        getFileStub: async (path: string) => files.get(path) ?? null,
        readStubContent: async (file: UXFileInfoStub) => files.get(file.path) ?? null,
        ensureDir: async () => true,
        writeFileAuto: vi.fn(async (path: FilePathWithPrefix, body: string | string[], times: { mtime: number }) => {
            files.set(path, makeFile(path, body, times.mtime));
            return true;
        }),
        deleteVaultItem: vi.fn(async (path: string) => {
            files.delete(path);
        }),
        stat: async (path: string) => files.get(path)?.stat ?? null,
        touched: async () => {},
        triggerFileEvent: vi.fn(),
    };
    const conflict = { queueCheckFor: vi.fn(), queueCheckForIfOpen: vi.fn() };
    const services = {
        API: { addLog: vi.fn() },
        path: pathService,
        setting,
        events: createLiveSyncEventHub(),
        database: { localDatabase },
        vault: { isTargetFile: async () => true, isFileSizeTooLarge: () => false },
        storageAccess,
        conflict,
        fileReflectionProvenance: {
            get: async (path: FilePathWithPrefix) => reflection.get(path),
            set: async (path: FilePathWithPrefix, record: { revision: string }) => {
                reflection.set(path, record);
            },
            delete: async (path: FilePathWithPrefix) => {
                reflection.delete(path);
            },
        },
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
    } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
    const access = new ServiceDatabaseFileAccessBase(services);
    (services as ServiceFileHandlerDependencies).databaseFileAccess = access;
    const handler = new TestHandler(services);
    return { db, entries, access, handler, files, reflection, storageAccess, conflict };
}

type Peer = ReturnType<typeof createPeer>;

async function replicate(source: Peer, receiver: Peer): Promise<MetaEntry[]> {
    const before = (await receiver.db.info()).update_seq;
    await receiver.db.replicate.from(source.db);
    const changes = await receiver.db.changes({ since: before, include_docs: true });
    return changes.results.flatMap(({ doc }) => (doc && "path" in doc ? [doc as MetaEntry] : []));
}

async function fixture(hard: boolean) {
    const source = createPeer(hard);
    const receiver = createPeer(hard);
    source.files.set(oldPath, makeFile(oldPath, original));
    expect(await source.handler.storeFileToDB(source.files.get(oldPath)!)).toBe(true);
    for (const entry of await replicate(source, receiver)) {
        expect(await receiver.handler._anyProcessReplicatedDoc(entry)).toBe(true);
    }
    expect(receiver.reflection.get(oldPath)?.revision).toBe((await receiver.db.get(oldPath))._rev);
    expect(await receiver.access.getConflictedRevs(oldPath)).toEqual([]);
    return { source, receiver };
}

async function deleteAndReplicate(source: Peer, receiver: Peer, hard: boolean) {
    source.files.delete(oldPath);
    expect(await source.handler.deleteFileFromDB(oldPath)).toBe(true);
    const incoming = (await replicate(source, receiver)).find((entry) => entry.path === oldPath);
    expect(incoming).toBeDefined();
    expect(!!incoming?._deleted).toBe(hard);
    return incoming!;
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

describe.each([false, true])("replicated deletion with deleteMetadataOfDeletedFiles=%s", (hard) => {
    it("removes an unchanged receiver file with known provenance and no conflict", async () => {
        const { source, receiver } = await fixture(hard);
        const incoming = await deleteAndReplicate(source, receiver, hard);
        expect(await receiver.access.getConflictedRevs(oldPath)).toEqual([]);

        expect(await receiver.handler._anyProcessReplicatedDoc(incoming)).toBe(true);

        expect(receiver.files.has(oldPath)).toBe(false);
        expect(receiver.reflection.has(oldPath)).toBe(false);
        expect(receiver.storageAccess.deleteVaultItem).toHaveBeenCalledWith(oldPath);
    });

    it("reflects a rename as the new file and removal of the old file", async () => {
        const { source, receiver } = await fixture(hard);
        const renamed = makeFile(newPath, original);
        source.files.delete(oldPath);
        source.files.set(newPath, renamed);
        expect(await source.handler.renameFileInDB(renamed, oldPath)).toBe(true);
        const incoming = await replicate(source, receiver);
        expect(incoming.some((entry) => entry.path === oldPath && !!entry._deleted === hard)).toBe(true);
        expect(incoming.some((entry) => entry.path === newPath)).toBe(true);

        for (const entry of incoming) {
            expect(await receiver.handler._anyProcessReplicatedDoc(entry)).toBe(true);
        }

        expect(receiver.files.has(oldPath)).toBe(false);
        expect(await receiver.files.get(newPath)?.body.text()).toBe(original);
        expect(receiver.reflection.has(oldPath)).toBe(false);
    });

    it("uses the current resurrected revision when an older deletion is processed", async () => {
        const { source, receiver } = await fixture(hard);
        const staleDeletion = await deleteAndReplicate(source, receiver, hard);
        const restored = makeFile(oldPath, "Restored after deletion\n", initialTime + 10_000);
        source.files.set(oldPath, restored);
        expect(await source.handler.storeFileToDB(restored)).toBe(true);
        await replicate(source, receiver);

        expect(await receiver.handler._anyProcessReplicatedDoc(staleDeletion)).toBe(true);

        expect(receiver.storageAccess.deleteVaultItem).not.toHaveBeenCalled();
        expect(await receiver.files.get(oldPath)?.body.text()).toBe("Restored after deletion\n");
        expect(receiver.reflection.get(oldPath)?.revision).toBe((await receiver.db.get(oldPath))._rev);
    });

    it("preserves a genuine unsynchronised local edit when a deletion arrives", async () => {
        const { source, receiver } = await fixture(hard);
        const edited = "Genuine receiver edit\n";
        receiver.files.set(oldPath, makeFile(oldPath, edited, initialTime + 10_000));
        const incoming = await deleteAndReplicate(source, receiver, hard);

        expect(await receiver.handler._anyProcessReplicatedDoc(incoming)).toBe(true);

        expect(receiver.storageAccess.deleteVaultItem).not.toHaveBeenCalled();
        expect(await receiver.files.get(oldPath)?.body.text()).toBe(edited);
        const preserved = await receiver.access.fetchEntry(
            oldPath,
            receiver.reflection.get(oldPath)?.revision,
            true,
            true
        );
        expect(preserved).not.toBe(false);
        if (preserved) expect(readContent(preserved)).toBe(edited);
        expect(receiver.conflict.queueCheckFor).toHaveBeenCalledWith(oldPath);
    });
});

describe("deleted-winner lookup races", () => {
    it("keeps a resurrection replicated after the deleted revision index was read", async () => {
        const { source, receiver } = await fixture(true);
        const incoming = await deleteAndReplicate(source, receiver, true);
        const restored = makeFile(oldPath, "Resurrected during metadata lookup\n", initialTime + 10_000);
        expect(await source.access.storeWithBaseRevision(restored, incoming._rev, true)).not.toBe(false);
        const allDocs = receiver.db.allDocs.bind(receiver.db);
        const indexRead = vi.spyOn(receiver.db, "allDocs").mockImplementationOnce(async (options) => {
            const deletedSnapshot = await allDocs(options);
            await receiver.db.replicate.from(source.db);
            return deletedSnapshot;
        });

        expect(await receiver.handler._anyProcessReplicatedDoc(incoming)).toBe(true);

        expect(indexRead).toHaveBeenCalled();
        expect(receiver.storageAccess.deleteVaultItem).not.toHaveBeenCalled();
        expect(await receiver.files.get(oldPath)?.body.text()).toBe("Resurrected during metadata lookup\n");
        expect(receiver.reflection.get(oldPath)?.revision).toBe((await receiver.db.get(oldPath))._rev);
    });
});
