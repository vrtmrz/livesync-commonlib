import { afterEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

import {
    DEFAULT_SETTINGS,
    REMOTE_MINIO,
    type DocumentID,
    type EntryDoc,
    type FilePathWithPrefix,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import type { SimpleStore } from "@lib/common/utils.ts";
import { AdaptiveJournalSyncCore } from "./AdaptiveJournalSyncCore.ts";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "./adaptive/AdaptiveJournalManifest.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type { CheckPointInfo } from "./JournalSyncTypes.ts";
import { createJournalStorageAdapter } from "./objectstore/JournalStorageAdapterFactory.ts";

PouchDB.plugin(MemoryAdapter);

function createStore<T>(): SimpleStore<T> {
    const values = new Map<string, T>();
    return {
        delete: async (key: string) => void values.delete(key),
        get: async (key: string) => values.get(key),
        keys: async () => [...values.keys()],
        set: async (key: string, value: T) => void values.set(key, value),
    } as unknown as SimpleStore<T>;
}

function makeEnv(db: PouchDB.Database<EntryDoc>, settings: RemoteDBSettings): LiveSyncJournalReplicatorEnv {
    return {
        services: {
            API: {
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
            },
            context: {
                events: {
                    emitEvent: () => undefined,
                },
            },
            database: {
                localDatabase: {
                    localDatabase: db,
                },
            },
            replication: {
                parseSynchroniseResult: async () => true,
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

function s3Settings(adaptive: boolean): RemoteDBSettings | undefined {
    if (!process.env.minioEndpoint || !process.env.accessKey || !process.env.secretKey || !process.env.bucketName) {
        return undefined;
    }
    return {
        ...DEFAULT_SETTINGS,
        accessKey: process.env.accessKey,
        bucket: process.env.bucketName,
        bucketCustomHeaders: "",
        bucketPrefix: `${adaptive ? "adaptive-" : "opaque-"}journal-core-${process.pid}-${Date.now()}/`,
        endpoint: process.env.minioEndpoint,
        forcePathStyle: true,
        journalFormat: adaptive ? "adaptive-v1" : "opaque-v1",
        packReadPolicy: adaptive ? "range" : "whole-pack",
        region: "us-east-1",
        remoteType: REMOTE_MINIO,
        secretKey: process.env.secretKey,
        useCustomRequestHandler: false,
    };
}

describe("S3 Journal core integration", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];

    afterEach(async () => {
        await Promise.all(databases.splice(0).map((database) => database.destroy()));
    });

    it("sends and receives Opaque Journal packs", async () => {
        const settings = s3Settings(false);
        if (!settings) return;

        const unique = `opaque-s3-${process.pid}-${Date.now()}`;
        const senderDatabase = new PouchDB<EntryDoc>(`${unique}-sender`, { adapter: "memory" });
        const receiverDatabase = new PouchDB<EntryDoc>(`${unique}-receiver`, { adapter: "memory" });
        databases.push(senderDatabase, receiverDatabase);
        const senderEnvironment = makeEnv(senderDatabase, settings);
        const receiverEnvironment = makeEnv(receiverDatabase, settings);
        const sender = new JournalSyncCore(
            settings,
            createStore<CheckPointInfo>(),
            senderEnvironment,
            createJournalStorageAdapter(settings, senderEnvironment)
        );
        const receiver = new JournalSyncCore(
            settings,
            createStore<CheckPointInfo>(),
            receiverEnvironment,
            createJournalStorageAdapter(settings, receiverEnvironment)
        );

        try {
            await sender.resetBucket();
            const documentId = `${unique}-document` as DocumentID;
            await senderDatabase.put({
                _id: documentId,
                children: [],
                ctime: Date.now(),
                mtime: Date.now(),
                path: `${unique}.md` as FilePathWithPrefix,
                size: 0,
                type: "newnote",
            } as EntryDoc);

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);
            await expect(receiverDatabase.get(documentId)).resolves.toMatchObject({
                _id: documentId,
                type: "newnote",
            });
        } finally {
            await sender.resetBucket();
        }
    });

    it("sends and receives Adaptive Metadata and Chunks", async () => {
        const settings = s3Settings(true);
        if (!settings) return;

        const unique = `adaptive-s3-${process.pid}-${Date.now()}`;
        const senderDatabase = new PouchDB<EntryDoc>(`${unique}-sender`, { adapter: "memory" });
        const receiverDatabase = new PouchDB<EntryDoc>(`${unique}-receiver`, { adapter: "memory" });
        databases.push(senderDatabase, receiverDatabase);
        const senderEnvironment = makeEnv(senderDatabase, settings);
        const receiverEnvironment = makeEnv(receiverDatabase, settings);
        const senderStorage = createJournalStorageAdapter(settings, senderEnvironment);
        const sender = new AdaptiveJournalSyncCore(
            settings,
            createStore<unknown>(),
            senderEnvironment,
            senderStorage,
            async () => `${unique}-sender`,
            async (documents) => await senderEnvironment.services.replication.parseSynchroniseResult(documents)
        );
        const receiver = new AdaptiveJournalSyncCore(
            settings,
            createStore<unknown>(),
            receiverEnvironment,
            createJournalStorageAdapter(settings, receiverEnvironment),
            async () => `${unique}-receiver`,
            async (documents) => await receiverEnvironment.services.replication.parseSynchroniseResult(documents)
        );

        try {
            await sender.resetBucket();
            await expect(
                senderStorage.verifyCapabilities?.([...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1, "byte-range"])
            ).resolves.toEqual({ status: "verified" });
            const chunkId = `h:${unique}-chunk` as DocumentID;
            const documentId = `${unique}-document` as DocumentID;
            await senderDatabase.bulkDocs([
                {
                    _id: chunkId,
                    data: "adaptive integration body",
                    type: "leaf",
                } as EntryDoc,
                {
                    _id: documentId,
                    children: [chunkId],
                    ctime: Date.now(),
                    mtime: Date.now(),
                    path: `${unique}.md` as FilePathWithPrefix,
                    size: 25,
                    type: "newnote",
                } as EntryDoc,
            ]);

            await expect(sender.sendLocalJournal()).resolves.toBe(true);
            await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);
            await expect(receiverDatabase.get(documentId)).resolves.toMatchObject({
                _id: documentId,
                children: [chunkId],
                type: "newnote",
            });
            await expect(receiverDatabase.get(chunkId)).resolves.toMatchObject({
                _id: chunkId,
                data: "adaptive integration body",
                type: "leaf",
            });
        } finally {
            await sender.resetBucket();
        }
    });
});
