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
import { analyseDatabaseIntegrity } from "./integrity.ts";

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
    it("reduces HTTP requests while preserving the full individual-read inspection", async () => {
        let created = false;
        try {
            await expectHttpSuccess(
                await fetch(databaseUrl, { method: "PUT", headers: jsonHeaders }),
                "CouchDB batch fixture database"
            );
            created = true;
            const chunks = Array.from({ length: 130 }, (_, index) => ({
                _id: `h:fixture-${index}`,
                type: "leaf",
                data: String(index),
            }));
            const notes = Array.from({ length: 65 }, (_, index) => ({
                _id: `note-${index}.md`,
                path: `note-${index}.md`,
                type: "plain",
                ctime: 1,
                mtime: 1,
                size: 1,
                children: index === 0 ? chunks.map((chunk) => chunk._id) : [],
                eden: {},
            }));
            const stored = await fetch(`${databaseUrl}/_bulk_docs`, {
                method: "POST",
                headers: jsonHeaders,
                body: JSON.stringify({ docs: [...notes, ...chunks] }),
            });
            await expectHttpSuccess(stored, "CouchDB batch fixture documents");
            expect(((await stored.json()) as { error?: unknown }[]).every((row) => !row.error)).toBe(true);
            const sequence = (await readDatabaseInfo()).update_seq;
            const inspect = async (bulk: boolean) => {
                let requests = 0;
                const report = await analyseDatabaseIntegrity({
                    local: {
                        info: async () => ({ update_seq: 0, doc_count: 0 }),
                        enumerateIds: async function* () {},
                        get: async () => {
                            throw new Error("unexpected local read");
                        },
                    },
                    remote: async () => {
                        const source = createCouchDBDiagnosticSource({
                            settings: {
                                ...DEFAULT_SETTINGS,
                                couchDB_URI: hostname,
                                couchDB_DBNAME: databaseName,
                                couchDB_USER: username,
                                couchDB_PASSWORD: password,
                                encrypt: false,
                            },
                            fetch: async (request, options) => {
                                expect(options.method).toBe("GET");
                                requests++;
                                return await fetch(request, options);
                            },
                        });
                        if (!bulk) source.getMany = undefined;
                        return source;
                    },
                    path: {
                        getPath: (entry) => (entry as PlainEntry).path,
                        path2id: async (path) => path as DocumentID,
                    },
                    settings: {
                        encrypt: false,
                        usePathObfuscation: false,
                        handleFilenameCaseSensitive: true,
                        idDerivationVersion: 0,
                        pathNormalizationVersion: 0,
                    },
                    readStorage: async () => ({ status: "not-checked" }),
                    isConfigurationCurrent: () => true,
                });
                return { report, requests };
            };
            const individual = await inspect(false);
            const bulk = await inspect(true);
            expect(bulk.report).toEqual(individual.report);
            expect(bulk.report.status).toBe("complete");
            expect(individual.requests).toBe(198);
            expect(bulk.requests).toBe(8);
            expect((await readDatabaseInfo()).update_seq).toBe(sequence);
            console.log(
                JSON.stringify({
                    individualHttpRequests: individual.requests,
                    bulkHttpRequests: bulk.requests,
                    metadata: 65,
                    chunks: 130,
                })
            );
        } finally {
            if (created)
                await expectHttpSuccess(
                    await fetch(databaseUrl, { method: "DELETE", headers: jsonHeaders }),
                    "CouchDB batch fixture cleanup"
                );
        }
    }, 30_000);

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
            const bulkStart = readerRequests.length;
            const bulk = await source.getMany!([metadata._id, chunkId, "h:missing"], { conflicts: true });
            expect(bulk[0]).toMatchObject({ id: metadata._id, document: metadata });
            expect(bulk[1]).toMatchObject({ id: chunkId, document: chunk });
            expect(bulk[2]).toMatchObject({ id: "h:missing", error: { missing: true } });
            expect(readerRequests.length - bulkStart).toBe(1);
            const sequenceAfter = (await source.info()).update_seq;
            const seedAfter = await getJSON<Record<string, unknown>>(documentUrl(DOCID_SYNC_PARAMETERS));
            expect(sequenceAfter).toBe(sequenceBefore);
            expect(seedAfter).toEqual(storedSeed);

            const conflictRevision = "1-00000000000000000000000000000001";
            const conflictURL = new URL(documentUrl(metadata._id));
            conflictURL.searchParams.set("new_edits", "false");
            await expectHttpSuccess(
                await fetch(conflictURL, {
                    method: "PUT",
                    headers: jsonHeaders,
                    body: JSON.stringify({ ...encryptedMetadata, _rev: conflictRevision }),
                }),
                "CouchDB conflict fixture"
            );
            const conflictedSequence = (await source.info()).update_seq;
            const winner = await source.get(metadata._id, { conflicts: true });
            const conflicts = (winner as EntryDoc & { _conflicts: string[] })._conflicts;
            expect(conflicts).toHaveLength(1);
            expect(await source.getMany!([metadata._id], { conflicts: true })).toEqual([
                { id: metadata._id, document: winner },
            ]);
            expect(await source.get(metadata._id, { rev: conflicts[0], conflicts: true })).toMatchObject(metadata);
            expect((await source.info()).update_seq).toBe(conflictedSequence);

            await source.close();
            const requestCountAfterClose = readerRequests.length;
            await expect(source.info()).rejects.toMatchObject({ name: "AbortError" });
            await expect(source.get(metadata._id)).rejects.toMatchObject({ name: "AbortError" });
            await expect(source.getMany!([metadata._id])).rejects.toMatchObject({ name: "AbortError" });
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
                expect(await missingSeedSource.getMany!([metadata._id, chunkId])).toMatchObject([
                    { error: { reason: "security-seed-unavailable" } },
                    { error: { reason: "security-seed-unavailable" } },
                ]);
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
