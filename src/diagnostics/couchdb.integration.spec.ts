import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import {
    DEFAULT_SETTINGS,
    DEFAULT_SYNC_PARAMETERS,
    DOCID_SYNC_PARAMETERS,
    E2EEAlgorithms,
    type DocumentID,
    type EntryDoc,
    type FilePathWithPrefix,
    type PlainEntry,
    type RemoteDBSettings,
} from "../common/types.ts";
import { getConfiguredFunctionsForEncryption } from "../pouchdb/encryption.ts";
import { path2id_base } from "../string_and_binary/path.ts";
import { createCouchDBDiagnosticSource } from "./couchdb.ts";

function loadEnvironment() {
    const loadEnvFile = (path: string) => (existsSync(path) ? parseEnv(readFileSync(path, "utf-8")) : {});
    return Object.assign({}, loadEnvFile(".env"), loadEnvFile(".test.env"), process.env);
}

const env = loadEnvironment();
const hostname = env.hostname || "http://localhost:5989/";
const username = env.username || "admin";
const password = env.password || "testpassword";
const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const databaseName = `livesync-diagnostics-${process.pid}-${randomUUID()}`;
const databaseUrl = new URL(databaseName, hostname).toString().replace(/\/$/, "");
const jsonHeaders = { authorization: authHeader, "content-type": "application/json" };

function documentUrl(id: string): string {
    const encodedId = id.startsWith("_local/") ? id : encodeURIComponent(id);
    return `${databaseUrl}/${encodedId}`;
}

async function expectHttpSuccess(response: Response, operation: string): Promise<void> {
    expect(response.ok, `${operation} returned HTTP ${response.status}`).toBe(true);
}

async function getJSON<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { authorization: authHeader } });
    await expectHttpSuccess(response, "CouchDB fixture read");
    return (await response.json()) as T;
}

async function putDocument(id: string, document: object): Promise<void> {
    const response = await fetch(documentUrl(id), {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify(document),
    });
    await expectHttpSuccess(response, "CouchDB fixture document write");
}

async function readDatabaseInfo(): Promise<{ update_seq?: string | number }> {
    return await getJSON<{ update_seq?: string | number }>(databaseUrl);
}

