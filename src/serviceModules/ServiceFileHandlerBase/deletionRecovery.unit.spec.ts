import * as semaphoreScope from "octagonal-wheels/concurrency/semaphore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import {
    DEFAULT_SETTINGS,
    type EntryDoc,
    type FilePathWithPrefix,
    type MetaEntry,
    type UXFileInfo,
    type UXFileInfoStub,
} from "@lib/common/types";
import { compareMTime, createTextBlob } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { FullScanModes, synchroniseAllFilesBetweenDBandStorage } from "@lib/serviceFeatures/offlineScanner";
import { withFileEventPaths } from "./locking";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import { EntryManager, type EntryManagerOptions } from "@lib/managers/EntryManager/EntryManager";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "../ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "../ServiceFileHandlerBase";
import {
    createFileHandlerFixture,
    makeFile as makeContextFile,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";
import { recoverDatabaseDeletion } from "./deletionRecovery";

vi.mock("octagonal-wheels/concurrency/semaphore", { spy: true });

PouchDB.plugin(MemoryAdapter);
let nextDatabase = 0;
const databases: PouchDB.Database<EntryDoc>[] = [];
const path = "folder/note.md" as FilePathWithPrefix;
const original = "Original file\n";
const initialTime = 1_000_000;
class TestHandler extends ServiceFileHandlerBase {}

function makeFile(value = original, target = path, mtime = initialTime): UXFileInfo {
    const body = createTextBlob(value);
    return { name: target, path: target, stat: { type: "file", ctime: initialTime, mtime, size: body.size }, body };
}

/** Real revision storage and file-handler facade, with injectable host I/O boundaries. */
async function createPeer() {
    const database = new PouchDB<EntryDoc>(`deletion-recovery-${++nextDatabase}`, { adapter: "memory" });
    databases.push(database);
    const files = new Map<FilePathWithPrefix, UXFileInfo>([[path, makeFile()]]);
    const records = new Map<FilePathWithPrefix, FileReflectionProvenanceRecord>();
    const settings = {
        ...DEFAULT_SETTINGS,
        useOnlyLocalChunk: true,
        writeDocumentsIfConflicted: true,
        deleteMetadataOfDeletedFiles: false,
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
            const results = await database.bulkDocs(chunks);
            return {
                result: results.every((result) => result.ok || result.status === 409),
                processed: { written: results.filter((result) => result.ok).length, cached: 0, duplicated: 0 },
            };
        },
        read: vi.fn(
            async (ids: string[]) =>
                await Promise.all(
                    ids.map(async (id) => {
                        try {
                            return await database.get(id);
                        } catch (error) {
                            if ((error as { status?: number }).status === 404) return false;
                            throw error;
                        }
                    })
                )
        ),
    };
    const entries = new EntryManager({
        database,
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
    const storage = {
        normalisePath: (value: string) => value,
        getStub: vi.fn(async (target: FilePathWithPrefix) => {
            const file = files.get(target);
            return file ? { name: file.name, path: file.path, stat: { ...file.stat } } : null;
        }),
        getFileStub: async (target: FilePathWithPrefix) => {
            const file = files.get(target);
            return file ? { name: file.name, path: file.path, stat: { ...file.stat } } : null;
        },
        readStubContent: vi.fn(async (file: UXFileInfoStub) => files.get(file.path as FilePathWithPrefix) ?? false),
        deleteVaultItem: vi.fn(async (target: FilePathWithPrefix) => {
            files.delete(target);
        }),
    };
    const provenance = {
        get: vi.fn(async (target: FilePathWithPrefix) => records.get(target)),
        set: vi.fn(async (target: FilePathWithPrefix, record: FileReflectionProvenanceRecord) => {
            records.set(target, record);
        }),
        delete: vi.fn(async (target: FilePathWithPrefix) => {
            records.delete(target);
        }),
        listPaths: vi.fn(async () => [...records.keys()]),
    };
    const vault = { isTargetFile: vi.fn(async () => true), isFileSizeTooLarge: vi.fn(() => false) };
    const services = {
        API: { addLog: vi.fn() },
        path: pathService,
        setting,
        events: createLiveSyncEventHub(),
        database: {
            localDatabase: {
                getDBEntry: entries.getDBEntry.bind(entries),
                getDBEntryMeta: entries.getDBEntryMeta.bind(entries),
                getDBEntryFromMeta: entries.getDBEntryFromMeta.bind(entries),
                putDBEntry: entries.putDBEntry.bind(entries),
                putDBEntryAsIndependentRoot: entries.putDBEntryAsIndependentRoot.bind(entries),
                deleteDBEntry: entries.deleteDBEntry.bind(entries),
                getRaw: database.get.bind(database),
            },
        },
        storageAccess: storage,
        vault,
        conflict: { queueCheckFor: vi.fn(), queueCheckForIfOpen: vi.fn() },
        fileReflectionProvenance: provenance,
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
    } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
    const access = new ServiceDatabaseFileAccessBase(services);
    services.databaseFileAccess = access;
    const handler = new TestHandler(services);
    expect(await handler.storeFileToDB(files.get(path)!)).toBe(true);
    const base = await database.get(path);
    await database.put({ ...base, deleted: true, mtime: initialTime + 10_000 });
    const expected = (await access.fetchEntryMeta(path, undefined, true)) as MetaEntry;
    const before = await database.info();
    storage.readStubContent.mockClear();
    provenance.set.mockClear();
    chunkManager.read.mockClear();
    return {
        database,
        files,
        records,
        provenance,
        storage,
        handler,
        access,
        expected,
        base,
        settings,
        vault,
        chunkManager,
        before,
        services,
    };
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

async function assertHistoryUnchanged(peer: Awaited<ReturnType<typeof createPeer>>) {
    expect((await peer.database.info()).update_seq).toBe(peer.before.update_seq);
    expect((await peer.database.get(path))._rev).toBe(peer.expected._rev);
    expect(await peer.access.getConflictedRevs(path)).toEqual([]);
    expect(peer.provenance.set).not.toHaveBeenCalled();
}

describe("guarded database deletion recovery", () => {
    it("matches a canonical lookup with enumerated Metadata retaining its stored path spelling", async () => {
        const peer = await createPeer();
        const storedPath = "folder\\note.md" as FilePathWithPrefix;
        const current = await peer.database.get(path);
        await peer.database.put({ ...current, path: storedPath });
        peer.expected = (await peer.database.get(path)) as MetaEntry;
        peer.before = await peer.database.info();
        Object.assign(peer.services.path, {
            getPath: (entry: { path: FilePathWithPrefix }) =>
                entry.path.split(String.fromCharCode(92)).join("/") as FilePathWithPrefix,
        });
        expect(peer.services.path.getPath(peer.expected)).toBe(path);
        const lookedUp = (await peer.access.fetchEntryMeta(path, undefined, true)) as MetaEntry;
        expect(lookedUp._rev).toBe(peer.expected._rev);
        expect(lookedUp.mtime).toBe(peer.expected.mtime);
        expect(lookedUp.size).toBe(peer.expected.size);
        expect(lookedUp.path).toBe(path);
        expect(peer.expected.path).toBe(storedPath);
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(path);
        await assertHistoryUnchanged(peer);
    });

    it.each([1_999, 2_000])(
        "uses freshness buckets separately from revision identity for offset %s",
        async (offset) => {
            const peer = await createPeer();
            const current = await peer.database.get(path);
            await peer.database.put({ ...current, mtime: initialTime + offset });
            peer.expected = (await peer.access.fetchEntryMeta(path, undefined, true)) as MetaEntry;
            peer.before = await peer.database.info();
            const result = await peer.handler.recoverDatabaseDeletion(peer.expected);
            if (offset < 2_000) {
                expect(result).toMatchObject({ status: "deferred", file: "present", reason: "file-not-eligible" });
                expect(peer.files.get(path)?.body).toBeDefined();
                expect(await peer.files.get(path)!.body.text()).toBe(original);
                expect(peer.storage.readStubContent).not.toHaveBeenCalled();
                expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
            } else {
                expect(result).toMatchObject({ status: "applied", file: "absent", provenance: "cleared" });
                expect(peer.storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(path);
            }
            await assertHistoryUnchanged(peer);
        }
    );

    it("retains confirmed effects if permit release fails and never deletes twice", async () => {
        const peer = await createPeer();
        const failure = new Error("permit release failed");
        const { withSemaphore } = await vi.importActual<typeof semaphoreScope>(
            "octagonal-wheels/concurrency/semaphore"
        );
        const injected = vi.mocked(semaphoreScope.withSemaphore).mockImplementationOnce((semaphore, operation) =>
            withSemaphore(
                {
                    acquire: async () => {
                        const release = await semaphore.acquire();
                        return () => {
                            release();
                            throw failure;
                        };
                    },
                },
                operation
            )
        );
        try {
            expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
                status: "failed",
                file: "absent",
                provenance: "cleared",
                error: failure,
            });
        } finally {
            injected.mockRestore();
        }
        expect(peer.files.has(path)).toBe(false);
        expect(peer.records.has(path)).toBe(false);
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.storage.deleteVaultItem).toHaveBeenCalledTimes(1);
        await assertHistoryUnchanged(peer);
    });

    it("keeps hash-backed deletion independent of a pruned base", async () => {
        const peer = await createPeer();
        await peer.database.compact();
        peer.before = await peer.database.info();
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "applied",
            file: "absent",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        expect(peer.chunkManager.read).not.toHaveBeenCalled();
        expect(peer.provenance.listPaths).not.toHaveBeenCalled();
        expect(peer.handler.supportsDeletionRecovery()).toBe(true);
        await assertHistoryUnchanged(peer);
    });

    it("rejects a differing legacy base after one body read without creating a branch", async () => {
        const peer = await createPeer();
        peer.records.set(path, { revision: peer.base._rev });
        peer.files.set(path, makeFile("Original edit\n"));
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "base-content-mismatch",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(1);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });

    it.each(["invalid-provenance", "equal-time", "storage-newer", "excluded", "oversized"])(
        "defers %s before any file-body read",
        async (mode) => {
            const peer = await createPeer();
            if (mode === "invalid-provenance") peer.records.set(path, { revision: "" });
            if (mode === "equal-time") peer.files.set(path, makeFile(original, path, peer.expected.mtime));
            if (mode === "storage-newer") peer.files.set(path, makeFile(original, path, peer.expected.mtime + 10_000));
            if (mode === "excluded") peer.vault.isTargetFile.mockResolvedValue(false);
            if (mode === "oversized") peer.vault.isFileSizeTooLarge.mockReturnValue(true);
            expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
                status: "deferred",
                provenance: "unchanged",
            });
            expect(peer.storage.readStubContent).not.toHaveBeenCalled();
            expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(peer.provenance.delete).not.toHaveBeenCalled();
            expect((await peer.database.info()).update_seq).toBe(peer.before.update_seq);
        }
    );

    it.each(["not-deleted", "wrong-id"])("rejects an expected deletion with %s identity before I/O", async (mode) => {
        const peer = await createPeer();
        const record = peer.records.get(path);
        const malformed =
            mode === "not-deleted"
                ? { ...peer.expected, deleted: false }
                : { ...peer.expected, _id: "other.md" as typeof peer.expected._id };
        expect(await peer.handler.recoverDatabaseDeletion(malformed)).toMatchObject({
            status: "deferred",
            reason: "invalid-deletion",
            provenance: "unchanged",
        });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(peer.records.get(path)).toEqual(record);
        await assertHistoryUnchanged(peer);
    });

    it.each(["folder", "internal", "wrong-path"])(
        "defers a current %s storage identity without mutation",
        async (mode) => {
            const peer = await createPeer();
            const record = peer.records.get(path);
            const otherPath = "folder/renamed.md" as FilePathWithPrefix;
            if (mode === "folder") {
                peer.storage.getStub.mockImplementationOnce(async (target) => {
                    const file = peer.files.get(target);
                    if (!file) return null;
                    const folder = {
                        name: file.name,
                        path: file.path,
                        stat: { ...file.stat },
                        isFolder: true,
                        children: [],
                        parent: undefined,
                    };
                    return folder;
                });
            } else if (mode === "internal") {
                peer.storage.getStub.mockImplementationOnce(async (target) => {
                    const file = peer.files.get(target);
                    if (!file) return null;
                    const internal = {
                        name: file.name,
                        path: file.path,
                        stat: { ...file.stat },
                        isInternal: true,
                    };
                    return internal;
                });
            } else {
                peer.files.set(path, makeFile(original, otherPath));
            }
            const content = await peer.files.get(path)!.body.text();
            expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
                status: "deferred",
                reason: "storage-identity-changed",
                file: "present",
                provenance: "unchanged",
            });
            expect(peer.storage.readStubContent).not.toHaveBeenCalled();
            expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(peer.provenance.delete).not.toHaveBeenCalled();
            expect(await peer.files.get(path)!.body.text()).toBe(content);
            expect(peer.records.get(path)).toEqual(record);
            await assertHistoryUnchanged(peer);
        }
    );

    it("does not read or delete a present file in cleanup-only mode", async () => {
        const peer = await createPeer();
        peer.provenance.get.mockClear();
        const replacement = makeFile("Replacement local work\n");
        const record = peer.records.get(path);
        peer.files.set(path, replacement);
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "deferred",
            reason: "file-present",
            file: "present",
            provenance: "unchanged",
        });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.get).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(await peer.files.get(path)!.body.text()).toBe("Replacement local work\n");
        expect(peer.records.get(path)).toEqual(record);
        await assertHistoryUnchanged(peer);
    });

    it("defers absent-file cleanup when a file is recreated without changing provenance", async () => {
        const peer = await createPeer();
        const record = peer.records.get(path);
        const getStub = peer.storage.getStub.getMockImplementation()!;
        peer.files.clear();
        peer.storage.getStub.mockImplementationOnce(getStub).mockImplementationOnce(async (target) => {
            peer.files.set(path, makeFile("Recreated local work\n"));
            return await getStub(target);
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "deferred",
            reason: "file-recreated",
            file: "present",
            provenance: "unchanged",
        });
        expect(peer.storage.getStub).toHaveBeenCalledTimes(2);
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(await peer.files.get(path)!.body.text()).toBe("Recreated local work\n");
        expect(peer.records.get(path)).toEqual(record);
        await assertHistoryUnchanged(peer);
    });

    it.each(["stat", "path"])("preserves a file whose first body read reports changed %s", async (mode) => {
        const peer = await createPeer();
        const record = peer.records.get(path);
        const otherPath = "folder/renamed.md" as FilePathWithPrefix;
        const read = peer.storage.readStubContent.getMockImplementation()!;
        peer.storage.readStubContent.mockImplementationOnce(async (stub) => {
            peer.files.set(
                path,
                makeFile(original, mode === "path" ? otherPath : path, mode === "stat" ? initialTime + 1 : initialTime)
            );
            return await read(stub);
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "storage-changed",
            file: "present",
            provenance: "unchanged",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(1);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(await peer.files.get(path)!.body.text()).toBe(original);
        expect(peer.files.get(path)!.path).toBe(mode === "path" ? otherPath : path);
        expect(peer.records.get(path)).toEqual(record);
        await assertHistoryUnchanged(peer);
    });

    it("retains evidence when storage disappears after the first read, then permits cleanup-only retry", async () => {
        const peer = await createPeer();
        const record = peer.records.get(path);
        const getStub = peer.storage.getStub.getMockImplementation()!;
        peer.storage.getStub.mockImplementationOnce(getStub).mockImplementationOnce(async (target) => {
            peer.files.delete(target);
            return null;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "storage-changed",
            file: "absent",
            provenance: "unchanged",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(1);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.records.get(path)).toEqual(record);

        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(1);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).toHaveBeenCalledExactlyOnceWith(path);
        expect(peer.records.has(path)).toBe(false);
        await assertHistoryUnchanged(peer);
    });

    it("detects changed provenance and final raw statistics without a third body read", async () => {
        const peer = await createPeer();
        const read = peer.storage.readStubContent.getMockImplementation()!;
        peer.storage.readStubContent.mockImplementationOnce(read).mockImplementationOnce(async (stub) => {
            const file = await read(stub);
            peer.records.set(path, { ...peer.records.get(path)!, observedStorageMtime: initialTime + 1 });
            return file;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "provenance-changed",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        peer.records.set(path, { ...peer.records.get(path)!, observedStorageMtime: initialTime });
        peer.storage.readStubContent.mockClear();
        peer.vault.isTargetFile.mockImplementation(async () => {
            if (peer.storage.readStubContent.mock.calls.length === 2) {
                peer.files.set(path, makeFile(original, path, initialTime + 1));
            }
            return true;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "storage-changed",
        });
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });

    it("reports pending cleanup when strict provenance reading fails for an absent file", async () => {
        const peer = await createPeer();
        peer.files.clear();
        peer.provenance.get.mockRejectedValueOnce(new Error("provenance unavailable"));
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "failed",
            file: "absent",
            provenance: "pending",
            phase: "provenance-read",
        });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
    });

    it.each(["restoration", "conflict", "new-provenance"])(
        "retains provenance when %s appears after physical removal",
        async (mode) => {
            const peer = await createPeer();
            peer.storage.deleteVaultItem.mockImplementationOnce(async (target) => {
                peer.files.delete(target);
                if (mode === "restoration")
                    await peer.database.put({ ...(await peer.database.get(path)), deleted: false });
                if (mode === "conflict")
                    await peer.database.bulkDocs([{ ...peer.base, _rev: "1-ffffffffffffffffffffffffffffffff" }], {
                        new_edits: false,
                    });
                if (mode === "new-provenance") peer.records.set(path, { revision: "3-new-work" });
            });
            expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
                status: "deferred",
                file: "absent",
                provenance: "pending",
            });
            expect(peer.storage.deleteVaultItem).toHaveBeenCalledTimes(1);
            expect(peer.provenance.delete).not.toHaveBeenCalled();
            expect(peer.records.has(path)).toBe(true);
        }
    );

    it("preserves a replacement created by the storage deletion boundary", async () => {
        const peer = await createPeer();
        peer.storage.deleteVaultItem.mockImplementationOnce(async (target) => {
            peer.files.set(target, makeFile("Replacement edit\n"));
            peer.records.set(target, { revision: "3-new-work" });
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "failed",
            file: "present",
            provenance: "unchanged",
        });
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(await peer.files.get(path)?.body.text()).toBe("Replacement edit\n");
        expect(peer.records.get(path)?.revision).toBe("3-new-work");
    });

    it("removes unchanged bytes with two reads and no Metadata or Chunk writes despite the overwrite setting", async () => {
        const peer = await createPeer();
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.files.has(path)).toBe(false);
        expect(peer.records.has(path)).toBe(false);
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        expect(peer.chunkManager.read).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).toHaveBeenCalledExactlyOnceWith(path);
        await assertHistoryUnchanged(peer);
    });

    it.each(["missing", "size", "hash"])(
        "defers %s evidence without preservation writes or historical searches",
        async (mode) => {
            const peer = await createPeer();
            const record = peer.records.get(path)!;
            if (mode === "missing") peer.records.clear();
            if (mode === "size") peer.records.set(path, { ...record, contentSize: record.contentSize! + 1 });
            if (mode === "hash") peer.files.set(path, makeFile("Original edit\n"));
            const snapshot = peer.records.get(path);
            const history = vi.spyOn(peer.access, "findContentRevisions");
            const live = vi.spyOn(peer.access, "findLiveContentRevisions");
            expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
                status: "deferred",
                file: "present",
                provenance: "unchanged",
            });
            expect(peer.storage.readStubContent).toHaveBeenCalledTimes(mode === "hash" ? 1 : 0);
            expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
            expect(peer.provenance.delete).not.toHaveBeenCalled();
            expect(peer.records.get(path)).toEqual(snapshot);
            expect(peer.chunkManager.read).not.toHaveBeenCalled();
            expect(history).not.toHaveBeenCalled();
            expect(live).not.toHaveBeenCalled();
            await assertHistoryUnchanged(peer);
        }
    );

    it("uses only the exact legacy base with the normal delivery policy", async () => {
        const peer = await createPeer();
        peer.records.set(path, { revision: peer.base._rev });
        const fetch = vi.spyOn(peer.access, "fetchEntry");
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(path, peer.base._rev, true, true, false);
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        await assertHistoryUnchanged(peer);
    });

    it.each(["revision", "path", "deleted"])("defers an unusable exact legacy base with a wrong %s", async (mode) => {
        const peer = await createPeer();
        peer.records.set(path, { revision: peer.base._rev });
        const exactBase = await peer.access.fetchEntry(path, peer.base._rev, true, true, false);
        if (exactBase === false) throw new Error("expected exact legacy base to be readable in the fixture");
        const unusable = {
            ...exactBase,
            ...(mode === "revision" ? { _rev: "1-wrong-revision" } : {}),
            ...(mode === "path" ? { path: "folder/other.md" as FilePathWithPrefix } : {}),
            ...(mode === "deleted" ? { deleted: true } : {}),
        };
        const fetch = vi.spyOn(peer.access, "fetchEntry").mockResolvedValueOnce(unusable);
        const record = peer.records.get(path);
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            reason: "base-not-usable",
            file: "present",
            provenance: "unchanged",
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(path, peer.base._rev, true, true, false);
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(peer.records.get(path)).toEqual(record);
        await assertHistoryUnchanged(peer);
    });

    it("does not read current bytes or mutate legacy provenance when its exact base was pruned", async () => {
        const peer = await createPeer();
        peer.records.set(path, { revision: peer.base._rev });
        await peer.database.compact();
        peer.before = await peer.database.info();
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "failed",
            file: "present",
            provenance: "unchanged",
            reason: "base-unavailable",
        });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });

    it("preserves a same-stat edit made between the two body reads", async () => {
        const peer = await createPeer();
        const read = peer.storage.readStubContent.getMockImplementation()!;
        peer.storage.readStubContent.mockImplementationOnce(async (stub) => {
            const captured = await read(stub);
            peer.files.set(path, makeFile("Original edit\n"));
            return captured;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            file: "present",
        });
        expect(await peer.files.get(path)!.body.text()).toBe("Original edit\n");
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });

    it.each(["restoration", "conflict"])("defers a %s arriving while verification waits", async (mode) => {
        const peer = await createPeer();
        const read = peer.storage.readStubContent.getMockImplementation()!;
        peer.storage.readStubContent.mockImplementationOnce(async (stub) => {
            const captured = await read(stub);
            if (mode === "restoration") await peer.database.put({ ...(await peer.database.get(path)), deleted: false });
            else
                await peer.database.bulkDocs(
                    [{ ...peer.base, _rev: "1-ffffffffffffffffffffffffffffffff", deleted: false }],
                    {
                        new_edits: false,
                    }
                );
            return captured;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "deferred",
            file: "present",
        });
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        if (mode === "conflict") expect((await peer.database.get(path))._rev).toBe(peer.expected._rev);
    });

    it.each(["provenance", "body", "base"])("reports %s read errors as failures without deleting", async (phase) => {
        const peer = await createPeer();
        if (phase === "provenance") peer.provenance.get.mockRejectedValueOnce(new Error("provenance unavailable"));
        if (phase === "body") peer.storage.readStubContent.mockRejectedValueOnce(new Error("body unavailable"));
        if (phase === "base") {
            peer.records.set(path, { revision: peer.base._rev });
            vi.spyOn(peer.access, "fetchEntry").mockRejectedValueOnce(new Error("transport unavailable"));
        }
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "failed",
            provenance: "unchanged",
        });
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });

    it.each(["no-op", "throw", "unknown", "after-removal"])(
        "reports the fresh file effect after %s removal",
        async (mode) => {
            const peer = await createPeer();
            if (mode === "no-op") peer.storage.deleteVaultItem.mockImplementationOnce(async () => {});
            if (mode === "throw") peer.storage.deleteVaultItem.mockRejectedValueOnce(new Error("removal failed"));
            if (mode === "unknown")
                peer.storage.deleteVaultItem.mockImplementationOnce(async () => {
                    peer.storage.getStub.mockRejectedValueOnce(new Error("stat failed"));
                });
            if (mode === "after-removal")
                peer.storage.deleteVaultItem.mockImplementationOnce(async (target) => {
                    peer.files.delete(target);
                    throw new Error("parent removal failed");
                });
            const result = await peer.handler.recoverDatabaseDeletion(peer.expected);
            expect(result).toMatchObject({
                status: mode === "after-removal" ? "applied" : "failed",
                file: mode === "unknown" ? "unknown" : mode === "after-removal" ? "absent" : "present",
                provenance: mode === "unknown" ? "pending" : mode === "after-removal" ? "cleared" : "unchanged",
            });
            if (mode === "after-removal") expect(result.warning).toBeDefined();
            else expect(peer.provenance.delete).not.toHaveBeenCalled();
            await assertHistoryUnchanged(peer);
        }
    );

    it("retries only provenance cleanup after confirmed removal and a simulated restart", async () => {
        const peer = await createPeer();
        peer.provenance.delete.mockRejectedValueOnce(new Error("cleanup failed"));
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected)).toMatchObject({
            status: "failed",
            file: "absent",
            provenance: "pending",
        });
        expect(peer.records.has(path)).toBe(true);
        const restarted = new TestHandler(peer.services);
        expect(await restarted.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.records.has(path)).toBe(false);
        expect(peer.storage.deleteVaultItem).toHaveBeenCalledTimes(1);
        expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
        await assertHistoryUnchanged(peer);
    });

    it("preserves a recreated file and new provenance during absent-file cleanup", async () => {
        const peer = await createPeer();
        peer.files.clear();
        const get = peer.provenance.get.getMockImplementation()!;
        peer.provenance.get.mockImplementationOnce(async (target) => {
            const observed = await get(target);
            peer.files.set(path, makeFile("Recreated local work\n"));
            peer.records.set(path, { revision: "3-new-work" });
            return observed;
        });
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({ status: "deferred" });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        expect(peer.provenance.delete).not.toHaveBeenCalled();
        expect(peer.records.get(path)?.revision).toBe("3-new-work");
    });

    it("clears already absent bookkeeping without file reads or another deletion", async () => {
        const peer = await createPeer();
        peer.files.clear();
        expect(await peer.handler.recoverDatabaseDeletion(peer.expected, true)).toMatchObject({
            status: "applied",
            file: "absent",
            provenance: "cleared",
        });
        expect(peer.storage.readStubContent).not.toHaveBeenCalled();
        expect(peer.storage.deleteVaultItem).not.toHaveBeenCalled();
        await assertHistoryUnchanged(peer);
    });
});

