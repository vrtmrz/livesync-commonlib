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
import {
    expectAdaptiveObjectJournalLayout,
    runAdaptiveJournalTwoClientIntegration,
} from "./AdaptiveJournalIntegrationHarness.spec.ts";
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

    it.each(["whole-pack", "range"] as const)(
        "sends and receives Adaptive Metadata and Chunks with %s retrieval",
        async (packReadPolicy) => {
            const settings = s3Settings(true);
            if (!settings) return;
            settings.packReadPolicy = packReadPolicy;
            await runAdaptiveJournalTwoClientIntegration({
                inspectRemote: expectAdaptiveObjectJournalLayout,
                label: `adaptive-s3-${packReadPolicy}-journal-core`,
                settings,
            });
        }
    );
});