describe("CouchDB diagnostic reader integration", () => {
    it("reads encrypted records with the existing Security Seed and stays read-only", async () => {
        const serverInfo = await getJSON<{ version?: string }>(new URL("/", hostname).toString());
        expect(serverInfo.version).toBe("3.5.0");

        let databaseCreated = false;
        let closeSource: (() => Promise<void>) | undefined;
        try {
            const databaseResponse = await fetch(databaseUrl, {
                method: "PUT",
                headers: { authorization: authHeader },
            });
            await expectHttpSuccess(databaseResponse, "CouchDB diagnostics database creation");
            databaseCreated = true;

            const passphrase = "couchdb-diagnostics-integration-secret";
            const salt = new Uint8Array(16).fill(13);
            const securitySeed = {
                ...DEFAULT_SYNC_PARAMETERS,
                pbkdf2salt: Buffer.from(salt).toString("base64"),
            };
            await putDocument(DOCID_SYNC_PARAMETERS, securitySeed);

            const path = "Diagnostics/Private integration note.md" as FilePathWithPrefix;
            const chunkId = "h:+diagnostics-integration-chunk" as DocumentID;
            const metadata: PlainEntry = {
                _id: await path2id_base(path, passphrase, false),
                path,
                type: "plain",
                ctime: 10,
                mtime: 20,
                size: 31,
                children: [chunkId],
                eden: {},
            };
            const chunk = {
                _id: chunkId,
                type: "leaf",
                data: "private integration chunk contents",
            } as EntryDoc;
            const incoming = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                async () => salt,
                E2EEAlgorithms.V2,
                false,
                () => {}
            ).incoming;
            const encryptedMetadata = await incoming(metadata);
            const encryptedChunk = await incoming(chunk as Parameters<typeof incoming>[0]);
            expect("path" in encryptedMetadata && encryptedMetadata.path.startsWith("/\\:")).toBe(true);
            expect("data" in encryptedChunk).toBe(true);
            if ("data" in encryptedChunk) {
                expect(encryptedChunk.data).not.toBe("private integration chunk contents");
            }
            await putDocument(metadata._id, encryptedMetadata);
            await putDocument(chunkId, encryptedChunk);

            const storedSeed = await getJSON<Record<string, unknown>>(documentUrl(DOCID_SYNC_PARAMETERS));
            const readerRequests: { url: string; method?: string }[] = [];
            const readerFetch = vi.fn(async (url: string, options: RequestInit) => {
                readerRequests.push({ url, method: options.method });
                return await fetch(url, options);
            });
            const settings: RemoteDBSettings = {
                ...DEFAULT_SETTINGS,
                couchDB_URI: hostname,
                couchDB_DBNAME: databaseName,
                couchDB_USER: username,
                couchDB_PASSWORD: password,
                couchDB_CustomHeaders: "",
                encrypt: true,
                passphrase,
                E2EEAlgorithm: E2EEAlgorithms.V2,
            };
            const source = createCouchDBDiagnosticSource({ settings, fetch: readerFetch });
            closeSource = () => source.close();
            const sequenceBefore = (await source.info()).update_seq;
            expect(sequenceBefore).toBeDefined();

            const ids: string[] = [];
            for await (const id of source.enumerateIds()) ids.push(id);
            expect(ids).toEqual(expect.arrayContaining([metadata._id, chunkId]));
            expect(ids).not.toContain(DOCID_SYNC_PARAMETERS);
            expect(await source.get(metadata._id)).toMatchObject(metadata);
            expect(await source.get(chunkId)).toMatchObject(chunk);
            const sequenceAfter = (await source.info()).update_seq;
            const seedAfter = await getJSON<Record<string, unknown>>(documentUrl(DOCID_SYNC_PARAMETERS));
            expect(sequenceAfter).toBe(sequenceBefore);
            expect(seedAfter).toEqual(storedSeed);

            await source.close();
            const requestCountAfterClose = readerRequests.length;
            await expect(source.info()).rejects.toMatchObject({ name: "AbortError" });
            await expect(source.get(metadata._id)).rejects.toMatchObject({ name: "AbortError" });
            expect(readerRequests).toHaveLength(requestCountAfterClose);

            const seedRevision = String(storedSeed._rev);
            const seedDeleteUrl = new URL(documentUrl(DOCID_SYNC_PARAMETERS));
            seedDeleteUrl.searchParams.set("rev", seedRevision);
            const deleteSeedResponse = await fetch(seedDeleteUrl, {
                method: "DELETE",
                headers: { authorization: authHeader },
            });
            await expectHttpSuccess(deleteSeedResponse, "CouchDB missing-seed fixture setup");

            const missingSeedSequenceBefore = (await readDatabaseInfo()).update_seq;
            const missingSeedSource = createCouchDBDiagnosticSource({ settings, fetch: readerFetch });
            try {
                await expect(missingSeedSource.get(metadata._id)).rejects.toMatchObject({
                    reason: "security-seed-unavailable",
                });
            } finally {
                await missingSeedSource.close();
            }
            const missingSeedSequenceAfter = (await readDatabaseInfo()).update_seq;
            expect(missingSeedSequenceAfter).toBe(missingSeedSequenceBefore);
            const missingSeedResponse = await fetch(documentUrl(DOCID_SYNC_PARAMETERS), {
                headers: { authorization: authHeader },
            });
            expect(missingSeedResponse.status).toBe(404);
            expect(readerRequests.length).toBeGreaterThan(0);
            expect(readerRequests.every((request) => request.method === "GET")).toBe(true);
        } finally {
            await closeSource?.();
            if (databaseCreated) {
                const cleanupResponse = await fetch(databaseUrl, {
                    method: "DELETE",
                    headers: { authorization: authHeader },
                });
                await expectHttpSuccess(cleanupResponse, "CouchDB diagnostics database cleanup");
            }
        }
    }, 30_000);
});
