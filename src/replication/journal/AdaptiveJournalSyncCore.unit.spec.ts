import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { describe, expect, it, vi } from "vitest";

import {
    DEFAULT_SETTINGS,
    REMOTE_MINIO,
    type DocumentID,
    type EntryDoc,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import type { SimpleStore } from "@lib/common/utils.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";

import { AdaptiveJournalSyncCore } from "./AdaptiveJournalSyncCore.ts";
import { decodeCommitEnvelopeV1 } from "./adaptive/AdaptiveJournalCommit.ts";
import type {
    AdaptiveJournalByteRangeV1,
    AdaptiveJournalObjectListV1,
    AdaptiveJournalObjectRemoteV1,
} from "./adaptive/AdaptiveJournalObjectStore.ts";
import type {
    AdaptiveJournalManifestRemoteV1,
    CapabilityVerification,
    ImmutableCreate,
    RemoteRead,
} from "./adaptive/AdaptiveJournalRepository.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type {
    IJournalStorage,
    JournalStorageRemoteFormatV1,
    JournalStorageSetting,
} from "./objectstore/JournalStorageAdapter.ts";

PouchDB.plugin(MemoryAdapter);

interface MemoryAdaptiveRemote {
    manifest?: Uint8Array;
    objects: Map<string, Uint8Array>;
}

