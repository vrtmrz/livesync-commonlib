import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import type { EntryDoc, FilePathWithPrefix, UXFileInfo } from "@lib/common/types";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import { compareMTime, createTextBlob, isDocContentSame } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EntryManager, type EntryManagerOptions } from "@lib/managers/EntryManager/EntryManager";
import { ConflictManager } from "@lib/managers/ConflictManager";
import { ServiceDatabaseFileAccessBase, type ServiceDatabaseFileAccessDependencies } from "./ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

PouchDB.plugin(MemoryAdapter);
let nextDatabase = 0;
const path = "issue994.md" as FilePathWithPrefix;
const old = "# Note\nKeep\n\nTail\n";
const remote = "# Note\nKeep\n\nTail\nRemote addition\n";
const oldTime = 1_000_000;
const remoteTime = 2_000_000;

class TestHandler extends ServiceFileHandlerBase {}

function makeFile(body: string, mtime = oldTime): UXFileInfo {
    return {
        name: path,
        path,
        stat: { type: "file", ctime: oldTime, mtime, size: new Blob([body]).size },
        body: createTextBlob(body),
    } as UXFileInfo;
}

async function fixture() {
    const db = new PouchDB<EntryDoc>(`issue994-handler-${++nextDatabase}`, { adapter: "memory" });
    const reflection = new Map<FilePathWithPrefix, { revision: string; observedStorageMtime?: number }>();
    let storage = makeFile(old);
    const settings = { ...DEFAULT_SETTINGS, useOnlyLocalChunk: true, writeDocumentsIfConflicted: false };
    const setting = { currentSettings: () => settings };
    const pathService = {
        path2id: async (value: string) => value,
        id2path: (id: string, entry?: { path?: string }) => entry?.path ?? id,
        getPath: (entry: { path: FilePathWithPrefix }) => entry.path,
        compareFileFreshness: (file: UXFileInfo, entry: { mtime: number }) => compareMTime(file.stat.mtime, entry.mtime),
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
        read: async (ids: string[]) => await Promise.all(ids.map(async (id) => {
            try { return await db.get(id); } catch { return false; }
        })),
    };
    const entries = new EntryManager({
        database: db,
        settingService: setting as unknown as EntryManagerOptions["settingService"],
        pathService: pathService as unknown as EntryManagerOptions["pathService"],
        chunkManager: chunkManager as unknown as EntryManagerOptions["chunkManager"],
        hashManager: {
            computeHash: async (value: string) => createHash("sha256").update(value).digest("hex"),
        } as EntryManagerOptions["hashManager"],
        splitter: {
            initialised: Promise.resolve(),
            splitContent: async (note: { data: Blob }) => [await note.data.text()],
        } as EntryManagerOptions["splitter"],
    });
    // The service normally receives LiveSyncLocalDB, which forwards these
    // methods to EntryManager. This fixture keeps only the actual PouchDB path.
    const localDatabase = {
        getDBEntry: entries.getDBEntry.bind(entries),
        getDBEntryMeta: entries.getDBEntryMeta.bind(entries),
        getDBEntryFromMeta: entries.getDBEntryFromMeta.bind(entries),
        putDBEntry: entries.putDBEntry.bind(entries),
        putDBEntryAsIndependentRoot: entries.putDBEntryAsIndependentRoot.bind(entries),
        getRaw: db.get.bind(db),
    };
    const storageAccess = {
        getStub: async () => storage,
        getFileStub: async () => storage,
        readStubContent: async () => storage,
        ensureDir: async () => true,
        writeFileAuto: vi.fn(async (_path: string, body: string, times: { mtime: number }) => {
            storage = makeFile(body, times.mtime);
            return true;
        }),
        stat: async () => storage.stat,
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
            get: async (value: FilePathWithPrefix) => reflection.get(value),
            set: async (value: FilePathWithPrefix, record: { revision: string }) => { reflection.set(value, record); },
            delete: async (value: FilePathWithPrefix) => { reflection.delete(value); },
        },
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
    } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
    const access = new ServiceDatabaseFileAccessBase(services);
    (services as ServiceFileHandlerDependencies).databaseFileAccess = access;
    const handler = new TestHandler(services);
    const oldRevision = await access.storeWithBaseRevision(makeFile(old), undefined, true);
    expect(oldRevision).not.toBe(false);
    if (oldRevision === false) throw new Error("Could not create the old revision");
    const remoteRevision = await access.storeWithBaseRevision(makeFile(remote, remoteTime), oldRevision, true);
    expect(remoteRevision).not.toBe(false);
    if (remoteRevision === false) throw new Error("Could not create the remote revision");
    reflection.set(path, { revision: oldRevision, observedStorageMtime: oldTime });
    return {
        db, entries, access, handler, conflict, reflection, storageAccess, oldRevision, remoteRevision,
        getStorage: () => storage,
        setStorage: (file: UXFileInfo) => { storage = file; },
        merger: new ConflictManager({ database: db, entryManager: entries, pathService: pathService as EntryManagerOptions["pathService"] }),
    };
}

describe("file reflection provenance with real PouchDB revisions", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];
    afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.destroy())); });

    it("reflects a stale unchanged Vault file and keeps the remote addition", async () => {
        const f = await fixture();
        databases.push(f.db);
        await expect(f.handler.storeFileToDB(f.getStorage())).resolves.toBe(true);
        expect((await f.db.get(path))._rev).toBe(f.remoteRevision);
        await expect(isDocContentSame(f.getStorage().body, remote)).resolves.toBe(true);
        expect(await f.access.getConflictedRevs(path)).toEqual([]);
    });

    it("preserves a real edit from its displayed base and merges the remote addition", async () => {
        const f = await fixture();
        databases.push(f.db);
        const edited = old.replace("# Note", "# Local title");
        f.setStorage(makeFile(edited));
        await expect(f.handler.storeFileToDB(f.getStorage())).resolves.toBe(true);
        const localRevision = f.reflection.get(path)?.revision;
        expect(localRevision).toBeDefined();
        const local = await f.db.get(path, { rev: localRevision, revs: true });
        expect(local._revisions?.ids[1]).toBe(f.oldRevision.split("-")[1]);
        const decision = await f.merger.tryAutoMerge(path, true);
        expect(decision).toHaveProperty("result");
        if ("result" in decision) {
            expect(decision.result).toContain("# Local title");
            expect(decision.result).toContain("Remote addition");
        }
    });

    it("keeps one independent branch after repeated saves and loss of provenance", async () => {
        const f = await fixture();
        databases.push(f.db);
        f.reflection.delete(path);
        await expect(f.handler.storeFileToDB(f.getStorage())).resolves.toBe(true);
        const independent = f.reflection.get(path)?.revision;
        expect(independent).toMatch(/^1-/);
        expect(independent).not.toBe(f.oldRevision);
        const firstLeaves = await f.access.getConflictedRevs(path);
        expect(firstLeaves).toHaveLength(1);
        const beforeRepeat = (await f.db.info()).update_seq;
        await expect(f.handler.storeFileToDB(f.getStorage())).resolves.toBe(true);
        f.reflection.delete(path);
        await expect(f.handler.storeFileToDB(f.getStorage())).resolves.toBe(true);
        expect((await f.db.info()).update_seq).toBe(beforeRepeat);
        expect(await f.access.getConflictedRevs(path)).toEqual(firstLeaves);
        expect(f.reflection.get(path)?.revision).toBe(independent);
    });
});
