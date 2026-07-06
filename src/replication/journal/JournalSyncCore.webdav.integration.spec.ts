import { afterEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import {
    DEFAULT_SETTINGS,
    REMOTE_WEBDAV,
    type DocumentID,
    type EntryDoc,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { WebDAVStorageAdapter } from "./objectstore/WebDAVStorageAdapter.ts";
import { CheckPointInfoDefault, type CheckPointInfo } from "./JournalSyncTypes.ts";
import type { SimpleStore } from "@lib/common/utils.ts";

PouchDB.plugin(MemoryAdapter);

function createStore(): SimpleStore<CheckPointInfo> {
    const values = new Map<string, CheckPointInfo>();
    const freshDefault = (): CheckPointInfo => ({
        ...CheckPointInfoDefault,
        knownIDs: new Set<string>(),
        sentIDs: new Set<string>(),
        receivedFiles: new Set<string>(),
        sentFiles: new Set<string>(),
    });
    return {
        get: (key: DocumentID) => Promise.resolve(values.get(key) ?? freshDefault()),
        set: (key: DocumentID, value: CheckPointInfo) => {
            values.set(key, value);
            return Promise.resolve();
        },
        delete: (key: DocumentID) => {
            values.delete(key);
            return Promise.resolve();
        },
        keys: () => Promise.resolve(Array.from(values.keys()) as DocumentID[]),
    } as unknown as SimpleStore<CheckPointInfo>;
}

function buildConnectionURI(): string {
    if (process.env.webDAVactiveConnectionURI) {
        const separator = process.env.webDAVactiveConnectionURI.includes("?") ? "&" : "?";
        return `${process.env.webDAVactiveConnectionURI}${separator}prefix=journal-core-${Date.now()}%2F`;
    }
    if (!process.env.webdavEndpoint || !process.env.webdavUsername || !process.env.webdavPassword) {
        return "";
    }
    const endpoint = new URL(process.env.webdavEndpoint);
    return `sls+webdav://${encodeURIComponent(process.env.webdavUsername)}:${encodeURIComponent(process.env.webdavPassword)}@${
        endpoint.host
    }${endpoint.pathname}?prefix=journal-core-${Date.now()}%2F&insecure=${
        endpoint.protocol === "http:" ? "true" : "false"
    }`;
}

function makeEnv(db: PouchDB.Database<EntryDoc>, settings: typeof DEFAULT_SETTINGS): LiveSyncJournalReplicatorEnv {
    // eslint-disable-next-line obsidianmd/no-global-this
    const fetchForTest = globalThis.fetch.bind(globalThis);
    return {
        services: {
            database: {
                localDatabase: {
                    localDatabase: db,
                },
            },
            setting: {
                currentSettings: () => settings,
            },
            replication: {
                parseSynchroniseResult: () => Promise.resolve(true),
            },
            API: {
                webCompatFetch: fetchForTest,
                nativeFetch: fetchForTest,
            },
            replicator: {
                replicationStatics: {
                    value: {
                        sent: 0,
                        arrived: 0,
                        maxPullSeq: 0,
                        maxPushSeq: 0,
                        lastSyncPullSeq: 0,
                        lastSyncPushSeq: 0,
                        syncStatus: "NOT_CONNECTED",
                    },
                },
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
}

describe("JournalSyncCore WebDAV Integration Tests", () => {
    const connectionURI = buildConnectionURI();
    const isIntegrationEnvironmentReady = connectionURI !== "";
    const dbs: PouchDB.Database<EntryDoc>[] = [];

    afterEach(async () => {
        await Promise.all(dbs.splice(0).map((db) => db.destroy()));
    });

    it.runIf(isIntegrationEnvironmentReady)("should send and receive journal packs through WebDAV", async () => {
        const senderDB = new PouchDB<EntryDoc>(`webdav_sender_${Date.now()}`, { adapter: "memory" });
        const receiverDB = new PouchDB<EntryDoc>(`webdav_receiver_${Date.now()}`, { adapter: "memory" });
        dbs.push(senderDB, receiverDB);

        const settings = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: connectionURI,
        };

        const senderEnv = makeEnv(senderDB, settings);
        const receiverEnv = makeEnv(receiverDB, settings);
        const senderStorage = new WebDAVStorageAdapter(settings, senderEnv);
        const receiverStorage = new WebDAVStorageAdapter(settings, receiverEnv);
        const sender = new JournalSyncCore(settings, createStore(), senderEnv, senderStorage);
        const receiver = new JournalSyncCore(settings, createStore(), receiverEnv, receiverStorage);

        await sender.resetBucket();
        await senderDB.bulkDocs(
            [
                {
                    _id: "webdav_doc" as DocumentID,
                    _rev: "1-webdavrev",
                    _revisions: {
                        start: 1,
                        ids: ["webdavrev"],
                    },
                    type: "plain",
                    path: "webdav_doc.md" as FilePathWithPrefix,
                    children: [],
                    ctime: Date.now(),
                    mtime: Date.now(),
                    size: 0,
                    eden: {},
                } as PlainEntry,
            ],
            { new_edits: false }
        );

        expect(await sender.sendLocalJournal(true)).toBe(true);
        expect(await receiver.receiveRemoteJournal(true)).toBe(true);

        const received = await receiverDB.get("webdav_doc");
        expect(received).toBeDefined();
        expect(received.type).toBe("plain");

        await sender.resetBucket();
    });

    it("skips tests if WebDAV environment variables are not set", () => {
        if (!isIntegrationEnvironmentReady) {
            console.warn(
                "Skipping JournalSyncCore WebDAV integration tests. Please set webDAVactiveConnectionURI or webdavEndpoint, webdavUsername, and webdavPassword."
            );
        }
        expect(true).toBe(true);
    });
});
