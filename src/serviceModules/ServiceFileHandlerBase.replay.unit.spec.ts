import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import {
    DEFAULT_SETTINGS,
    type EntryDoc,
    type FileEventItem,
    type FilePathWithPrefix,
    type UXFileInfo,
    type UXFileInfoStub,
    type UXFolderInfo,
} from "@lib/common/types";
import { compareMTime, createTextBlob, isDocContentSame, readContent } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import { LiveSyncLocalDB, type LiveSyncLocalDBEnv } from "@lib/pouchdb/LiveSyncLocalDB";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "@lib/serviceModules/ServiceDatabaseFileAccessBase";
import {
    ServiceFileHandlerBase,
    type ServiceFileHandlerDependencies,
} from "@lib/serviceModules/ServiceFileHandlerBase";

import { StorageEventManagerBase, type FileEventItemSentinel } from "@lib/managers/StorageEventManager";
import type { IStorageEventManagerAdapter } from "@lib/managers/adapters";
import type { StorageEventManagerBaseDependencies } from "@lib/managers/StorageEventManager";

PouchDB.plugin(MemoryAdapter);

const sourcePath = "Folder/Old.md" as FilePathWithPrefix;
const targetPath = "Folder/New.md" as FilePathWithPrefix;
let nextDatabase = 0;
const disposers: Array<() => Promise<void>> = [];

class TestFileHandler extends ServiceFileHandlerBase {}

type ProcessFileEvent = (item: FileEventItem) => Promise<boolean>;

function makeFile(path: FilePathWithPrefix, body: string, mtime = 1_000): UXFileInfo {
    return {
        name: path.split("/").pop() ?? path,
        path,
        stat: { type: "file", ctime: 1_000, mtime, size: new Blob([body]).size },
        body: createTextBlob(body),
    } as UXFileInfo;
}

function makeStub(file: UXFileInfo): UXFileInfoStub {
    const { body: _body, ...stub } = file;
    return stub as UXFileInfoStub;
}

function makeRestoredRename(file: UXFileInfo, oldPath: FilePathWithPrefix): FileEventItem {
    return {
        type: "RENAME",
        key: "rename:" + oldPath + "->" + file.path,
        args: { file: makeStub(file), oldPath },
        restoredFromPreviousRuntime: true,
    };
}

function makeDeleteEvent(file: UXFileInfo, restored: boolean): FileEventItem {
    return {
        type: "DELETE",
        key: "delete:" + file.path,
        args: { file: makeStub(file) },
        ...(restored ? { restoredFromPreviousRuntime: true } : {}),
    };
}

