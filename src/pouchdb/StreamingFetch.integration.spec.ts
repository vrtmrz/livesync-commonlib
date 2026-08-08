/* eslint-disable */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import HttpAdapter from "pouchdb-adapter-http";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
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

    it("should complete when a feed-level target differs from the final two-shard row sequence", async () => {
        await remoteDB.put({ _id: "single-shard-change", type: "plain", data: "hello" });
        const remoteChanges = await remoteDB.changes({ since: "0" });
        const targetUrl = new URL(`${remoteDbUrl}/_changes`);
        targetUrl.searchParams.set("feed", "normal");
        targetUrl.searchParams.set("since", "now");
        targetUrl.searchParams.set("limit", "1");
        targetUrl.searchParams.set("include_docs", "false");
        const targetResponse = await fetch(targetUrl, { headers: { Authorization: authHeader } });
        expect(targetResponse.ok).toBe(true);
        const targetSequence = ((await targetResponse.json()) as { last_seq: string | number }).last_seq;
        const finalRowSequence = remoteChanges.results.at(-1)?.seq;
        expect(finalRowSequence).toBeDefined();
        expect(finalRowSequence?.toString()).not.toBe(targetSequence.toString());
        const checkpoints: Array<string | number> = [];

        await fetchChangesForInitialSync(
            localDB,
            remoteDbUrl,
            authHeader,
            (doc) => Promise.resolve(doc as any),
            "0",
            () => {},
            (sequence) => checkpoints.push(sequence)
        );

        await expect(localDB.get("single-shard-change")).resolves.toMatchObject({ data: "hello" });
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
});
