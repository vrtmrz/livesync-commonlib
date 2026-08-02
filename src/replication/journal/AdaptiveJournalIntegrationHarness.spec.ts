import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { expect } from "vitest";

import { type DocumentID, type EntryDoc, type FilePathWithPrefix, type RemoteDBSettings } from "@lib/common/types.ts";
import type { SimpleStore } from "@lib/common/utils.ts";
import { AdaptiveJournalSyncCore } from "./AdaptiveJournalSyncCore.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type { AdaptiveJournalManifestRemoteV1 } from "./adaptive/AdaptiveJournalRepository.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";
import { createJournalStorageAdapter } from "./objectstore/JournalStorageAdapterFactory.ts";

PouchDB.plugin(MemoryAdapter);

export interface AdaptiveJournalIntegrationInspection {
    readonly repositoryId: string;
    readonly storage: IJournalStorage;
}

export interface AdaptiveJournalIntegrationOptions {
    readonly inspectRemote?: (inspection: AdaptiveJournalIntegrationInspection) => Promise<void>;
    readonly label: string;
    readonly settings: RemoteDBSettings;
}

export async function expectAdaptiveObjectJournalLayout({
    repositoryId,
    storage,
}: AdaptiveJournalIntegrationInspection): Promise<void> {
    const keys = await storage.listFiles("");
    expect(keys.filter((key) => key.startsWith("a1~writer~"))).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith("a1~commit~")).length).toBeGreaterThanOrEqual(3);
    expect(keys.some((key) => key.startsWith("a1~probe~"))).toBe(false);
    expect(
        keys.some((key) => key.startsWith("a1~delta~") || key.startsWith("a1~index~") || key.startsWith("a1~metadata~"))
    ).toBe(false);
    expect(keys).not.toContain("_00000000-milestone.json");
    const manifest = await storage.download("a1~manifest.json", true);
    expect(manifest).not.toBe(false);
    if (manifest === false) throw new Error("Adaptive object-store manifest was not readable");
    expect(JSON.parse(new TextDecoder().decode(manifest))).toMatchObject({
        format: "adaptive-journal",
        objectLayout: "commit-bundle-v1",
        repositoryId,
    });
}

function createStore<T>(): SimpleStore<T> {
    const values = new Map<string, T>();
    return {
        delete: async (key: string): Promise<void> => void values.delete(key),
        get: async (key: string): Promise<T | undefined> => values.get(key),
        keys: async (): Promise<string[]> => [...values.keys()],
        set: async (key: string, value: T): Promise<void> => void values.set(key, value),
    } as unknown as SimpleStore<T>;
}

