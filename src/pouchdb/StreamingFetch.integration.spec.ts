/* eslint-disable */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import HttpAdapter from "pouchdb-adapter-http";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { E2EEAlgorithms, REMOTE_COUCHDB, VERSIONING_DOCID, type FilePathWithPrefix, type PlainEntry } from "@lib/common/types";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { REMOTE_RESOURCE_KINDS } from "@lib/replication";
import { path2id_base } from "@lib/string_and_binary/path";
import { ServiceRebuilder } from "@lib/serviceModules/Rebuilder";
import { getConfiguredFunctionsForEncryption } from "./encryption";
import { fetchChangesForInitialSync } from "./StreamingFetch";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(HttpAdapter);

function loadEnv() {
    const loadEnvFile = (path: string) => (existsSync(path) ? parseEnv(readFileSync(path, "utf-8")) : {});
    const defEnv = loadEnvFile(".env");
    const testEnv = loadEnvFile(".test.env");
    return Object.assign({}, defEnv, testEnv, process.env);
}

const env = loadEnv();
const hostname = env.hostname || "http://localhost:5989/";
const username = env.username || "admin";
const password = env.password || "testpassword";

const remoteDbName = "livesync-test-db-streaming";
// Build authenticated URL (e.g. http://admin:testpassword@localhost:5989/livesync-test-db-streaming)
const urlObj = new URL(hostname);
urlObj.username = username;
urlObj.password = password;
urlObj.pathname = remoteDbName;
const remoteDbUrlWithAuth = urlObj.toString();
// Raw URL without auth embedded in the URL (StreamingFetch takes raw remoteDbUrl and authHeader separately)
const remoteDbUrl = new URL(remoteDbName, hostname).toString();
const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

