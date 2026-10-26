import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DEFAULT_SETTINGS, LOG_LEVEL_INFO, type EntryDoc, type FilePathWithPrefix, type UXFileInfo } from "@lib/common/types";
import { compareMTime, createTextBlob } from "@lib/common/utils";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
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

type Scenario =
    | "untracked-unchanged"
    | "recorded-unchanged"
    | "untracked-edited"
    | "recorded-edited"
    | "untracked-edited-close"
    | "recorded-edited-close";

function isRecorded(scenario: Scenario): boolean {
    return scenario.startsWith("recorded");
}

function isEdited(scenario: Scenario): boolean {
    return scenario.includes("edited");
}

function scenarioMtime(scenario: Scenario): number {
    return scenario.endsWith("-close") ? originalMtime + 1_000 : originalMtime;
}

async function createScenario(scenario: Scenario, revsLimit = 1000) {
    const name = `issue-1207-${scenario}-${crypto.randomUUID()}`;
    const db = new PouchDB<EntryDoc>(name, { adapter: "memory", revs_limit: revsLimit, auto_compaction: false });
    const provenance = new Map<FilePathWithPrefix, FileReflectionProvenanceRecord>();
    let storage: UXFileInfo | undefined = makeFile(original, scenarioMtime(scenario));
    let storageReadHook: (() => UXFileInfo | undefined) | undefined;
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
            getStub: async () => {
                const next = storageReadHook?.();
                if (next) storage = next;
                return storage;
            },
            getFileStub: async () => storage,
            hasPendingFileEvent: () => false,
            readStubContent: async () => storage,
            ensureDir: async () => true,
            writeFileAuto: vi.fn(async (_path: string, body: string, times: { mtime: number }) => {
                storage = makeFile(body, times.mtime);
                return true;
            }),
            stat: async () => storage?.stat,
            touched: async () => {},
            triggerFileEvent: vi.fn(),
            deleteVaultItem: async () => { storage = undefined; },
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
                set: async (key: FilePathWithPrefix, value: FileReflectionProvenanceRecord) => { provenance.set(key, value); },
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
        if (isRecorded(scenario)) provenance.set(path, { revision: baseRevision as string });
        if (isEdited(scenario)) storage = makeFile(localEdit, scenarioMtime(scenario));

        const previousMetadata = await access.fetchEntryMeta(path, undefined, true);
        expect(previousMetadata).not.toBe(false);
        if (!previousMetadata) throw new Error("Could not retrieve initial file Metadata");
        const host = { services, serviceModules: { fileHandler: handler, storageAccess, databaseFileAccess: access } };
        let disposed = false;
        const dispose = async () => {
            if (disposed) return;
            disposed = true;
            localDatabase.offRemoteChunkFetchedHandler?.();
            await localDatabase.managers.teardownManagers();
            await db.destroy();
        };
        return {
            db,
            access,
            handler,
            host,
            previousMetadata,
            baseRevision: baseRevision as string,
            provenance,
            provenanceStore: services.fileReflectionProvenance!,
            services,
            storageAccess,
            getStorage: () => {
                if (!storage) throw new Error("The fixture file is not present in storage");
                return storage;
            },
            storageExists: () => storage !== undefined,
            setStorage: (file: UXFileInfo) => { storage = file; },
            setStorageReadHook: (hook: (() => UXFileInfo | undefined) | undefined) => { storageReadHook = hook; },
            dispose,
        };
    } catch (error) {
        localDatabase.offRemoteChunkFetchedHandler?.();
        await localDatabase.managers.teardownManagers();
        await db.destroy();
        throw error;
    }
}

