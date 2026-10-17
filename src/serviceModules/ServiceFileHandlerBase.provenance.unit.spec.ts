import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import type { EntryDoc, FilePathWithPrefix, UXFileInfo } from "@lib/common/types";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import { compareMTime, createTextBlob, isDocContentSame } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EntryManager, type EntryManagerOptions } from "@lib/managers/EntryManager/EntryManager";
import { ConflictManager } from "@lib/managers/ConflictManager";
import { ServiceDatabaseFileAccessBase, type ServiceDatabaseFileAccessDependencies } from "./ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(replication);
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

async function fixture(revsLimit = 1000) {
    const db = new PouchDB<EntryDoc>(`issue994-handler-${++nextDatabase}`, {
        adapter: "memory", revs_limit: revsLimit, auto_compaction: false,
    });
    const reflection = new Map<FilePathWithPrefix, FileReflectionProvenanceRecord>();
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
            usesIndependentIdKey: () => false,
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
            set: async (value: FilePathWithPrefix, record: FileReflectionProvenanceRecord) => { reflection.set(value, record); },
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
        db, entries, access, handler, conflict, reflection, storageAccess, oldRevision, remoteRevision, services,
        getStorage: () => storage,
        setStorage: (file: UXFileInfo) => { storage = file; },
        merger: new ConflictManager({ database: db, entryManager: entries, pathService: pathService as EntryManagerOptions["pathService"] }),
    };
}

describe("file reflection provenance with real PouchDB revisions", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];
    afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.destroy())); });

    it.each([
        { updates: 99, limit: 100, mode: "unchanged" },
        { updates: 100, limit: 100, mode: "unchanged" },
        { updates: 599, limit: 100, mode: "unchanged" },
        { updates: 599, limit: 1000, mode: "unchanged" },
        ...["restart", "edited", "reverted", "legacy", "unsupported", "invalid-size"].map(mode => ({ updates: 100, limit: 100, mode })),
    ])("reflects an unchanged file after $updates remote revisions with limit $limit ($mode, #1207)", async ({ updates, limit, mode }) => {
        const f = await fixture(limit);
        const source = new PouchDB<EntryDoc>(`issue1207-remote-${++nextDatabase}`, {
            adapter: "memory", revs_limit: 1000, auto_compaction: false,
        });
        databases.push(f.db, source);
        f.setStorage(makeFile(remote, remoteTime));
        f.reflection.delete(path);
        await expect(f.handler.tryRecordUntrackedFileRevision(f.getStorage(), f.remoteRevision)).resolves.toBe(true);
        expect(f.reflection.get(path)).toEqual({
            revision: f.remoteRevision, observedStorageMtime: remoteTime,
            contentHash: `sha256:${createHash("sha256").update(remote).digest("hex")}`,
            contentSize: new Blob([remote]).size,
        });
        const baseMeta = await f.db.get(path);
        await f.db.replicate.to(source);

        const incoming = `${remote}Another device edited this note\n`;
        const chunkId = "h:issue1207-incoming";
        await source.put({ _id: chunkId, type: "leaf", data: incoming } as EntryDoc);
        let meta = await source.get(path);
        for (let index = 0; index < updates; index++) {
            const result = await source.put({
                ...meta, children: [chunkId], size: new Blob([incoming]).size,
                mtime: remoteTime + 10_000 + index, eden: {},
            });
            meta = { ...meta, _rev: result.rev };
        }
        await source.replicate.to(f.db);
        expect(await f.access.getConflictedRevs(path)).toEqual([]);
        expect(f.reflection.get(path)?.revision).toBe(f.remoteRevision);
        const baseReadable = await f.access.fetchEntryMeta(path, f.remoteRevision, true);
        expect(Boolean(baseReadable)).toBe(updates < limit);
        for (const id of baseMeta.children) await expect(f.db.get(id)).resolves.toHaveProperty("type", "leaf");
        const latest = await f.access.fetchEntryMeta(path, undefined, true);
        if (!latest) throw new Error("Incoming metadata is missing");
        if (mode === "edited") f.setStorage(makeFile(remote.replace("Keep", "Skip"), remoteTime));
        if (mode === "reverted") f.setStorage(makeFile(old, remoteTime));
        const record = f.reflection.get(path)!;
        if (mode === "legacy") f.reflection.set(path, { revision: record.revision, observedStorageMtime: remoteTime });
        if (mode === "unsupported") f.reflection.set(path, { ...record, contentHash: record.contentHash!.replace("sha256:", "other:") });
        if (mode === "invalid-size") f.reflection.set(path, { ...record, contentSize: -1 });
        const unchanged = mode === "unchanged" || mode === "restart";
        const before = await f.getStorage().body.text();
        const handler = mode === "restart" ? new TestHandler(f.services) : f.handler;
        await expect(handler.dbToStorage(latest, f.getStorage())).resolves.toBe(true);
        const conflicts = await f.access.getConflictedRevs(path);
        console.info(JSON.stringify({
            updates, limit, baseReadable: Boolean(baseReadable), conflicts,
            provenanceAfter: f.reflection.get(path)?.revision,
            oldBytesRetained: await isDocContentSame(f.getStorage().body, remote),
        }));
        expect(conflicts).toHaveLength(unchanged ? 0 : 1);
        await expect(isDocContentSame(f.getStorage().body, unchanged ? incoming : before)).resolves.toBe(true);
        if (!unchanged) expect(f.reflection.get(path)?.revision).toMatch(/^1-/);
        expect(f.reflection.get(path)?.contentHash).toBe(
            `sha256:${createHash("sha256").update(unchanged ? incoming : before).digest("hex")}`
        );
    });

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