async function recreateTwoShardRemoteDatabase(): Promise<void> {
    const deleteResponse = await fetch(remoteDbUrl, {
        method: "DELETE",
        headers: { Authorization: authHeader },
    });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Could not delete the integration database: HTTP ${deleteResponse.status}.`);
    }

    const createUrl = new URL(remoteDbUrl);
    createUrl.searchParams.set("n", "1");
    createUrl.searchParams.set("q", "2");
    const createResponse = await fetch(createUrl, {
        method: "PUT",
        headers: { Authorization: authHeader },
    });
    if (!createResponse.ok) {
        throw new Error(`Could not create the integration database: HTTP ${createResponse.status}.`);
    }

    const infoResponse = await fetch(remoteDbUrl, { headers: { Authorization: authHeader } });
    if (!infoResponse.ok) {
        throw new Error(`Could not inspect the integration database: HTTP ${infoResponse.status}.`);
    }
    const info = (await infoResponse.json()) as { cluster?: { n?: number; q?: number } };
    expect(info.cluster).toMatchObject({ n: 1, q: 2 });
}

async function expectCheckpointHasNoPendingChanges(checkpoint: string | number | undefined): Promise<void> {
    expect(checkpoint).toBeDefined();
    const resumeUrl = new URL(`${remoteDbUrl}/_changes`);
    resumeUrl.searchParams.set("since", checkpoint!.toString());
    resumeUrl.searchParams.set("feed", "normal");
    resumeUrl.searchParams.set("limit", "1");
    resumeUrl.searchParams.set("include_docs", "false");
    const resumeResponse = await fetch(resumeUrl, { headers: { Authorization: authHeader } });
    expect(resumeResponse.ok).toBe(true);
    const resumeStatus = (await resumeResponse.json()) as { results?: unknown[]; pending?: number };
    expect(resumeStatus.results).toEqual([]);
    expect(resumeStatus.pending).toBe(0);
}

function createFastFetchRebuilder(localDatabase: PouchDB.Database) {
    const passphrase = "fast-fetch-integration-secret";
    const salt = new Uint8Array(16).fill(7);
    const settings: Record<string, any> = {
        isConfigured: true,
        remoteType: REMOTE_COUCHDB,
        couchDB_URI: hostname,
        couchDB_DBNAME: remoteDbName,
        couchDB_USER: username,
        couchDB_PASSWORD: password,
        couchDB_CustomHeaders: "",
        useRequestAPI: false,
        useJWT: false,
        passphrase,
        E2EEAlgorithm: E2EEAlgorithms.V2,
        doNotSuspendOnFetching: true,
        suspendParseReplicationResult: true,
        suspendFileWatching: true,
    };
    const smallConfig = new Map<string, string>();
    const services = {
        events: createLiveSyncEventHub(),
        appLifecycle: { resetIsReady: vi.fn() },
        API: { getAppID: vi.fn(() => "fast-fetch-integration"), addLog: vi.fn() },
        UI: {},
        setting: {
            currentSettings: vi.fn(() => settings),
            suspendExtraSync: vi.fn(async () => undefined),
            suspendAllSync: { addHandler: vi.fn() },
            applyPartial: vi.fn(async (partial: Record<string, unknown>) => Object.assign(settings, partial)),
            saveSettingData: vi.fn(async () => undefined),
            getSmallConfig: vi.fn((key: string) => smallConfig.get(key) ?? ""),
            setSmallConfig: vi.fn((key: string, value: string) => smallConfig.set(key, value)),
            deleteSmallConfig: vi.fn((key: string) => smallConfig.delete(key)),
        },
        remote: {},
        databaseEvents: {},
        storageAccess: {},
        replicator: {
            runBoundedRemoteActivity: vi.fn(async (task: () => Promise<void>) => task()),
            createRemoteResource: vi.fn(async (kind: string) =>
                kind === REMOTE_RESOURCE_KINDS.SECURITY_SEED
                    ? {
                          read: vi.fn(async () => salt),
                          dispose: vi.fn(async () => undefined),
                      }
                    : undefined
            ),
        },
        replication: { markResolved: vi.fn(async () => undefined) },
        database: {
            onDatabaseReset: { addHandler: vi.fn() },
            localDatabase: { localDatabase },
        },
        control: { applySettings: vi.fn(async () => undefined) },
        vault: {},
        fileHandler: {},
        fileProcessing: {},
    };
    const rebuilder = new ServiceRebuilder(services as any);
    const resetLocalDatabase = vi.spyOn(rebuilder, "resetLocalDatabase").mockImplementation(async () => {
        const existing = await localDatabase.allDocs({ include_docs: true });
        await Promise.all(
            existing.rows.flatMap((row) =>
                row.doc ? [localDatabase.remove(row.doc._id, row.doc._rev)] : []
            )
        );
    });
    return { rebuilder, services, settings, passphrase, salt, resetLocalDatabase };
}

async function createInternalMetadata(path: string, passphrase: string): Promise<PlainEntry> {
    const filePath = path as FilePathWithPrefix;
    return {
        _id: await path2id_base(filePath, passphrase, false),
        path: filePath,
        type: "plain",
        ctime: 10,
        mtime: 20,
        size: 30,
        children: ["h:+internal-chunk"],
        eden: {},
    };
}

describe("StreamingFetch - fetchChangesForInitialSync integration", () => {
    let localDB: PouchDB.Database;
    let remoteDB: PouchDB.Database;

    beforeEach(async () => {
        localDB = new PouchDB("local_test_db_" + Date.now(), { adapter: "memory" });
        await recreateTwoShardRemoteDatabase();
        remoteDB = new PouchDB(remoteDbUrlWithAuth, { adapter: "http" });
        await remoteDB.info();
    });

    afterEach(async () => {
        try {
            await localDB.destroy();
        } catch {
            // safe to ignore
        }
        try {
            await remoteDB.destroy();
        } catch {
            // safe to ignore
        }
    });

    it("should fetch and checkpoint all documents across a batch boundary on two shards", async () => {
        // 1. Put enough documents in the remote database to cross the 100-document batch boundary.
        const docs = Array.from({ length: 101 }, (_, index) => ({
            _id: `doc-${index.toString().padStart(3, "0")}`,
            type: "plain",
            data: `hello ${index}`,
        }));
        await remoteDB.bulkDocs(docs);
        const checkpoints: Array<string | number> = [];

        // 2. Perform streaming fetch
        await fetchChangesForInitialSync(
            localDB,
            remoteDbUrl,
            authHeader,
            (doc) => Promise.resolve(doc as any),
            "0",
            () => {},
            (sequence) => checkpoints.push(sequence)
        );

        // 3. Verify documents in local database
        const localDocs = await localDB.allDocs({ include_docs: true });
        expect(localDocs.rows.length).toBe(docs.length);
        expect(localDocs.rows.map((row) => row.id).sort()).toEqual(docs.map((doc) => doc._id));
        await expectCheckpointHasNoPendingChanges(checkpoints.at(-1));
    });

    it("should count a deletion tombstone as one bounded changes row", async () => {
        await remoteDB.put({ _id: "retained-document", type: "plain", data: "keep" });
        const deletedDocument = await remoteDB.put({ _id: "deleted-document", type: "plain", data: "remove" });
        await remoteDB.remove("deleted-document", deletedDocument.rev);
        const checkpoints: Array<string | number> = [];
        const progress: Array<{ totalFetched: number; docsToFetch: number }> = [];

        await fetchChangesForInitialSync(
            localDB,
            remoteDbUrl,
            authHeader,
            (doc) => Promise.resolve(doc as any),
            "0",
            (current) => progress.push(current),
            (sequence) => checkpoints.push(sequence)
        );

        await expect(localDB.get("retained-document")).resolves.toMatchObject({ data: "keep" });
        const deletedRows = await localDB.allDocs({ keys: ["deleted-document"] });
        expect(deletedRows.rows[0]).toMatchObject({ value: { deleted: true } });
        expect(progress.at(-1)).toMatchObject({ totalFetched: 2, docsToFetch: 2 });
        await expectCheckpointHasNoPendingChanges(checkpoints.at(-1));
    });

    it("should tolerate a tombstone whose id is an obfuscated entry", async () => {
        await remoteDB.put({ _id: "f:retained-file", type: "file", path: "notes/keep.md", data: "keep" });
        const deletedFile = await remoteDB.put({ _id: "f:deleted-file", type: "file", path: "notes/remove.md", data: "remove" });
        await remoteDB.remove("f:deleted-file", deletedFile.rev);
        const checkpoints: Array<string | number> = [];

        // Mimic the E2EE decryption contract: obfuscated entries (f: ids) must
        // carry a path to decrypt. A tombstone has no path, so a real
        // implementation throws for it. The fetch must still complete and
        // record the deletion instead of aborting at the tombstone.
        const decryptFunction = (doc: any) => {
            if (doc._id.startsWith("f:") && doc.path === undefined) {
                return Promise.reject(new Error("Entry has been obfuscated!"));
            }
            return Promise.resolve(doc);
        };

        await fetchChangesForInitialSync(
            localDB,
            remoteDbUrl,
            authHeader,
            decryptFunction,
            "0",
            () => {},
            (sequence) => checkpoints.push(sequence)
        );

        await expect(localDB.get("f:retained-file")).resolves.toMatchObject({ path: "notes/keep.md" });
        const deletedRows = await localDB.allDocs({ keys: ["f:deleted-file"] });
        expect(deletedRows.rows[0]).toMatchObject({ value: { deleted: true } });
        await expectCheckpointHasNoPendingChanges(checkpoints.at(-1));
    });

    it("should handle empty database gracefully", async () => {
        // Perform streaming fetch on empty database
        await fetchChangesForInitialSync(localDB, remoteDbUrl, authHeader, (doc) => Promise.resolve(doc as any), "0");

        const localDocs = await localDB.allDocs();
        expect(localDocs.rows.length).toBe(0);
    });

    it("should exit immediately if already at the target sequence", async () => {
        // 1. Populate remote database
        const docs = [{ _id: "doc1", type: "plain", data: "hello" }];
        await remoteDB.bulkDocs(docs);

        // Get the latest sequence
        const latestSeq = (await remoteDB.changes({ since: "now", limit: 1 })).last_seq;

        // 2. Perform streaming fetch with "since" set to the latest sequence
        await fetchChangesForInitialSync(
            localDB,
            remoteDbUrl,
            authHeader,
            (doc) => Promise.resolve(doc as any),
            latestSeq
        );

        // Since we started from latestSeq, no documents should be fetched
        const localDocs = await localDB.allDocs();
        expect(localDocs.rows.length).toBe(0);
    });

    it("rejects an unknown feature over HTTP before resetting local data", async () => {
        await remoteDB.put({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["future-index-v2"],
        } as any);
        await localDB.put({ _id: "existing-local-sentinel", type: "plain", data: "keep" } as any);
        const { rebuilder, services, resetLocalDatabase } = createFastFetchRebuilder(localDB);

        await expect(rebuilder.$fetchLocalDBFast(false)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("future-index-v2"),
        });

        expect(resetLocalDatabase).not.toHaveBeenCalled();
        await expect(localDB.get("existing-local-sentinel")).resolves.toMatchObject({ data: "keep" });
        expect(services.replication.markResolved).not.toHaveBeenCalled();
    });

    it("accepts generation 12 over HTTP and completes Fast Fetch", async () => {
        await remoteDB.put({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 12,
        } as any);
        await remoteDB.put({ _id: "generation-12-document", type: "plain", data: "legacy" } as any);
        const { rebuilder, services, resetLocalDatabase } = createFastFetchRebuilder(localDB);

        await rebuilder.$fetchLocalDBFast(false);

        expect(resetLocalDatabase).toHaveBeenCalledOnce();
        await expect(localDB.get("generation-12-document")).resolves.toMatchObject({ data: "legacy" });
        expect(services.replication.markResolved).toHaveBeenCalledOnce();
    });

    it("preflights generation 13, resets local state, then decrypts encrypted and plain internal Metadata", async () => {
        const { rebuilder, services, passphrase, salt, resetLocalDatabase } = createFastFetchRebuilder(localDB);
        await remoteDB.put({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["encrypted-internal-metadata-v1"],
        } as any);
        const encryptedExpected = await createInternalMetadata("i:.obsidian/private/encrypted.json", passphrase);
        const plainExpected = await createInternalMetadata("i:.obsidian/private/plain.json", passphrase);
        const encryptedIncoming = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            true
        );
        const plainIncoming = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const encrypted = await encryptedIncoming.incoming(encryptedExpected);
        const plain = await plainIncoming.incoming(plainExpected);
        expect("path" in encrypted && encrypted.path.startsWith("/\\:")).toBe(true);
        expect("path" in plain && plain.path).toBe(plainExpected.path);
        await remoteDB.put(encrypted as any);
        await remoteDB.put(plain as any);
        await localDB.put({ _id: "existing-local-sentinel", type: "plain", data: "remove" } as any);

        await rebuilder.$fetchLocalDBFast(false);

        expect(resetLocalDatabase).toHaveBeenCalledOnce();
        await expect(localDB.get("existing-local-sentinel")).rejects.toMatchObject({ status: 404 });
        await expect(localDB.get(encryptedExpected._id)).resolves.toMatchObject(encryptedExpected);
        await expect(localDB.get(plainExpected._id)).resolves.toMatchObject(plainExpected);
        expect(services.replication.markResolved).toHaveBeenCalledOnce();
    });
});