function makeEnv(db: PouchDB.Database<EntryDoc>, settings: RemoteDBSettings): LiveSyncJournalReplicatorEnv {
    return {
        services: {
            API: {
                nativeFetch: globalThis.fetch.bind(globalThis),
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
                webCompatFetch: globalThis.fetch.bind(globalThis),
            },
            context: {
                events: {
                    emitEvent: (): void => undefined,
                },
            },
            database: {
                localDatabase: {
                    localDatabase: db,
                },
            },
            replication: {
                parseSynchroniseResult: async (): Promise<boolean> => true,
            },
            replicator: {
                replicationStatics: reactiveSource({
                    arrived: 0,
                    lastSyncPullSeq: 0,
                    lastSyncPushSeq: 0,
                    maxPullSeq: 0,
                    maxPushSeq: 0,
                    sent: 0,
                    syncStatus: "NOT_CONNECTED",
                }),
            },
            setting: {
                currentSettings: () => settings,
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
}

function createCore(
    clientId: string,
    database: PouchDB.Database<EntryDoc>,
    settings: RemoteDBSettings,
    state: SimpleStore<unknown>
): { core: AdaptiveJournalSyncCore; storage: IJournalStorage } {
    const environment = makeEnv(database, settings);
    const storage = createJournalStorageAdapter(settings, environment);
    return {
        core: new AdaptiveJournalSyncCore(
            settings,
            state,
            environment,
            storage,
            async () => clientId,
            async (documents) => await environment.services.replication.parseSynchroniseResult(documents)
        ),
        storage,
    };
}

async function readRepositoryId(storage: IJournalStorage): Promise<string> {
    const remote = storage as IJournalStorage & Partial<AdaptiveJournalManifestRemoteV1>;
    if (!remote.readManifest) throw new Error("Adaptive integration storage does not expose its manifest");
    const manifest = await remote.readManifest();
    expect(manifest.status).toBe("found");
    if (manifest.status !== "found") throw new Error("Adaptive integration manifest was not readable");
    const repositoryId = (JSON.parse(new TextDecoder().decode(manifest.value)) as { repositoryId?: unknown })
        .repositoryId;
    expect(repositoryId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (typeof repositoryId !== "string") throw new Error("Adaptive integration manifest has no repository ID");
    return repositoryId;
}

async function putChunkBackedDocument(
    database: PouchDB.Database<EntryDoc>,
    unique: string,
    suffix: string,
    data: string,
    reusedChunkId?: DocumentID
): Promise<{ chunkId: DocumentID; documentId: DocumentID }> {
    const chunkId = reusedChunkId ?? (`h:${unique}-${suffix}-chunk` as DocumentID);
    const documentId = `${unique}-${suffix}-document` as DocumentID;
    const documents: EntryDoc[] = [];
    if (!reusedChunkId) {
        documents.push({ _id: chunkId, data, type: "leaf" } as EntryDoc);
    }
    const now = Date.now();
    documents.push({
        _id: documentId,
        children: [chunkId],
        ctime: now,
        mtime: now,
        path: `${unique}-${suffix}.md` as FilePathWithPrefix,
        size: new TextEncoder().encode(data).byteLength,
        type: "newnote",
    } as unknown as EntryDoc);
    await database.bulkDocs<EntryDoc>(documents as unknown as PouchDB.Core.PutDocument<EntryDoc>[]);
    return { chunkId, documentId };
}

async function expectDocumentAndChunk(
    database: PouchDB.Database<EntryDoc>,
    documentId: DocumentID,
    chunkId: DocumentID,
    data: string
): Promise<void> {
    await expect(database.get(documentId)).resolves.toMatchObject({
        _id: documentId,
        children: [chunkId],
        type: "newnote",
    });
    await expect(database.get(chunkId)).resolves.toMatchObject({
        _id: chunkId,
        data,
        type: "leaf",
    });
}

export async function runAdaptiveJournalTwoClientIntegration({
    inspectRemote,
    label,
    settings,
}: AdaptiveJournalIntegrationOptions): Promise<void> {
    const unique = `${label}-${process.pid}-${Date.now()}`;
    const senderDatabase = new PouchDB<EntryDoc>(`${unique}-sender`, { adapter: "memory" });
    const receiverDatabase = new PouchDB<EntryDoc>(`${unique}-receiver`, { adapter: "memory" });
    const mismatchedDatabase = new PouchDB<EntryDoc>(`${unique}-mismatched`, { adapter: "memory" });
    const senderState = createStore<unknown>();
    const receiverState = createStore<unknown>();
    const senderSettings = { ...settings };
    const receiverSettings = { ...settings };
    let sender = createCore(`${unique}-sender`, senderDatabase, senderSettings, senderState);
    let receiver = createCore(`${unique}-receiver`, receiverDatabase, receiverSettings, receiverState);

    try {
        await expect(sender.core.resetBucket()).resolves.toBe(true);

        const textData = "Adaptive integration body\nwith reusable text.";
        const text = await putChunkBackedDocument(senderDatabase, unique, "text", textData);
        await expect(sender.core.sendLocalJournal()).resolves.toBe(true);
        await expect(receiver.core.receiveRemoteJournal()).resolves.toBe(true);
        await expectDocumentAndChunk(receiverDatabase, text.documentId, text.chunkId, textData);

        const repositoryId = await readRepositoryId(sender.storage);
        senderSettings.expectedRepositoryId = repositoryId;
        receiverSettings.expectedRepositoryId = repositoryId;

        sender = createCore(`${unique}-sender`, senderDatabase, senderSettings, senderState);
        receiver = createCore(`${unique}-receiver`, receiverDatabase, receiverSettings, receiverState);

        const binaryData = "\u0000\u0001\u0002\u00ff\ud83d\udca0\nencoded-binary-payload";
        const binary = await putChunkBackedDocument(receiverDatabase, unique, "binary", binaryData);
        await expect(receiver.core.sendLocalJournal()).resolves.toBe(true);
        await expect(sender.core.receiveRemoteJournal()).resolves.toBe(true);
        await expectDocumentAndChunk(senderDatabase, binary.documentId, binary.chunkId, binaryData);

        const reused = await putChunkBackedDocument(senderDatabase, unique, "reused", textData, text.chunkId);
        await expect(sender.core.sendLocalJournal()).resolves.toBe(true);
        await expect(receiver.core.receiveRemoteJournal()).resolves.toBe(true);
        await expectDocumentAndChunk(receiverDatabase, reused.documentId, text.chunkId, textData);

        await inspectRemote?.({ repositoryId, storage: sender.storage });

        const mismatchedSettings = {
            ...settings,
            expectedRepositoryId: repositoryId === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43),
        };
        const mismatched = createCore(
            `${unique}-mismatched`,
            mismatchedDatabase,
            mismatchedSettings,
            createStore<unknown>()
        );
        await expect(mismatched.core.receiveRemoteJournal()).resolves.toBe(false);
    } finally {
        await sender.core.resetBucket().catch((): undefined => undefined);
        await Promise.all([senderDatabase.destroy(), receiverDatabase.destroy(), mismatchedDatabase.destroy()]);
    }
}
