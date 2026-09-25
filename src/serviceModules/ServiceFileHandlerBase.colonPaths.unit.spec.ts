import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import type { EntryDoc, FilePathWithPrefix, UXFileInfo } from "@lib/common/types";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import { createTextBlob, isDocContentSame, readContent } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EntryManager, type EntryManagerOptions } from "@lib/managers/EntryManager/EntryManager";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import type { ISettingService } from "@lib/services/base/IService";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "./ServiceDatabaseFileAccessBase";
import { ServiceFileHandlerBase, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase";

PouchDB.plugin(MemoryAdapter);
let nextDatabase = 0;

class TestHandler extends ServiceFileHandlerBase {}

function makeFile(path: string, body: string, mtime: number): UXFileInfo {
    return {
        name: path.split("/").pop() ?? path,
        path: path as FilePathWithPrefix,
        stat: { type: "file", ctime: 1_000, mtime, size: new Blob([body]).size },
        body: createTextBlob(body),
    } as UXFileInfo;
}

async function fixture(usePathObfuscation: boolean) {
    const db = new PouchDB<EntryDoc>(`colon-paths-handler-${++nextDatabase}`, { adapter: "memory" });
    const settings = {
        ...DEFAULT_SETTINGS,
        useOnlyLocalChunk: true,
        usePathObfuscation,
        passphrase: "path-secret",
        handleFilenameCaseSensitive: true,
    };
    const setting = { currentSettings: () => settings };
    const pathService = new PathServiceCompat(new ServiceContext(), {
        settingService: setting as unknown as ISettingService,
    });
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
        pathService,
        chunkManager: chunkManager as unknown as EntryManagerOptions["chunkManager"],
        hashManager: {
            computeHash: async (value: string) => createHash("sha256").update(value).digest("hex"),
        } as EntryManagerOptions["hashManager"],
        splitter: {
            initialised: Promise.resolve(),
            splitContent: async (note: { data: Blob }) => [await note.data.text()],
        } as EntryManagerOptions["splitter"],
    });
    // The host database normally forwards these calls to EntryManager.
    const localDatabase = {
        getDBEntry: entries.getDBEntry.bind(entries),
        getDBEntryMeta: entries.getDBEntryMeta.bind(entries),
        getDBEntryFromMeta: entries.getDBEntryFromMeta.bind(entries),
        putDBEntry: entries.putDBEntry.bind(entries),
        putDBEntryAsIndependentRoot: entries.putDBEntryAsIndependentRoot.bind(entries),
        getRaw: db.get.bind(db),
    };
    const storage = new Map<string, UXFileInfo>();
    const storageAccess = {
        getStub: async (path: string) => storage.get(path) ?? null,
        getFileStub: async (path: string) => storage.get(path) ?? null,
        readStubContent: async (file: UXFileInfo) => file,
        ensureDir: async () => true,
        writeFileAuto: vi.fn(async (path: string, body: string, times: { mtime: number }) => {
            storage.set(path, makeFile(path, body, times.mtime));
            return true;
        }),
        stat: async (path: string) => storage.get(path)?.stat,
        touched: async () => {},
        triggerFileEvent: vi.fn(),
    };
    const services = {
        API: { addLog: vi.fn() },
        path: pathService,
        setting,
        events: createLiveSyncEventHub(),
        database: { localDatabase },
        vault: { isTargetFile: async () => true, isFileSizeTooLarge: () => false },
        storageAccess,
        conflict: { queueCheckFor: vi.fn(), queueCheckForIfOpen: vi.fn() },
        fileProcessing: { processFileEvent: { addHandler: vi.fn() } },
        replication: { processSynchroniseResult: { addHandler: vi.fn() } },
    } as unknown as ServiceFileHandlerDependencies & ServiceDatabaseFileAccessDependencies;
    const access = new ServiceDatabaseFileAccessBase(services);
    (services as ServiceFileHandlerDependencies).databaseFileAccess = access;
    const handler = new TestHandler(services);
    return { db, entries, pathService, access, handler, storage, storageAccess };
}

describe.each([false, true])("ordinary colon paths with path obfuscation %s", (usePathObfuscation) => {
    const databases: PouchDB.Database<EntryDoc>[] = [];
    afterEach(async () => {
        await Promise.all(databases.splice(0).map((db) => db.destroy()));
    });

    it("stores, retrieves, and reflects each requested path without a root duplicate", async () => {
        const f = await fixture(usePathObfuscation);
        databases.push(f.db);
        // These are ordinary namespace paths; none starts with a reserved prefix.
        const cases = [
            { path: "Folder/Poem: Example.md", body: "first poem\n" },
            { path: "Other/Poem: Example.md", body: "second poem\n" },
            { path: "Folder/Poem: Example: Final.md", body: "final poem\n" },
        ];

        for (const [index, item] of cases.entries()) {
            const file = makeFile(item.path, item.body, 2_000 + index);
            f.storage.set(item.path, file);
            await expect(f.handler.storeFileToDB(file)).resolves.toBe(true);
        }

        const expectedIds = await Promise.all(cases.map(({ path }) => f.pathService.path2id(path)));
        expect(new Set(expectedIds).size).toBe(cases.length);

        const metadata = await Promise.all(
            cases.map(({ path }) => f.access.fetchEntryMeta(path as FilePathWithPrefix))
        );
        expect(metadata.every(Boolean)).toBe(true);
        expect(metadata.map((entry) => entry?.path)).toEqual(cases.map(({ path }) => path));
        expect(metadata.map((entry) => entry?._id)).toEqual(expectedIds);

        const allDocuments = await f.db.allDocs({ include_docs: true });
        const metadataDocuments = allDocuments.rows
            .map((row) => row.doc as EntryDoc | undefined)
            .filter((doc) => doc?.type === "plain" || doc?.type === "newnote");
        expect(metadataDocuments).toHaveLength(cases.length);
        expect(metadataDocuments.map((entry) => entry?._id).sort()).toEqual([...expectedIds].sort());

        for (const [index, item] of cases.entries()) {
            const entryMeta = metadata[index];
            expect(entryMeta).toBeTruthy();
            if (!entryMeta) throw new Error(`Missing metadata for ${item.path}`);

            const rawMetadata = await f.db.get(entryMeta._id);
            expect(rawMetadata).not.toHaveProperty("data");
            expect(rawMetadata.children.length).toBeGreaterThan(0);

            const entry = await f.access.fetchEntry(item.path as FilePathWithPrefix);
            expect(entry).not.toBe(false);
            if (entry === false) throw new Error(`Could not retrieve ${item.path}`);
            await expect(isDocContentSame(readContent(entry), item.body)).resolves.toBe(true);

            await expect(f.handler.dbToStorage(entryMeta, null, true)).resolves.toBe(true);
        }

        expect([...f.storage.keys()].sort()).toEqual(cases.map(({ path }) => path).sort());
        for (const item of cases) {
            const reflected = f.storage.get(item.path);
            expect(reflected?.path).toBe(item.path);
            await expect(isDocContentSame(reflected?.body, item.body)).resolves.toBe(true);
        }
    });
});
