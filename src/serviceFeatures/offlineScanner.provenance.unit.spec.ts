import { describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DEFAULT_SETTINGS, LOG_LEVEL_INFO, type EntryDoc, type FilePathWithPrefix, type UXFileInfo } from "@lib/common/types";
import { compareMTime, createTextBlob } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { LiveSyncLocalDB, type LiveSyncLocalDBEnv } from "@lib/pouchdb/LiveSyncLocalDB";
import { ServiceDatabaseFileAccessBase, type ServiceDatabaseFileAccessDependencies } from "@lib/serviceModules/ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "@lib/serviceModules/ServiceFileHandlerBase";
import { syncStorageAndDatabase } from "./offlineScanner";

PouchDB.plugin(MemoryAdapter);

const path = "issue-1207.md" as FilePathWithPrefix;
const original = "Original content\n";
const incoming = "Updated on another device\n";
const localEdit = "Unsent edit on this device\n";
const originalMtime = 1_000_000;

class TestFileHandler extends ServiceFileHandlerBase {}

function makeFile(body: string, mtime = originalMtime): UXFileInfo {
    return {
        name: path,
        path,
        stat: { type: "file", ctime: originalMtime, mtime, size: new Blob([body]).size },
        body: createTextBlob(body),
    } as UXFileInfo;
}

type Scenario = "untracked-unchanged" | "recorded-unchanged" | "untracked-edited" | "recorded-edited";

async function runScenario(scenario: Scenario) {
    const name = `issue-1207-${scenario}-${crypto.randomUUID()}`;
    const db = new PouchDB<EntryDoc>(name, { adapter: "memory" });
    const provenance = new Map<FilePathWithPrefix, { revision: string; observedStorageMtime?: number }>();
    let storage = makeFile(original);
    const settings = { ...DEFAULT_SETTINGS, useOnlyLocalChunk: true, writeDocumentsIfConflicted: false };
    const setting = { currentSettings: () => settings };
    const pathService = {
        path2id: async (value: string) => value,
        id2path: (id: string, entry?: { path?: string }) => entry?.path ?? id,
        getPath: (entry: { path: FilePathWithPrefix }) => entry.path,
        compareFileFreshness: (file: UXFileInfo, entry: { mtime: number }) => compareMTime(file.stat.mtime, entry.mtime),
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
            API,
            path: pathService,
            setting,
            context: { events },
            events,
            database: { localDatabase },
            vault: { isTargetFile: async () => true, isFileSizeTooLarge: () => false },
            storageAccess,
            conflict,
            fileReflectionProvenance: {
                get: async (key: FilePathWithPrefix) => provenance.get(key),
                set: async (key: FilePathWithPrefix, value: { revision: string }) => { provenance.set(key, value); },
                delete: async (key: FilePathWithPrefix) => { provenance.delete(key); },
            },
            fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
            replication: { processSynchroniseResult: { addHandler: vi.fn() } },
        } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
        const access = new ServiceDatabaseFileAccessBase(services);
        services.databaseFileAccess = access;
        const handler = new TestFileHandler(services);
        const baseRevision = await access.storeWithBaseRevision(makeFile(original), undefined, true);
        expect(baseRevision).not.toBe(false);
        if (scenario.startsWith("recorded")) provenance.set(path, { revision: baseRevision as string });
        if (scenario.endsWith("edited")) storage = makeFile(localEdit);

        const previousMetadata = await access.fetchEntryMeta(path, undefined, true);
        expect(previousMetadata).not.toBe(false);
        const scanRevision = (await db.get(path))._rev;
        const host = { services, serviceModules: { fileHandler: handler, storageAccess, databaseFileAccess: access } };
        await expect(syncStorageAndDatabase(host, vi.fn(), storage, LOG_LEVEL_INFO, previousMetadata!)).resolves.toBe("completed");
        expect((await db.get(path))._rev).toBe(scanRevision);
        expect(provenance.get(path)?.revision).toBe(scenario.endsWith("edited") && scenario.startsWith("untracked")
            ? undefined : baseRevision);

        const incomingRevision = await access.storeWithBaseRevision(makeFile(incoming, originalMtime + 60_000), baseRevision as string, true);
        expect(incomingRevision).not.toBe(false);
        await expect(handler.dbToStorage(path, path, false)).resolves.toBe(true);
        const leaves = (await db.get(path, { open_revs: "all" }))
            .flatMap((result) => "ok" in result && !result.ok._deleted ? [result.ok] : []);
        const storageBody = await storage.body.text();
        if (scenario.endsWith("unchanged")) {
            expect(leaves).toHaveLength(1);
            expect(storageBody).toBe(incoming);
            expect(provenance.get(path)?.revision).toBe(incomingRevision);
            expect(conflict.queueCheckFor).not.toHaveBeenCalled();
        } else {
            expect(leaves).toHaveLength(2);
            expect(storageBody).toBe(localEdit);
            expect(conflict.queueCheckFor).toHaveBeenCalled();
        }
    } finally {
        localDatabase.offRemoteChunkFetchedHandler?.();
        await localDatabase.managers.teardownManagers();
        await db.destroy();
    }
}

describe("equal-time scan and later incoming revision", () => {
    it.each<Scenario>(["untracked-unchanged", "recorded-unchanged", "untracked-edited", "recorded-edited"])(
        "keeps the expected content and branches for %s",
        runScenario
    );
});