async function runScenario(scenario: Scenario) {
    const fixture = await createScenario(scenario);
    try {
        const scanRevision = (await fixture.db.get(path))._rev;
        await expect(
            syncStorageAndDatabase(fixture.host, vi.fn(), fixture.getStorage(), LOG_LEVEL_INFO, fixture.previousMetadata)
        ).resolves.toBe("completed");
        if (isEdited(scenario)) {
            expect(fixture.provenance.get(path)?.revision).toBeDefined();
            expect(fixture.provenance.get(path)?.revision).not.toBe(fixture.baseRevision);
        } else {
            expect((await fixture.db.get(path))._rev).toBe(scanRevision);
            expect(fixture.provenance.get(path)?.revision).toBe(fixture.baseRevision);
        }

        const incomingRevision = await fixture.access.storeWithBaseRevision(
            makeFile(incoming, originalMtime + 60_000), fixture.baseRevision, true
        );
        expect(incomingRevision).not.toBe(false);
        await expect(fixture.handler.dbToStorage(path, path, false)).resolves.toBe(true);
        const leaves = (await fixture.db.get(path, { open_revs: "all" }))
            .flatMap((result) => "ok" in result && !result.ok._deleted ? [result.ok] : []);
        const storageBody = await fixture.getStorage().body.text();
        if (!isEdited(scenario)) {
            expect(leaves).toHaveLength(1);
            expect(storageBody).toBe(incoming);
            expect(fixture.provenance.get(path)?.revision).toBe(incomingRevision);
            expect(fixture.services.conflict.queueCheckFor).not.toHaveBeenCalled();
        } else {
            expect(leaves).toHaveLength(2);
            expect(storageBody).toBe(localEdit);
            expect(leaves.map((leaf) => leaf._rev)).toContain(fixture.provenance.get(path)?.revision);
            expect(leaves.map((leaf) => leaf._rev)).toContain(incomingRevision);
        }
    } finally {
        await fixture.dispose();
    }
}

async function advanceDatabase(
    fixture: Awaited<ReturnType<typeof createScenario>>,
    contents: string[]
): Promise<string> {
    let revision = fixture.baseRevision;
    for (const body of contents) {
        const next = await fixture.access.storeWithBaseRevision(makeFile(body), revision, true);
        if (next === false) throw new Error(`Could not store database revision for ${body}`);
        revision = next;
    }
    return revision;
}

async function liveLeaves(fixture: Awaited<ReturnType<typeof createScenario>>) {
    return (await allLeaves(fixture)).filter((leaf) => !leaf._deleted);
}

async function allLeaves(fixture: Awaited<ReturnType<typeof createScenario>>) {
    return (await fixture.db.get(path, { open_revs: "all" }))
        .flatMap((result) => "ok" in result && result.ok ? [result.ok] : []);
}