describe("recovery admission", () => {
    it("acquires permits before waiting for document locks and serialises repeated document attempts", async () => {
        const fixture = createFileHandlerFixture();
        const shared = Object.assign(fixture.provenance, { listPaths: async () => [] });
        const ctx = { ...fixture.ctx, provenance: shared };
        const lockedPath = "locked.md" as FilePathWithPrefix;
        const otherPath = "other.md" as FilePathWithPrefix;
        for (const target of [lockedPath, otherPath]) fixture.files.set(target, makeContextFile(target));
        fixture.path.compareFileFreshness.mockImplementation(() => compareMTime(1_000, 10_000));
        fixture.db.fetchEntryMeta.mockImplementation(async (target) =>
            makeMetaEntry(target as FilePathWithPrefix, "2-deleted", { deleted: true, mtime: 10_000 })
        );
        let unlock!: () => void;
        let markLocked!: () => void;
        const started = new Promise<void>((resolve) => {
            markLocked = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const held = withFileEventPaths(ctx, [lockedPath], async () => {
            markLocked();
            await gate;
        });
        await started;
        const attempts = [lockedPath, lockedPath, lockedPath, otherPath].map((target) =>
            recoverDatabaseDeletion(ctx, makeMetaEntry(target, "2-deleted", { deleted: true, mtime: 10_000 }))
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fixture.db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(fixture.provenance.get).not.toHaveBeenCalled();
        unlock();
        await held;
        await expect(Promise.all(attempts)).resolves.toHaveLength(4);
        expect(fixture.provenance.get).toHaveBeenCalledTimes(4);
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
    });

    it("shares three permits between handlers and replenishes work while one operation is blocked", async () => {
        const fixture = createFileHandlerFixture();
        const sharedProvenance = Object.assign(fixture.provenance, { listPaths: async () => [] });
        const contexts = [
            fixture.ctx,
            { ...fixture.ctx, state: { contentHashes: new WeakMap(), deferredConflictChecks: new Map() } },
        ];
        const release: (() => void)[] = [];
        const started: string[] = [];
        const completed: string[] = [];
        let active = 0;
        let peak = 0;
        fixture.db.fetchEntryMeta.mockImplementation(async (target) =>
            makeMetaEntry(target as FilePathWithPrefix, "2-deleted", { deleted: true, mtime: 10_000 })
        );
        fixture.path.compareFileFreshness.mockImplementation((_file, _entry) => compareMTime(1_000, 10_000));
        fixture.provenance.get.mockImplementation(async (target) => {
            if (!started.includes(target)) {
                started.push(target);
                peak = Math.max(peak, ++active);
                await new Promise<void>((resolve) => {
                    release.push(resolve);
                });
                active--;
                completed.push(target);
            }
            return undefined;
        });
        for (let index = 0; index < 6; index++)
            fixture.files.set(
                `note-${index}.md` as FilePathWithPrefix,
                makeContextFile(`note-${index}.md` as FilePathWithPrefix)
            );
        const work = Array.from({ length: 6 }, (_, index) =>
            recoverDatabaseDeletion(
                { ...contexts[index % 2], provenance: sharedProvenance },
                makeMetaEntry(`note-${index}.md` as FilePathWithPrefix, "2-deleted", { deleted: true, mtime: 10_000 })
            )
        );
        await vi.waitFor(() => expect(started).toHaveLength(3));
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
        release[1]();
        await vi.waitFor(() => expect(started).toHaveLength(4));
        release[2]();
        await vi.waitFor(() => expect(started).toHaveLength(5));
        release[3]();
        await vi.waitFor(() => expect(started).toHaveLength(6));
        expect(completed).not.toContain("note-0.md");
        release[4]();
        release[5]();
        release[0]();
        await expect(Promise.all(work)).resolves.toHaveLength(6);
        expect(peak).toBe(3);
        fixture.provenance.get.mockRejectedValueOnce(new Error("failure releases permit"));
        await expect(
            recoverDatabaseDeletion(
                { ...fixture.ctx, provenance: sharedProvenance },
                makeMetaEntry("note-0.md" as FilePathWithPrefix, "2-deleted", { deleted: true, mtime: 10_000 })
            )
        ).resolves.toMatchObject({ status: "failed" });
        await expect(
            recoverDatabaseDeletion(
                { ...fixture.ctx, provenance: sharedProvenance },
                makeMetaEntry("note-0.md" as FilePathWithPrefix, "2-deleted", { deleted: true, mtime: 10_000 })
            )
        ).resolves.toMatchObject({ status: "deferred" });
    });

    it("defers compatibility hosts without the keys capability before I/O", async () => {
        const { ctx, db, storage, provenance } = createFileHandlerFixture();
        expect(await recoverDatabaseDeletion(ctx, makeMetaEntry(path, "2-deleted", { deleted: true }))).toMatchObject({
            status: "deferred",
            reason: "capability-unavailable",
        });
        expect(db.fetchEntryMeta).not.toHaveBeenCalled();
        expect(storage.getStub).not.toHaveBeenCalled();
        expect(provenance.get).not.toHaveBeenCalled();
    });
});

describe("ordinary scanner with the real deletion handler and revision tree", () => {
    it.each([false, true])(
        "recovers the dropped deletion and restart bookkeeping with cleanupFailure=%s",
        async (cleanupFailure) => {
            const peer = await createPeer();
            const persisted = new Map<string, unknown>([["fileStatusMap", { [path]: initialTime }]]);
            const set = vi.fn(async (key: string, value: unknown) => {
                persisted.set(key, value);
            });
            const createHost = (handler: ServiceFileHandlerBase) =>
                ({
                    services: {
                        ...peer.services,
                        context: createServiceContext(),
                        keyValueDB: { kvDB: { get: async (key: string) => persisted.get(key), set } },
                        vault: { ...peer.vault, isValidPath: () => true },
                        database: {
                            localDatabase: {
                                findAllNormalDocs: async function* () {
                                    const docs = await peer.database.allDocs({ include_docs: true, conflicts: true });
                                    for (const row of docs.rows) if (row.doc && "path" in row.doc) yield row.doc;
                                },
                            },
                        },
                    },
                    serviceModules: {
                        fileHandler: handler,
                        storageAccess: {
                            getFiles: async () =>
                                [...peer.files.values()].map(({ name, path, stat }) => ({
                                    name,
                                    path,
                                    stat: { ...stat },
                                })),
                        },
                    },
                }) as unknown as Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[0];
            const run = async (handler: ServiceFileHandlerBase) =>
                await synchroniseAllFilesBetweenDBandStorage(
                    createHost(handler),
                    vi.fn(),
                    {} as Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[2],
                    { mode: FullScanModes.NEWER_WINS }
                );
            if (cleanupFailure) peer.provenance.delete.mockRejectedValueOnce(new Error("interrupted cleanup"));
            expect(await run(peer.handler)).toBe(!cleanupFailure);
            expect(peer.files.has(path)).toBe(false);
            expect(peer.records.has(path)).toBe(cleanupFailure);
            expect(persisted.get("fileStatusMap")).toEqual({});
            expect(set).toHaveBeenCalledTimes(1);
            expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
            expect(peer.storage.deleteVaultItem).toHaveBeenCalledTimes(1);
            await assertHistoryUnchanged(peer);
            const restarted = new TestHandler(peer.services);
            expect(await run(restarted)).toBe(true);
            expect(peer.records.has(path)).toBe(false);
            expect(persisted.get("fileStatusMap")).toEqual({});
            expect(peer.provenance.listPaths).toHaveBeenCalledTimes(1);
            expect(peer.storage.readStubContent).toHaveBeenCalledTimes(2);
            expect(peer.storage.deleteVaultItem).toHaveBeenCalledTimes(1);
            expect(set).toHaveBeenCalledTimes(2);
            await assertHistoryUnchanged(peer);
        }
    );
});