async function createFixture() {
    const name = "rename-replay-" + (++nextDatabase);
    const db = new PouchDB<EntryDoc>(name, { adapter: "memory", revs_limit: 1_000, auto_compaction: false });
    const provenance = new Map<FilePathWithPrefix, FileReflectionProvenanceRecord>();
    const storage = new Map<FilePathWithPrefix, UXFileInfo>();
    const settings = { ...DEFAULT_SETTINGS, isConfigured: true, batchSave: false, useOnlyLocalChunk: true, writeDocumentsIfConflicted: false };
    const setting = { currentSettings: () => settings };
    const pathService = {
        path2id: async (path: string) => path.toLowerCase(),
        id2path: (id: string, entry?: { path?: string }) => entry?.path ?? id,
        getPath: (entry: { path: FilePathWithPrefix }) => entry.path,
        compareFileFreshness: (file: UXFileInfo, entry: { mtime: number }) =>
            compareMTime(file.stat.mtime, entry.mtime),
        markChangesAreSame: vi.fn(),
    };
    const events = createLiveSyncEventHub();
    const API = { addLog: vi.fn() };
    const localDatabase = new LiveSyncLocalDB(name, {
        services: {
            API,
            setting,
            path: pathService,
            context: { events },
            database: { createPouchDBInstance: () => db },
            databaseEvents: {
                onDatabaseInitialisation: async () => true,
                onDatabaseHasReady: async () => true,
                onCloseDatabase: async () => true,
                onUnloadDatabase: async () => true,
            },
            replicator: { onCloseActiveReplication: async () => true },
        },
    } as unknown as LiveSyncLocalDBEnv);

    try {
        expect(await localDatabase.initializeDatabase()).toBe(true);
        const storageAccess = {
            normalisePath: (path: string) => path,
            getStub: async (path: string) => {
                const file = storage.get(path as FilePathWithPrefix);
                return file ? makeStub(file) : null;
            },
            getFileStub: async (path: string) => {
                const file = storage.get(path as FilePathWithPrefix);
                return file ? makeStub(file) : null;
            },
            readStubContent: vi.fn(async (file: UXFileInfoStub) => {
                const current = storage.get(file.path);
                if (!current) throw new Error("Storage file is absent: " + file.path);
                return current;
            }),
            ensureDir: async () => true,
            writeFileAuto: vi.fn(async (path: string, body: string, times: { mtime: number }) => {
                storage.set(path as FilePathWithPrefix, makeFile(path as FilePathWithPrefix, body, times.mtime));
                return true;
            }),
            stat: async (path: string) => storage.get(path as FilePathWithPrefix)?.stat,
            touched: async () => {},
            triggerFileEvent: vi.fn(),
        };
        let processFileEvent: ProcessFileEvent | undefined;
        const services = {
            API,
            path: pathService,
            setting,
            context: { events },
            events,
            database: { localDatabase },
            vault: { isTargetFile: async () => true, isFileSizeTooLarge: () => false },
            storageAccess,
            conflict: { queueCheckFor: vi.fn(), queueCheckForIfOpen: vi.fn() },
            fileReflectionProvenance: {
                get: async (key: FilePathWithPrefix) => provenance.get(key),
                set: async (key: FilePathWithPrefix, value: FileReflectionProvenanceRecord) => {
                    provenance.set(key, value);
                },
                delete: async (key: FilePathWithPrefix) => {
                    provenance.delete(key);
                },
            },
            fileProcessing: {
                processFileEvent: {
                    addHandler: vi.fn((handler: ProcessFileEvent) => {
                        processFileEvent = handler;
                    }),
                },
            },
            replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
        const access = new ServiceDatabaseFileAccessBase(services);
        services.databaseFileAccess = access;
        const handler = new TestFileHandler(services);
        if (!processFileEvent) throw new Error("File event handler was not registered");

        let disposed = false;
        const dispose = async () => {
            if (disposed) return;
            disposed = true;
            localDatabase.offRemoteChunkFetchedHandler?.();
            await localDatabase.managers.teardownManagers();
            await db.destroy();
        };
        disposers.push(dispose);
        return { access, db, handler, processFileEvent, provenance, storage, storageAccess, services };
    } catch (error) {
        localDatabase.offRemoteChunkFetchedHandler?.();
        await localDatabase.managers.teardownManagers();
        await db.destroy();
        throw error;
    }
}

async function seedEntry(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    path: FilePathWithPrefix,
    body: string
): Promise<UXFileInfo> {
    const file = makeFile(path, body);
    const revision = await fixture.access.storeWithBaseRevision(file, undefined, true);
    if (revision === false) throw new Error("Could not seed " + path);
    fixture.provenance.set(path, { revision, observedStorageMtime: file.stat.mtime });
    return file;
}

async function requireMeta(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    path: FilePathWithPrefix
) {
    const meta = await fixture.access.fetchEntryMeta(path, undefined, true);
    if (!meta) throw new Error("Could not retrieve Metadata for " + path);
    return meta;
}

async function expectDatabaseBody(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    path: FilePathWithPrefix,
    body: string
) {
    const entry = await fixture.access.fetchEntry(path, undefined, true, true);
    if (!entry) throw new Error("Could not retrieve file content for " + path);
    await expect(isDocContentSame(readContent(entry), body)).resolves.toBe(true);
}

afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("ServiceFileHandlerBase restored operation replay with PouchDB", () => {
    it("accepts two replays of a completed cross-document rename without changing database state or storage", async () => {
        const fixture = await createFixture();
        const body = "Renamed file content\n";
        await seedEntry(fixture, sourcePath, body);

        const targetFile = makeFile(targetPath, body, 2_000);
        fixture.storage.set(targetPath, targetFile);
        await expect(fixture.handler.renameFileInDB(targetFile, sourcePath)).resolves.toBe(true);
        fixture.storage.delete(sourcePath);

        const destinationBefore = await requireMeta(fixture, targetPath);
        const provenanceBefore = fixture.provenance.get(targetPath);
        const event = makeRestoredRename(targetFile, sourcePath);

        await expect(fixture.processFileEvent(event)).resolves.toBe(true);
        await expect(fixture.processFileEvent(event)).resolves.toBe(true);

        const destinationAfter = await requireMeta(fixture, targetPath);
        expect(destinationAfter._rev).toBe(destinationBefore._rev);
        expect(destinationAfter.path).toBe(targetPath);
        expect(fixture.provenance.get(targetPath)).toEqual(provenanceBefore);
        const sourceAfter = await fixture.access.fetchEntryMeta(sourcePath, undefined, true);
        expect(
            sourceAfter === false || sourceAfter.deleted === true || sourceAfter._deleted === true
        ).toBe(true);
        const storedFile = fixture.storage.get(targetPath);
        expect(storedFile).toBeDefined();
        if (storedFile) await expect(storedFile.body.text()).resolves.toBe(body);
        await expectDatabaseBody(fixture, targetPath, body);
    });

    it("preserves a newer target edit when replaying a completed cross-document rename", async () => {
        const fixture = await createFixture();
        const originalBody = "Renamed file content\n";
        const newerBody = "A newer edit after the rename\n";
        await seedEntry(fixture, sourcePath, originalBody);

        const targetFile = makeFile(targetPath, originalBody, 2_000);
        fixture.storage.set(targetPath, targetFile);
        await expect(fixture.handler.renameFileInDB(targetFile, sourcePath)).resolves.toBe(true);
        fixture.storage.delete(sourcePath);

        const newerFile = makeFile(targetPath, newerBody, 3_000);
        fixture.storage.set(targetPath, newerFile);
        const event = makeRestoredRename(targetFile, sourcePath);

        await expect(fixture.processFileEvent(event)).resolves.toBe(true);
        const firstReplayMeta = await requireMeta(fixture, targetPath);
        await expectDatabaseBody(fixture, targetPath, newerBody);
        await expect(fixture.processFileEvent(event)).resolves.toBe(true);

        const destinationAfter = await requireMeta(fixture, targetPath);
        expect(destinationAfter._rev).toBe(firstReplayMeta._rev);
        expect(destinationAfter.path).toBe(targetPath);
        const sourceAfter = await fixture.access.fetchEntryMeta(sourcePath, undefined, true);
        expect(
            sourceAfter === false || sourceAfter.deleted === true || sourceAfter._deleted === true
        ).toBe(true);
        const storedFile = fixture.storage.get(targetPath);
        expect(storedFile).toBeDefined();
        if (storedFile) await expect(storedFile.body.text()).resolves.toBe(newerBody);
        await expectDatabaseBody(fixture, targetPath, newerBody);
    });

    it("does not add revisions when a completed case-only rename is replayed", async () => {
        const fixture = await createFixture();
        const oldPath = "Folder/Note.md" as FilePathWithPrefix;
        const newPath = "Folder/note.md" as FilePathWithPrefix;
        const body = "Case-only rename content\n";
        await seedEntry(fixture, oldPath, body);

        const targetFile = makeFile(newPath, body, 2_000);
        fixture.storage.set(newPath, targetFile);
        await expect(fixture.handler.renameFileInDB(targetFile, oldPath)).resolves.toBe(true);

        const destinationBefore = await requireMeta(fixture, newPath);
        const provenanceBefore = fixture.provenance.get(newPath);
        const event = makeRestoredRename(targetFile, oldPath);

        await expect(fixture.processFileEvent(event)).resolves.toBe(true);
        await expect(fixture.processFileEvent(event)).resolves.toBe(true);

        const destinationAfter = await requireMeta(fixture, newPath);
        expect(destinationAfter._rev).toBe(destinationBefore._rev);
        expect(destinationAfter.path).toBe(newPath);
        expect(fixture.provenance.get(newPath)).toEqual(provenanceBefore);
        const storedFile = fixture.storage.get(newPath);
        expect(storedFile).toBeDefined();
        if (storedFile) await expect(storedFile.body.text()).resolves.toBe(body);
        await expectDatabaseBody(fixture, newPath, body);
    });

    it("preserves an unrelated pre-existing destination when a restored rename collides with it", async () => {
        const fixture = await createFixture();
        const sourceBody = "Incoming renamed content\n";
        const unrelatedBody = "Pre-existing destination content\n";
        await seedEntry(fixture, sourcePath, sourceBody);
        await seedEntry(fixture, targetPath, unrelatedBody);

        const targetFile = makeFile(targetPath, sourceBody, 2_000);
        fixture.storage.set(targetPath, targetFile);
        const destinationBefore = await requireMeta(fixture, targetPath);
        const sourceBefore = await requireMeta(fixture, sourcePath);

        await expect(fixture.processFileEvent(makeRestoredRename(targetFile, sourcePath))).resolves.toBe(false);

        const destinationAfter = await requireMeta(fixture, targetPath);
        const sourceAfter = await requireMeta(fixture, sourcePath);
        expect(destinationAfter._rev).toBe(destinationBefore._rev);
        expect(sourceAfter._rev).toBe(sourceBefore._rev);
        await expectDatabaseBody(fixture, targetPath, unrelatedBody);
        await expectDatabaseBody(fixture, sourcePath, sourceBody);
        const storedFile = fixture.storage.get(targetPath);
        expect(storedFile).toBeDefined();
        if (storedFile) await expect(storedFile.body.text()).resolves.toBe(sourceBody);
    });

    it("accepts two replays of a completed ordinary delete without new revisions and preserves a newer storage file", async () => {
        const fixture = await createFixture();
        const deletedFile = await seedEntry(fixture, sourcePath, "Deleted file content\n");
        fixture.storage.set(sourcePath, deletedFile);
        fixture.storage.delete(sourcePath);

        const deleteEvent = makeDeleteEvent(deletedFile, false);
        await expect(fixture.processFileEvent(deleteEvent)).resolves.toBe(true);
        const updateSequenceAfterDelete = (await fixture.db.info()).update_seq;
        const restoredDeleteEvent = makeDeleteEvent(deletedFile, true);

        await expect(fixture.processFileEvent(restoredDeleteEvent)).resolves.toBe(true);
        await expect(fixture.processFileEvent(restoredDeleteEvent)).resolves.toBe(true);
        expect((await fixture.db.info()).update_seq).toBe(updateSequenceAfterDelete);
        const sourceAfterReplay = await fixture.access.fetchEntryMeta(sourcePath, undefined, true);
        expect(
            sourceAfterReplay === false ||
                sourceAfterReplay.deleted === true ||
                sourceAfterReplay._deleted === true
        ).toBe(true);

        const newerBody = "Newer file at the deleted path\n";
        const newerFile = makeFile(sourcePath, newerBody, 3_000);
        fixture.storage.set(sourcePath, newerFile);
        await expect(fixture.processFileEvent(restoredDeleteEvent)).resolves.toBe(true);
        expect((await fixture.db.info()).update_seq).toBe(updateSequenceAfterDelete);
        const storedFile = fixture.storage.get(sourcePath);
        expect(storedFile).toBeDefined();
        if (storedFile) await expect(storedFile.body.text()).resolves.toBe(newerBody);
    });
    it("completes an absent delete so a later same-path create can write, and accepts duplicate deletion", async () => {
        const fixture = await createFixture();
        const firstFile = makeFile(sourcePath, "Initial create body");
        expect(fixture.storage.has(sourcePath)).toBe(false);
        await expect(fixture.access.fetchEntryMeta(sourcePath, undefined, true)).resolves.toBe(false);

        const skippedCreateEvent: FileEventItem = {
            type: "CREATE",
            key: "create:" + sourcePath,
            args: { file: makeStub(firstFile) },
        };
        await expect(fixture.processFileEvent(skippedCreateEvent)).resolves.toBe(true);
        await expect(fixture.access.fetchEntryMeta(sourcePath, undefined, true)).resolves.toBe(false);

        await expect(fixture.processFileEvent(makeDeleteEvent(firstFile, false))).resolves.toBe(true);
        await expect(fixture.access.fetchEntryMeta(sourcePath, undefined, true)).resolves.toBe(false);

        const laterBody = "Later create body";
        const laterFile = makeFile(sourcePath, laterBody, 2_000);
        fixture.storage.set(sourcePath, laterFile);
        const laterCreateEvent: FileEventItem = {
            type: "CREATE",
            key: "create:" + sourcePath,
            args: { file: makeStub(laterFile) },
        };
        await expect(fixture.processFileEvent(laterCreateEvent)).resolves.toBe(true);
        await expectDatabaseBody(fixture, sourcePath, laterBody);

        fixture.storage.delete(sourcePath);
        const deleteEvent = makeDeleteEvent(laterFile, false);
        await expect(fixture.processFileEvent(deleteEvent)).resolves.toBe(true);
        const updateSequenceAfterDelete = (await fixture.db.info()).update_seq;

        await expect(fixture.processFileEvent(deleteEvent)).resolves.toBe(true);
        expect((await fixture.db.info()).update_seq).toBe(updateSequenceAfterDelete);
        // Logical deletion retains Metadata; the duplicate must retain that tombstone.
        await expect(fixture.access.fetchEntryMeta(sourcePath, undefined, true)).resolves.toMatchObject({
            path: sourcePath, deleted: true,
        });
    });

});

class RuntimeStorageEventManager extends StorageEventManagerBase<IStorageEventManagerAdapter<UXFileInfoStub, UXFolderInfo>> {}

function createRuntimeManager(fixture: Awaited<ReturnType<typeof createFixture>>) {
    let saved: (FileEventItem | FileEventItemSentinel)[] = [];
    const persistence = {
        saveSnapshot: vi.fn(async (snapshot: (FileEventItem | FileEventItemSentinel)[]) => {
            saved = JSON.parse(JSON.stringify(snapshot));
        }),
        loadSnapshot: async () => saved,
    };
    const adapter: IStorageEventManagerAdapter<UXFileInfoStub, UXFolderInfo> = {
        persistence,
        typeGuard: {
            isFile: (file): file is UXFileInfoStub => !!file && !(file as UXFolderInfo).isFolder,
            isFolder: (file): file is UXFolderInfo => !!file && (file as UXFolderInfo).isFolder === true,
        },
        converter: {
            toFileInfo: (file) => file,
            toInternalFileInfo: (path) => ({ path, name: path, isInternal: true, stat: undefined }),
        },
        watch: { beginWatch: async () => {} },
        status: { updateStatus: () => {} },
    };
    const process = vi.fn(fixture.processFileEvent);
    const dependencies = {
        setting: fixture.services.setting,
        vaultService: fixture.services.vault,
        fileProcessing: { processFileEvent: process, onStorageFileEvent: () => {} },
        storageAccessManager: fixture.storageAccess,
        APIService: fixture.services.API,
    } as unknown as StorageEventManagerBaseDependencies;
    return {
        manager: new RuntimeStorageEventManager(adapter, dependencies),
        restart: () => new RuntimeStorageEventManager(adapter, dependencies),
        persistence,
        process,
        snapshot: () => saved,
    };
}

function runtimeEvent(type: FileEventItem["type"], file: UXFileInfo, key = type + ":" + file.path): FileEventItem {
    return { type, key, args: { file: makeStub(file) }, skipBatchWait: true };
}

describe("StorageEventManager current-state retry with PouchDB", () => {
    it("recovers a vanished temporary read on the next flush and completes the final save and deletion", async () => {
        const fixture = await createFixture();
        const temporary = await seedEntry(fixture, "note.md.tmp.1331.hash" as FilePathWithPrefix, "previous temporary bytes");
        fixture.storage.set(temporary.path, temporary);
        const runtime = createRuntimeManager(fixture);
        fixture.storageAccess.readStubContent.mockImplementationOnce(async () => {
            fixture.storage.delete(temporary.path);
            throw Object.assign(new Error("temporary file vanished"), { code: "ENOENT" });
        });
        const original = runtime.manager.processFileEvent(runtimeEvent("CREATE", temporary));
        await expect(original).rejects.toThrow("temporary file vanished");
        expect(runtime.snapshot().some((item) => item.type === "CREATE")).toBe(true);

        const final = makeFile("note.md" as FilePathWithPrefix, "final saved content", 2_000);
        fixture.storage.set(final.path, final);
        runtime.manager.enqueue(runtimeEvent("CHANGED", final));
        runtime.manager.enqueue(runtimeEvent("DELETE", temporary));
        await expect(runtime.manager.waitForIdle()).resolves.toBeUndefined();
        await expectDatabaseBody(fixture, final.path, "final saved content");
        expect((await requireMeta(fixture, temporary.path)).deleted).toBe(true);
        expect(runtime.snapshot()).toEqual([]);
        await expect(original).rejects.toThrow("temporary file vanished");
    });

    it("recognises completed DB and provenance effects after completion-snapshot failure", async () => {
        const fixture = await createFixture();
        const file = makeFile(targetPath, "saved once");
        fixture.storage.set(file.path, file);
        const runtime = createRuntimeManager(fixture);
        const save = runtime.persistence.saveSnapshot.getMockImplementation()!;
        let rejectCompletion = true;
        runtime.persistence.saveSnapshot.mockImplementation(async (snapshot) => {
            if (rejectCompletion && snapshot.length === 0) throw new Error("completion snapshot unavailable");
            await save(snapshot);
        });
        await expect(runtime.manager.processFileEvent(runtimeEvent("CHANGED", file))).rejects.toThrow("completion snapshot unavailable");
        const sequence = (await fixture.db.info()).update_seq;
        expect(runtime.snapshot()).toHaveLength(1);
        rejectCompletion = false;
        await expect(runtime.manager.waitForIdle()).resolves.toBeUndefined();
        expect((await fixture.db.info()).update_seq).toBe(sequence);
        await expectDatabaseBody(fixture, targetPath, "saved once");
        expect(runtime.snapshot()).toEqual([]);
    });

    it("retains a partial rename when its existing target cannot be attributed to this operation", async () => {
        const fixture = await createFixture();
        const old = await seedEntry(fixture, sourcePath, "rename bytes");
        const moved = { ...old, path: targetPath, name: "New.md" };
        fixture.storage.set(targetPath, moved);
        const runtime = createRuntimeManager(fixture);
        const deletion = vi.spyOn(fixture.access, "delete").mockRejectedValueOnce(new Error("source deletion unavailable"));
        const rename = runtimeEvent("RENAME", moved);
        rename.args.oldPath = sourcePath;
        await expect(runtime.manager.processFileEvent(rename)).rejects.toThrow("source deletion unavailable");
        const target = await requireMeta(fixture, targetPath);
        const source = await requireMeta(fixture, sourcePath);
        await expect(runtime.manager.waitForIdle()).rejects.toThrow("Storage operation failed");
        expect((await requireMeta(fixture, targetPath))._rev).toBe(target._rev);
        expect((await requireMeta(fixture, sourcePath))._rev).toBe(source._rev);
        expect((await requireMeta(fixture, sourcePath)).deleted).not.toBe(true);
        await expectDatabaseBody(fixture, targetPath, "rename bytes");
        await expectDatabaseBody(fixture, sourcePath, "rename bytes");
        expect(deletion).toHaveBeenCalledOnce();
        expect(runtime.snapshot()).toEqual([rename]);
    });

    it("retries a completed rename after snapshot failure without adding any revisions", async () => {
        const fixture = await createFixture();
        const old = await seedEntry(fixture, sourcePath, "completed rename");
        const moved = { ...old, path: targetPath, name: "New.md" };
        fixture.storage.set(targetPath, moved);
        const runtime = createRuntimeManager(fixture);
        const save = runtime.persistence.saveSnapshot.getMockImplementation()!;
        let rejectCompletion = true;
        runtime.persistence.saveSnapshot.mockImplementation(async (snapshot) => {
            if (rejectCompletion && snapshot.length === 0) throw new Error("completion snapshot unavailable");
            await save(snapshot);
        });
        const rename = runtimeEvent("RENAME", moved);
        rename.args.oldPath = sourcePath;
        await expect(runtime.manager.processFileEvent(rename)).rejects.toThrow("completion snapshot unavailable");
        expect((await requireMeta(fixture, sourcePath)).deleted).toBe(true);
        const sequence = (await fixture.db.info()).update_seq;
        rejectCompletion = false;
        await expect(runtime.manager.waitForIdle()).resolves.toBeUndefined();
        expect((await fixture.db.info()).update_seq).toBe(sequence);
        await expectDatabaseBody(fixture, targetPath, "completed rename");
        expect(runtime.snapshot()).toEqual([]);
    });

    it("restores the original intent if the runtime stops during its retry", async () => {
        const fixture = await createFixture();
        const file = makeFile(targetPath, "restart during retry");
        fixture.storage.set(file.path, file);
        const runtime = createRuntimeManager(fixture);
        fixture.storageAccess.readStubContent.mockRejectedValueOnce(new Error("first read unavailable"));
        await expect(runtime.manager.processFileEvent(runtimeEvent("CHANGED", file))).rejects.toThrow("first read unavailable");
        let interrupt!: (error: Error) => void;
        fixture.storageAccess.readStubContent.mockImplementationOnce(async () =>
            await new Promise<UXFileInfo>((_resolve, reject) => { interrupt = reject; })
        );
        const retry = runtime.manager.waitForIdle();
        void retry.catch(() => {});
        await vi.waitFor(() => expect(interrupt).toBeTypeOf("function"));
        const saved = runtime.snapshot()[0] as FileEventItem;
        expect(Object.getOwnPropertySymbols(saved)).toEqual([]);
        expect(saved.restoredFromPreviousRuntime).toBeUndefined();
        interrupt(new Error("runtime interrupted"));
        await expect(retry).rejects.toThrow("runtime interrupted");
        const restarted = runtime.restart();
        await restarted.restoreState();
        await expect(restarted.waitForIdle()).resolves.toBeUndefined();
        const sequence = (await fixture.db.info()).update_seq;
        await restarted.restoreState();
        expect((await fixture.db.info()).update_seq).toBe(sequence);
        await expectDatabaseBody(fixture, targetPath, "restart during retry");
        expect(runtime.snapshot()).toEqual([]);
    });

    it("retains repeated permission failures after one attempt per request", async () => {
        const fixture = await createFixture();
        const file = makeFile(targetPath, "permission-protected bytes");
        fixture.storage.set(file.path, file);
        const runtime = createRuntimeManager(fixture);
        fixture.storageAccess.readStubContent.mockRejectedValue(
            Object.assign(new Error("permission denied"), { code: "EACCES" })
        );
        await expect(runtime.manager.processFileEvent(runtimeEvent("CHANGED", file))).rejects.toThrow("permission denied");
        await expect(runtime.manager.waitForIdle()).rejects.toThrow("permission denied");
        await expect(runtime.manager.waitForIdle()).rejects.toThrow("permission denied");
        expect(fixture.storageAccess.readStubContent).toHaveBeenCalledTimes(3);
        expect(await fixture.access.fetchEntryMeta(targetPath, undefined, true)).toBe(false);
        expect(runtime.snapshot()).toHaveLength(1);
        expect(fixture.storage.get(targetPath)).toBe(file);
    });

    it("protects a recreated path while retrying its deletion and saving its new bytes", async () => {
        const fixture = await createFixture();
        const old = await seedEntry(fixture, sourcePath, "old bytes");
        const runtime = createRuntimeManager(fixture);
        vi.spyOn(fixture.access, "delete").mockRejectedValueOnce(new Error("deletion unavailable"));
        await expect(runtime.manager.processFileEvent(runtimeEvent("DELETE", old))).rejects.toThrow("deletion unavailable");
        const recreated = makeFile(sourcePath, "new bytes", 2_000);
        fixture.storage.set(sourcePath, recreated);
        await expect(runtime.manager.processFileEvent(runtimeEvent("CREATE", recreated))).resolves.toBeUndefined();
        await expectDatabaseBody(fixture, sourcePath, "new bytes");
        expect(fixture.storage.get(sourcePath)).toBe(recreated);
        expect((await requireMeta(fixture, sourcePath)).deleted).not.toBe(true);
        expect(runtime.snapshot()).toEqual([]);
    });
});