class MemoryAdaptiveObjectStorage
    implements IJournalStorage, AdaptiveJournalManifestRemoteV1, AdaptiveJournalObjectRemoteV1
{
    readonly adaptiveReads: Array<{ key: string; range?: AdaptiveJournalByteRangeV1 }> = [];
    receivePhases = 0;
    readonly storageIdentity: string;

    readonly kind = "s3" as const;

    constructor(private readonly remote: MemoryAdaptiveRemote) {
        this.storageIdentity = "s3:https://example.com/adaptive/";
    }

    applyNewConfig(_settings: JournalStorageSetting): void {}

    async createAdaptiveObject(key: string, bytes: Uint8Array, _mime: string): Promise<ImmutableCreate> {
        if (this.remote.objects.has(key)) return { status: "already-exists" };
        this.remote.objects.set(key, bytes.slice());
        return { status: "created" };
    }

    async createManifest(bytes: Uint8Array): Promise<ImmutableCreate> {
        if (this.remote.manifest) return { status: "already-exists" };
        this.remote.manifest = bytes.slice();
        return { status: "created" };
    }

    async deleteFiles(keys: string[]): Promise<boolean> {
        for (const key of keys) this.remote.objects.delete(key);
        return true;
    }

    async download(_key: string): Promise<false> {
        return false;
    }

    async getUsage() {
        return false as const;
    }

    async inspectRemoteFormat(): Promise<JournalStorageRemoteFormatV1> {
        return this.remote.manifest ? "adaptive-v1" : "empty";
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        return {
            keys: [...this.remote.objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
            status: "ok",
        };
    }

    async listFiles(from: string, limit?: number): Promise<string[]> {
        const keys = [...this.remote.objects.keys()].filter((key) => key > from).sort();
        return limit === undefined ? keys : keys.slice(0, limit);
    }

    async readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>> {
        this.adaptiveReads.push({ key, range });
        const bytes = this.remote.objects.get(key);
        if (!bytes) return { status: "missing" };
        return {
            status: "found",
            value: range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice(),
        };
    }

    async readManifest(): Promise<RemoteRead<Uint8Array>> {
        return this.remote.manifest ? { status: "found", value: this.remote.manifest.slice() } : { status: "missing" };
    }

    async resetJournalStorage(): Promise<boolean> {
        this.remote.manifest = undefined;
        this.remote.objects.clear();
        return true;
    }

    async runAdaptiveJournalReceivePhase<T>(task: () => Promise<T>): Promise<T> {
        this.receivePhases += 1;
        return await task();
    }

    async upload(_key: string, _data: Uint8Array, _mime: string): Promise<boolean> {
        return false;
    }

    async verifyCapabilities(_required: readonly string[]): Promise<CapabilityVerification> {
        return { status: "verified" };
    }
}

function memoryStore(): SimpleStore<unknown> {
    const values = new Map<string, unknown>();
    return {
        delete: async (key) => void values.delete(key),
        get: async (key) => structuredClone(values.get(key)),
        keys: async (from, to) =>
            [...values.keys()].filter((key) => (from === undefined || key >= from) && (to === undefined || key <= to)),
        set: async (key, value) => void values.set(key, structuredClone(value)),
    } as unknown as SimpleStore<unknown>;
}

function settings(): RemoteDBSettings {
    return {
        ...DEFAULT_SETTINGS,
        encrypt: false,
        remoteType: REMOTE_MINIO,
        journalFormat: "adaptive-v1",
        packReadPolicy: "whole-pack",
    } as RemoteDBSettings;
}

function environment(
    database: PouchDB.Database<EntryDoc>,
    currentSettings: RemoteDBSettings
): LiveSyncJournalReplicatorEnv {
    return {
        services: {
            context: createServiceContext(),
            database: { localDatabase: { localDatabase: database } },
            replicator: {
                replicationStatics: {
                    value: {
                        arrived: 0,
                        lastSyncPullSeq: 0,
                        lastSyncPushSeq: 0,
                        maxPullSeq: 0,
                        maxPushSeq: 0,
                        sent: 0,
                        syncStatus: "NOT_CONNECTED",
                    },
                },
            },
            setting: { currentSettings: () => currentSettings },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
}

function metadata(): EntryDoc {
    return {
        _id: "notes/adaptive.md" as DocumentID,
        children: ["h:adaptive-chunk"],
        ctime: 1,
        mtime: 2,
        path: "notes/adaptive.md",
        size: 13,
        type: "newnote",
    } as EntryDoc;
}

describe("AdaptiveJournalSyncCore", () => {
    it("reports the accepted repository identity once after the manifest is durably opened", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const database = new PouchDB<EntryDoc>("adaptive-core-repository-identity", { adapter: "memory" });
        const accepted = vi.fn(async (_repositoryId: string) => undefined);
        try {
            const AdaptiveJournalSyncCoreWithAcceptance = AdaptiveJournalSyncCore as unknown as new (
                ...args: unknown[]
            ) => AdaptiveJournalSyncCore;
            const core = new AdaptiveJournalSyncCoreWithAcceptance(
                currentSettings,
                memoryStore(),
                environment(database, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "s3-host",
                vi.fn(),
                accepted
            );

            await expect(core.getReplicationPBKDF2Salt()).resolves.toHaveLength(32);
            expect(accepted).toHaveBeenCalledOnce();
            expect(accepted).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u));

            await expect(core.getReplicationPBKDF2Salt()).resolves.toHaveLength(32);
            expect(accepted).toHaveBeenCalledOnce();
        } finally {
            await database.destroy();
        }
    });

    it("uses the Adaptive object path for S3-compatible storage", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const database = new PouchDB<EntryDoc>("adaptive-core-s3", { adapter: "memory" });
        try {
            const core = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(database, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "s3-host",
                vi.fn()
            );

            await expect(core.sendLocalJournal()).resolves.toBe(true);
            expect(remote.manifest).toBeDefined();
            expect([...remote.objects.keys()]).toEqual(expect.arrayContaining([expect.stringMatching(/^a1~writer~/u)]));
        } finally {
            await database.destroy();
        }
    });

    it("publishes and receives Metadata and Chunks through the object profile", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const senderDB = new PouchDB<EntryDoc>("adaptive-core-sender", { adapter: "memory" });
        const receiverDB = new PouchDB<EntryDoc>("adaptive-core-receiver", { adapter: "memory" });
        const received = vi.fn();
        try {
            await senderDB.put({
                _id: "h:adaptive-chunk" as DocumentID,
                data: "adaptive body",
                type: "leaf",
            } as EntryDoc);
            await senderDB.put(metadata());
            const senderStorage = new MemoryAdaptiveObjectStorage(remote);
            const sender = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(senderDB, currentSettings),
                senderStorage,
                async () => "sender-host",
                vi.fn()
            );
            const receiverStorage = new MemoryAdaptiveObjectStorage(remote);
            const receiver = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(receiverDB, currentSettings),
                receiverStorage,
                async () => "receiver-host",
                received
            );

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);

            await expect(receiverDB.get("notes/adaptive.md")).resolves.toMatchObject({
                _id: "notes/adaptive.md",
                children: ["h:adaptive-chunk"],
                mtime: 2,
            });
            await expect(receiverDB.get("h:adaptive-chunk")).resolves.toMatchObject({
                _id: "h:adaptive-chunk",
                data: "adaptive body",
                type: "leaf",
            });
            expect(received).toHaveBeenCalledOnce();
            expect(receiverStorage.receivePhases).toBe(1);
            expect(remote.manifest).toBeDefined();
            const objectKeys = [...remote.objects.keys()];
            expect(objectKeys.filter((key) => /^a1~writer~/u.test(key))).toHaveLength(2);
            expect(objectKeys.filter((key) => /^a1~commit~/u.test(key))).toHaveLength(1);
            expect(objectKeys.every((key) => /^a1~(?:writer|commit)~/u.test(key))).toBe(true);
            expect(receiverStorage.adaptiveReads.filter(({ key }) => /^a1~commit~/u.test(key))).toHaveLength(1);
            expect(receiverStorage.adaptiveReads.some(({ key }) => /^a1~pack~/u.test(key))).toBe(false);

            await senderDB.put({
                ...metadata(),
                _id: "notes/after-rebuild.md" as DocumentID,
                path: "notes/after-rebuild.md",
            } as EntryDoc);
            await expect(receiver.resetBucket()).resolves.toBe(true);
            await receiver.getReplicationPBKDF2Salt();
            const rebuiltKeys = [...remote.objects.keys()].sort();

            await expect(sender.sendLocalJournal()).resolves.toBe(false);
            expect([...remote.objects.keys()].sort()).toEqual(rebuiltKeys);
        } finally {
            await senderDB.destroy();
            await receiverDB.destroy();
        }
    });

    it("does not fetch a remote Chunk which is already present in the local database", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const senderDB = new PouchDB<EntryDoc>("adaptive-core-existing-chunk-sender", { adapter: "memory" });
        const receiverDB = new PouchDB<EntryDoc>("adaptive-core-existing-chunk-receiver", { adapter: "memory" });
        try {
            const chunk = {
                _id: "h:adaptive-chunk" as DocumentID,
                data: "adaptive body",
                type: "leaf",
            } as EntryDoc;
            await senderDB.put(chunk);
            await senderDB.put(metadata());
            await receiverDB.put(chunk);

            const sender = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(senderDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "sender-host",
                vi.fn()
            );
            const receiverStorage = new MemoryAdaptiveObjectStorage(remote);
            const readAdaptiveObject = vi.spyOn(receiverStorage, "readAdaptiveObject");
            const receiver = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(receiverDB, currentSettings),
                receiverStorage,
                async () => "receiver-host",
                vi.fn()
            );

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);

            expect(readAdaptiveObject.mock.calls.map(([key]) => key)).not.toEqual(
                expect.arrayContaining([expect.stringMatching(/^a1~pack~/u)])
            );
            await expect(receiverDB.get("notes/adaptive.md")).resolves.toMatchObject({
                children: ["h:adaptive-chunk"],
            });

            const existingCommitKeys = new Set([...remote.objects.keys()].filter((key) => /^a1~commit~/u.test(key)));
            await expect(receiver.sendLocalJournal()).resolves.toBe(true);
            const reusedCommitKey = [...remote.objects.keys()].find(
                (key) => /^a1~commit~/u.test(key) && !existingCommitKeys.has(key)
            );
            expect(reusedCommitKey).toBeDefined();
            const reusedCommit = await decodeCommitEnvelopeV1(remote.objects.get(reusedCommitKey!)!);
            expect(reusedCommit.inlinePack).toBeUndefined();
        } finally {
            await senderDB.destroy();
            await receiverDB.destroy();
        }
    });

    it("publishes a receiver update back to the original writer", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const firstDB = new PouchDB<EntryDoc>("adaptive-core-round-trip-first", { adapter: "memory" });
        const secondDB = new PouchDB<EntryDoc>("adaptive-core-round-trip-second", { adapter: "memory" });
        const firstState = memoryStore();
        const secondState = memoryStore();
        const firstCore = () =>
            new AdaptiveJournalSyncCore(
                currentSettings,
                firstState,
                environment(firstDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "first-host",
                vi.fn()
            );
        const secondCore = () =>
            new AdaptiveJournalSyncCore(
                currentSettings,
                secondState,
                environment(secondDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "second-host",
                vi.fn()
            );
        try {
            await firstDB.put({
                _id: "h:first-chunk" as DocumentID,
                data: "first body",
                type: "leaf",
            } as EntryDoc);
            await firstDB.put({
                ...metadata(),
                children: ["h:first-chunk"],
            } as EntryDoc);
            await expect(firstCore().sync()).resolves.toBe(true);
            await expect(secondCore().sync()).resolves.toBe(true);

            const received = await secondDB.get("notes/adaptive.md");
            await secondDB.put({
                _id: "h:second-chunk" as DocumentID,
                data: "second body",
                type: "leaf",
            } as EntryDoc);
            await secondDB.put({
                ...received,
                children: ["h:second-chunk"],
                mtime: 3,
                size: 11,
            });

            await expect(secondCore().sync()).resolves.toBe(true);
            await expect(firstCore().sync()).resolves.toBe(true);
            await expect(firstDB.get("notes/adaptive.md")).resolves.toMatchObject({
                children: ["h:second-chunk"],
                mtime: 3,
                size: 11,
            });
        } finally {
            await firstDB.destroy();
            await secondDB.destroy();
        }
    });

    it("does not advance a receive frontier when a local Chunk write fails", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const senderDB = new PouchDB<EntryDoc>("adaptive-core-failed-chunk-sender", { adapter: "memory" });
        const receiverDB = new PouchDB<EntryDoc>("adaptive-core-failed-chunk-receiver", { adapter: "memory" });
        try {
            await senderDB.put({
                _id: "h:adaptive-chunk" as DocumentID,
                data: "adaptive body",
                type: "leaf",
            } as EntryDoc);
            await senderDB.put(metadata());
            const sender = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(senderDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "sender-host",
                vi.fn()
            );
            const receiver = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(receiverDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "receiver-host",
                vi.fn()
            );

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            const failedWrite = vi.spyOn(receiverDB, "bulkDocs").mockResolvedValueOnce([
                {
                    error: "forbidden",
                    id: "h:adaptive-chunk",
                    message: "simulated local write failure",
                    status: 403,
                },
            ]);

            await expect(receiver.receiveRemoteJournal()).resolves.toBe(false);
            failedWrite.mockRestore();
            await expect(receiverDB.get("notes/adaptive.md")).rejects.toMatchObject({ status: 404 });

            await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);
            await expect(receiverDB.get("notes/adaptive.md")).resolves.toMatchObject({
                _id: "notes/adaptive.md",
            });
            await expect(receiverDB.get("h:adaptive-chunk")).resolves.toMatchObject({
                _id: "h:adaptive-chunk",
            });
        } finally {
            await senderDB.destroy();
            await receiverDB.destroy();
        }
    });

    it("does not advance the local send sequence when a revision fetch fails", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const senderDB = new PouchDB<EntryDoc>("adaptive-core-failed-fetch-sender", { adapter: "memory" });
        try {
            await senderDB.put({
                _id: "h:adaptive-chunk" as DocumentID,
                data: "adaptive body",
                type: "leaf",
            } as EntryDoc);
            await senderDB.put(metadata());
            const sender = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(senderDB, currentSettings),
                new MemoryAdaptiveObjectStorage(remote),
                async () => "sender-host",
                vi.fn()
            );
            const failedFetch = vi.spyOn(senderDB, "bulkGet").mockResolvedValueOnce({
                results: [
                    {
                        docs: [
                            {
                                error: {
                                    error: "not_found",
                                    id: "notes/adaptive.md",
                                    status: 404,
                                },
                            },
                        ],
                        id: "notes/adaptive.md",
                    },
                ],
            });

            await expect(sender.sendLocalJournal()).resolves.toBe(false);
            failedFetch.mockRestore();
            expect([...remote.objects.keys()]).not.toEqual(
                expect.arrayContaining([expect.stringMatching(/^a1~commit~/u)])
            );

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            expect([...remote.objects.keys()]).toEqual(expect.arrayContaining([expect.stringMatching(/^a1~commit~/u)]));
        } finally {
            await senderDB.destroy();
        }
    });

    it.each(["opaque-v1", "mixed"] as const)(
        "refuses to open a %s remote through the Adaptive Journal engine",
        async (remoteFormat) => {
            const remote: MemoryAdaptiveRemote = { objects: new Map() };
            const currentSettings = settings();
            const database = new PouchDB<EntryDoc>(`adaptive-core-format-${remoteFormat}`, { adapter: "memory" });
            try {
                const storage = new MemoryAdaptiveObjectStorage(remote);
                vi.spyOn(storage, "inspectRemoteFormat").mockResolvedValue(remoteFormat);
                const core = new AdaptiveJournalSyncCore(
                    currentSettings,
                    memoryStore(),
                    environment(database, currentSettings),
                    storage,
                    async () => "local-host",
                    vi.fn()
                );

                await expect(core.getReplicationPBKDF2Salt()).rejects.toMatchObject({
                    code: "journal-storage-format-mismatch",
                    expectedFormat: "adaptive-v1",
                    remoteFormat,
                });
                expect(remote.manifest).toBeUndefined();
                expect(remote.objects.size).toBe(0);
            } finally {
                await database.destroy();
            }
        }
    );

    it("retains an opened repository for equivalent settings and reopens it for protocol changes", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map() };
        const currentSettings = settings();
        const database = new PouchDB<EntryDoc>("adaptive-core-equivalent-config", { adapter: "memory" });
        try {
            const localState = memoryStore();
            const currentEnvironment = environment(database, currentSettings);
            const storage = new MemoryAdaptiveObjectStorage(remote);
            const verifyCapabilities = vi.spyOn(storage, "verifyCapabilities");
            const core = new AdaptiveJournalSyncCore(
                currentSettings,
                localState,
                currentEnvironment,
                storage,
                async () => "local-host",
                vi.fn()
            );

            await expect(core.sendLocalJournal()).resolves.toBe(true);
            core.applyNewConfig(currentSettings, localState, currentEnvironment, storage);
            await expect(core.sendLocalJournal()).resolves.toBe(true);

            expect(verifyCapabilities).toHaveBeenCalledOnce();

            const rangeSettings = {
                ...currentSettings,
                packReadPolicy: "range" as const,
            };
            core.applyNewConfig(rangeSettings, localState, currentEnvironment, storage);
            await expect(core.sendLocalJournal()).resolves.toBe(true);

            expect(verifyCapabilities).toHaveBeenCalledTimes(2);
            expect(verifyCapabilities).toHaveBeenLastCalledWith(expect.arrayContaining(["byte-range"]));
        } finally {
            await database.destroy();
        }
    });

    it("allows an explicit remote rebuild without opening a mismatched repository", async () => {
        const remote: MemoryAdaptiveRemote = { objects: new Map([["opaque-object", new Uint8Array([1])]]) };
        const currentSettings = settings();
        const database = new PouchDB<EntryDoc>("adaptive-core-mismatched-rebuild", { adapter: "memory" });
        try {
            const storage = new MemoryAdaptiveObjectStorage(remote);
            const inspectRemoteFormat = vi.spyOn(storage, "inspectRemoteFormat").mockResolvedValue("opaque-v1");
            const resetJournalStorage = vi.spyOn(storage, "resetJournalStorage");
            const core = new AdaptiveJournalSyncCore(
                currentSettings,
                memoryStore(),
                environment(database, currentSettings),
                storage,
                async () => "local-host",
                vi.fn()
            );

            await expect(core.resetBucket()).resolves.toBe(true);

            expect(resetJournalStorage).toHaveBeenCalledOnce();
            expect(inspectRemoteFormat).not.toHaveBeenCalled();
            expect(remote.manifest).toBeUndefined();
            expect(remote.objects.size).toBe(0);
        } finally {
            await database.destroy();
        }
    });
});