function contentHash(body: string): string {
    return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

describe("optional startup content checks", () => {
    async function trackedFixture() {
        const fixture = await createScenario("recorded-unchanged");
        fixture.provenance.set(path, {
            revision: fixture.baseRevision,
            observedStorageMtime: originalMtime,
            contentSize: new Blob([original]).size,
            contentHash: contentHash(original),
        });
        return fixture;
    }

    it("skips unchanged file bodies and database chunks only when explicitly requested", async () => {
        const fixture = await trackedFixture();
        try {
            const readStorage = vi.spyOn(fixture.handler, "readFileFromStub");
            const readDatabase = vi.spyOn(fixture.access, "fetchEntry");
            const record = { ...fixture.provenance.get(path)! };
            const result = await syncStorageAndDatabase(
                fixture.host, vi.fn(), fixture.getStorage(), LOG_LEVEL_INFO, fixture.previousMetadata,
                { strictContentCheck: false }
            );
            expect(readStorage).not.toHaveBeenCalled();
            expect(readDatabase).not.toHaveBeenCalled();
            expect(result).toBe("skipped");
            expect(fixture.provenance.get(path)).toEqual(record);
            expect((await fixture.db.get(path))._rev).toBe(fixture.baseRevision);
        } finally { await fixture.dispose(); }
    });

    it("keeps timestamp-directed reconciliation when a reflected file has a different raw storage time", async () => {
        const fixture = await trackedFixture();
        try {
            fixture.setStorage(makeFile(original, originalMtime - 10_000));
            fixture.provenance.get(path)!.observedStorageMtime = originalMtime - 10_000;
            const reflect = vi.spyOn(fixture.handler, "dbToStorage");
            const result = await syncStorageAndDatabase(
                fixture.host, vi.fn(), fixture.getStorage(), LOG_LEVEL_INFO, fixture.previousMetadata,
                { strictContentCheck: false }
            );
            expect(reflect).toHaveBeenCalled();
            expect(result).toBe("completed");
        } finally { await fixture.dispose(); }
    });

    it.each([undefined, true, false])("retains the agreed same-stat edit boundary with strict=%s", async (strictContentCheck) => {
        const fixture = await trackedFixture();
        try {
            const changed = original.replace("Original", "Modified");
            fixture.setStorage(makeFile(changed));
            await syncStorageAndDatabase(
                fixture.host, vi.fn(), fixture.getStorage(), LOG_LEVEL_INFO, fixture.previousMetadata,
                { strictContentCheck }
            );
            const stored = await fixture.access.fetchEntry(path, undefined, true, true, true);
            expect(stored && (await new Blob(stored.data).text())).toBe(strictContentCheck === false ? original : changed);
            expect(await fixture.getStorage().body.text()).toBe(changed);
            if (strictContentCheck === false) {
                await advanceDatabase(fixture, [incoming]);
                await fixture.handler.dbToStorage(path, path, false);
                expect(await fixture.getStorage().body.text()).toBe(changed);
                expect(await liveLeaves(fixture)).toHaveLength(2);
            }
        } finally { await fixture.dispose(); }
    });

    it.each(["mtime", "size", "untracked", "incomplete", "pending", "unknown-pending", "database-advanced"] as const)(
        "checks contents when %s prevents the fast path", async (reason) => {
            const fixture = await trackedFixture();
            try {
                if (reason === "mtime") fixture.setStorage(makeFile(original, originalMtime + 1));
                if (reason === "size") fixture.setStorage(makeFile(original + "extra"));
                if (reason === "untracked") fixture.provenance.delete(path);
                if (reason === "incomplete") fixture.provenance.set(path, { revision: fixture.baseRevision });
                if (reason === "pending") fixture.storageAccess.hasPendingFileEvent = () => true;
                if (reason === "unknown-pending") Reflect.deleteProperty(fixture.storageAccess, "hasPendingFileEvent");
                if (reason === "database-advanced") await advanceDatabase(fixture, [incoming]);
                const readStorage = vi.spyOn(fixture.handler, "readFileFromStub");
                await syncStorageAndDatabase(
                    fixture.host, vi.fn(), fixture.getStorage(), LOG_LEVEL_INFO, fixture.previousMetadata,
                    { strictContentCheck: false }
                );
                expect(readStorage).toHaveBeenCalled();
            } finally { await fixture.dispose(); }
        }
    );
});

describe("equal-time scan and later incoming revision", () => {
    it.each<Scenario>([
        "untracked-unchanged",
        "recorded-unchanged",
        "untracked-edited",
        "recorded-edited",
        "untracked-edited-close",
        "recorded-edited-close",
    ])(
        "keeps the expected content and branches for %s",
        runScenario
    );

    it("fails an equal-time pair when provenance cannot be read instead of creating a guessed branch", async () => {
        const fixture = await createScenario("recorded-edited");
        try {
            fixture.provenanceStore.get = async () => {
                throw new Error("provenance store unavailable");
            };
            const result = await syncStorageAndDatabase(
                fixture.host,
                vi.fn(),
                fixture.getStorage(),
                LOG_LEVEL_INFO,
                fixture.previousMetadata
            );

            expect(result).toBe("failed");
            expect((await liveLeaves(fixture)).map((leaf) => leaf._rev)).toEqual([fixture.baseRevision]);
        } finally {
            await fixture.dispose();
        }
    });

    it("fails without creating a branch when the recorded base body is unavailable but its winner is readable", async () => {
        const fixture = await createScenario("recorded-edited");
        const latestRevision = await advanceDatabase(fixture, [incoming]);
        const latestMetadata = await fixture.access.fetchEntryMeta(path, undefined, true);
        if (!latestMetadata) throw new Error("Latest database Metadata is missing");
        const fetchEntry = fixture.access.fetchEntry.bind(fixture.access);
        const unavailableBase = vi.spyOn(fixture.access, "fetchEntry").mockImplementation(
            async (file, revision, waitForReady, skipCheck, localOnly) => {
                if (revision === fixture.baseRevision) return false;
                return await fetchEntry(file, revision, waitForReady, skipCheck, localOnly);
            }
        );
        try {
            expect(await fixture.access.fetchEntryMeta(path, fixture.baseRevision, true)).toMatchObject({
                _rev: fixture.baseRevision,
            });
            expect(await fixture.access.fetchEntry(path, fixture.baseRevision, true, true, true)).toBe(false);
            const result = await syncStorageAndDatabase(
                fixture.host,
                vi.fn(),
                fixture.getStorage(),
                LOG_LEVEL_INFO,
                latestMetadata
            );

            expect(result).toBe("failed");
            expect((await liveLeaves(fixture)).map((leaf) => leaf._rev)).toEqual([latestRevision]);
        } finally {
            unavailableBase.mockRestore();
            await fixture.dispose();
        }
    });

    it("fails without creating a branch when the winning content cannot be loaded", async () => {
        const fixture = await createScenario("untracked-edited");
        const fetchEntry = fixture.access.fetchEntry.bind(fixture.access);
        const unavailableWinner = vi.spyOn(fixture.access, "fetchEntry").mockImplementation(
            async (file, revision, waitForReady, skipCheck, localOnly) => {
                if (revision === undefined) return false;
                return await fetchEntry(file, revision, waitForReady, skipCheck, localOnly);
            }
        );
        try {
            const latestMetadata = await fixture.access.fetchEntryMeta(path, undefined, true);
            if (!latestMetadata) throw new Error("Latest database Metadata is missing");
            expect(await fixture.access.fetchEntryMeta(path, latestMetadata._rev, true)).toMatchObject({
                _rev: fixture.baseRevision,
            });
            expect(await fixture.access.fetchEntry(path, undefined, true, true, true)).toBe(false);
            const result = await syncStorageAndDatabase(
                fixture.host,
                vi.fn(),
                fixture.getStorage(),
                LOG_LEVEL_INFO,
                latestMetadata
            );

            expect(result).toBe("failed");
            expect((await liveLeaves(fixture)).map((leaf) => leaf._rev)).toEqual([fixture.baseRevision]);
        } finally {
            unavailableWinner.mockRestore();
            await fixture.dispose();
        }
    });

    it("fails after bounded re-evaluation when storage bytes keep changing at the same mtime", async () => {
        const fixture = await createScenario("recorded-edited");
        const observedMtimes: number[] = [];
        let storageReadCount = 0;
        try {
            fixture.setStorageReadHook(() => {
                storageReadCount++;
                const current = makeFile(`Concurrent storage version ${storageReadCount}\n`, originalMtime);
                observedMtimes.push(current.stat.mtime);
                return current;
            });
            const result = await syncStorageAndDatabase(
                fixture.host,
                vi.fn(),
                fixture.getStorage(),
                LOG_LEVEL_INFO,
                fixture.previousMetadata
            );

            expect(result).toBe("failed");
            expect(storageReadCount).toBeGreaterThan(1);
            expect(storageReadCount).toBeLessThan(10);
            expect(new Set(observedMtimes)).toEqual(new Set([originalMtime]));
        } finally {
            await fixture.dispose();
        }
    });

    it("reflects the advanced database when a matching saved hash outlives its pruned revision", async () => {
        const fixture = await createScenario("recorded-unchanged", 1);
        const latestContent = "Latest remote version\n";
        try {
            fixture.provenance.set(path, {
                revision: fixture.baseRevision,
                observedStorageMtime: originalMtime,
                contentHash: contentHash(original),
                contentSize: new Blob([original]).size,
            });
            const latestRevision = await advanceDatabase(fixture, [incoming, latestContent]);
            await fixture.db.compact();

            expect(await fixture.access.fetchEntryMeta(path, fixture.baseRevision, true)).toBe(false);
            const latestMetadata = await fixture.access.fetchEntryMeta(path, undefined, true);
            if (!latestMetadata) throw new Error("Latest database Metadata is missing");
            await expect(
                syncStorageAndDatabase(
                    fixture.host,
                    vi.fn(),
                    fixture.getStorage(),
                    LOG_LEVEL_INFO,
                    latestMetadata
                )
            ).resolves.toBe("completed");

            expect(await fixture.getStorage().body.text()).toBe(latestContent);
            expect((await liveLeaves(fixture)).map((leaf) => leaf._rev)).toEqual([latestRevision]);
            expect(fixture.provenance.get(path)?.revision).toBe(latestRevision);
        } finally {
            await fixture.dispose();
        }
    });

    it("keeps a new independent branch when an unhashed pruned base and live leaves do not match storage", async () => {
        const fixture = await createScenario("recorded-edited", 1);
        try {
            const latestRevision = await advanceDatabase(fixture, [incoming, "Latest remote version\n"]);
            await fixture.db.compact();

            expect(await fixture.access.fetchEntryMeta(path, fixture.baseRevision, true)).toBe(false);
            expect(await fixture.access.findLiveContentRevisions(path, localEdit)).toEqual([]);
            const latestMetadata = await fixture.access.fetchEntryMeta(path, undefined, true);
            if (!latestMetadata) throw new Error("Latest database Metadata is missing");
            await expect(
                syncStorageAndDatabase(
                    fixture.host,
                    vi.fn(),
                    fixture.getStorage(),
                    LOG_LEVEL_INFO,
                    latestMetadata
                )
            ).resolves.toBe("completed");

            const leaves = await liveLeaves(fixture);
            const localBranches = await fixture.access.findLiveContentRevisions(path, localEdit);
            expect(leaves).toHaveLength(2);
            expect(leaves.map((leaf) => leaf._rev)).toContain(latestRevision);
            expect(localBranches).toHaveLength(1);
            expect(localBranches[0]).toMatch(/^1-/);
        } finally {
            await fixture.dispose();
        }
    });
});

describe("equal-time scan concurrent database deletion", () => {
    it.each(["logical", "physical"] as const)(
        "does not resurrect unchanged storage bytes after a %s tombstone advances the database",
        async (deletionKind) => {
            const fixture = await createScenario("recorded-unchanged");
            try {
                const provenanceBeforeDeletion = fixture.provenance.get(path);
                const current = await fixture.db.get(path);
                const deletion = deletionKind === "logical"
                    ? await fixture.db.put({ ...current, deleted: true })
                    : await fixture.db.remove(current._id, current._rev);

                expect(provenanceBeforeDeletion).toEqual({ revision: fixture.baseRevision });
                expect(fixture.provenance.get(path)).toEqual(provenanceBeforeDeletion);
                const deletedLeavesBeforeScan = await allLeaves(fixture);
                expect(deletedLeavesBeforeScan.map((leaf) => leaf._rev)).toContain(deletion.rev);
                expect(deletedLeavesBeforeScan.every((leaf) => leaf.deleted || leaf._deleted)).toBe(true);

                const result = await syncStorageAndDatabase(
                    fixture.host,
                    vi.fn(),
                    fixture.getStorage(),
                    LOG_LEVEL_INFO,
                    fixture.previousMetadata
                );

                expect(["failed", "completed"]).toContain(result);
                const leavesAfterScan = await allLeaves(fixture);
                expect(leavesAfterScan.map((leaf) => leaf._rev)).toEqual([deletion.rev]);
                expect(leavesAfterScan.every((leaf) => leaf.deleted || leaf._deleted)).toBe(true);
                expect(await fixture.access.findLiveContentRevisions(path, original)).toEqual([]);
                if (result === "completed") {
                    expect(fixture.storageExists()).toBe(false);
                } else {
                    expect(fixture.storageExists()).toBe(true);
                }
            } finally {
                await fixture.dispose();
            }
        }
    );

    it.each(["logical", "physical"] as const)("preserves an edit on its recorded branch beside a concurrent %s deletion", async (deletionKind) => {
        const fixture = await createScenario("recorded-edited");
        try {
            const current = await fixture.db.get(path);
            const deletion = deletionKind === "logical"
                ? await fixture.db.put({ ...current, deleted: true })
                : await fixture.db.remove(current._id, current._rev);

            const result = await syncStorageAndDatabase(
                fixture.host,
                vi.fn(),
                fixture.getStorage(),
                LOG_LEVEL_INFO,
                fixture.previousMetadata
            );

            expect(result).toBe("completed");
            expect(await fixture.getStorage().body.text()).toBe(localEdit);
            const editBranches = await fixture.access.findLiveContentRevisions(path, localEdit);
            expect(editBranches).toHaveLength(1);
            const leaves = await allLeaves(fixture);
            expect(leaves.map((leaf) => leaf._rev)).toContain(deletion.rev);
            expect(leaves.filter((leaf) => !leaf.deleted && !leaf._deleted).map((leaf) => leaf._rev)).toEqual(editBranches);
            expect(fixture.provenance.get(path)?.revision).toBe(editBranches[0]);
        } finally {
            await fixture.dispose();
        }
    });
});
