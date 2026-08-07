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

describe("StreamingFetch - fetchChangesForInitialSync integration", () => {
    let localDB: PouchDB.Database;
    let remoteDB: PouchDB.Database;

    beforeEach(async () => {
        localDB = new PouchDB("local_test_db_" + Date.now(), { adapter: "memory" });
        remoteDB = new PouchDB(remoteDbUrlWithAuth, { adapter: "http" });
        try {
            await remoteDB.destroy();
        } catch {
            // safe to ignore
        }
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

    it("should fetch and checkpoint all documents across a batch boundary", async () => {
        // 1. Put enough documents in the remote database to cross the 100-document batch boundary.
        const docs = Array.from({ length: 101 }, (_, index) => ({
            _id: `doc-${index.toString().padStart(3, "0")}`,
            type: "plain",
            data: `hello ${index}`,
        }));
        await remoteDB.bulkDocs(docs);
        const targetSequence = (await remoteDB.changes({ since: "now", limit: 0 })).last_seq;
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
        expect(checkpoints.at(-1)?.toString()).toBe(targetSequence.toString());
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
        const latestSeq = (await remoteDB.changes({ since: "now", limit: 0 })).last_seq;

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
