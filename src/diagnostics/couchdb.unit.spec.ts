import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, E2EEAlgorithms, type EntryDoc, type RemoteDBSettings } from "../common/types.ts";
import { getConfiguredFunctionsForEncryption } from "../pouchdb/encryption.ts";
import { createCouchDBDiagnosticSource } from "./couchdb.ts";

const settings: RemoteDBSettings = {
    ...DEFAULT_SETTINGS,
    couchDB_URI: "https://private.invalid",
    couchDB_DBNAME: "diagnostic",
    couchDB_USER: "user",
    couchDB_PASSWORD: "private-password",
    couchDB_CustomHeaders: "",
    encrypt: false,
};

const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("CouchDB diagnostic reader", () => {
    it("reads actual IDs and exact revisions using only GET requests and closes its request scope", async () => {
        const id = "f:private/path 日本語";
        const fetch = vi.fn(async (request: string, options: RequestInit) => {
            const url = new URL(request);
            expect(options.method).toBe("GET");
            expect(options.cache).toBe("no-store");
            if (url.pathname.endsWith("/_all_docs")) return json({ rows: [{ id, value: { rev: "2-current" } }] });
            if (url.pathname === "/diagnostic") return json({ update_seq: "5-seq" });
            expect(decodeURIComponent(url.pathname)).toBe(`/diagnostic/${id}`);
            expect(url.searchParams.get("rev")).toBe("1-private-revision");
            return json({ _id: id, _rev: "1-private-revision", type: "plain", path: "private.md", children: [] });
        });
        const source = createCouchDBDiagnosticSource({ settings, fetch });
        expect(await source.info()).toEqual({ update_seq: "5-seq" });
        const ids = [];
        for await (const entry of source.enumerateIds()) ids.push(entry);
        expect(ids).toEqual([id]);
        expect(await source.get(id, { rev: "1-private-revision" })).toMatchObject({ _id: id, path: "private.md" });
        const requestSignal = fetch.mock.calls[0][1].signal!;
        expect(requestSignal.aborted).toBe(false);
        await source.close();
        await source.close();
        expect(requestSignal.aborted).toBe(true);
        await expect(source.info()).rejects.toMatchObject({ name: "AbortError" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("decrypts encrypted Metadata and Chunks with an existing seed without writing synchronisation parameters", async () => {
        const salt = new Uint8Array(16).fill(7);
        const encryptedSettings = {
            ...settings,
            encrypt: true,
            passphrase: "test-only",
            E2EEAlgorithm: E2EEAlgorithms.V2,
        };
        const encrypt = getConfiguredFunctionsForEncryption(
            "test-only",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        ).incoming;
        const metadata = {
            _id: "f:wrong-id",
            _rev: "1-meta",
            type: "plain",
            path: "private-file.md",
            ctime: 1,
            mtime: 2,
            size: 7,
            children: ["h:+chunk"],
        } as EntryDoc;
        const chunk = { _id: "h:+chunk", _rev: "1-chunk", type: "leaf", data: "private-content" } as EntryDoc;
        const encrypted = new Map([
            [metadata._id, await encrypt(metadata as Parameters<typeof encrypt>[0])],
            [chunk._id, await encrypt(chunk as Parameters<typeof encrypt>[0])],
        ]);
        expect(encrypted.get(chunk._id)).not.toHaveProperty("data", "private-content");
        expect(encrypted.get(metadata._id)).not.toHaveProperty("path", "private-file.md");
        const fetch = vi.fn(async (request: string, options: RequestInit) => {
            expect(options.method).toBe("GET");
            const path = decodeURIComponent(new URL(request).pathname);
            if (path.endsWith("/_local/obsidian_livesync_sync_parameters")) {
                return json({ pbkdf2salt: Buffer.from(salt).toString("base64") });
            }
            return json(encrypted.get(path.slice("/diagnostic/".length) as EntryDoc["_id"]));
        });
        const source = createCouchDBDiagnosticSource({ settings: encryptedSettings, fetch });
        try {
            expect(await source.get(metadata._id)).toMatchObject(metadata);
            expect(await source.get(chunk._id)).toMatchObject(chunk);
            expect(fetch.mock.calls.filter(([request]) => request.includes("_local/"))).toHaveLength(1);
        } finally {
            await source.close();
        }
        const missingSeedFetch = vi.fn(async (request: string, options: RequestInit) => {
            expect(options.method).toBe("GET");
            return request.includes("_local/") ? json({ error: "not_found" }, 404) : json(encrypted.get(metadata._id));
        });
        const missing = createCouchDBDiagnosticSource({ settings: encryptedSettings, fetch: missingSeedFetch });
        try {
            await expect(missing.get(metadata._id)).rejects.toMatchObject({ reason: "security-seed-unavailable" });
            expect(missingSeedFetch).toHaveBeenCalledTimes(2);
        } finally {
            await missing.close();
        }
    });

    it("discards an in-flight native response after cancellation and issues no later request", async () => {
        const controller = new AbortController();
        const fetch = vi.fn(async () => {
            controller.abort();
            return json({ update_seq: "1" });
        });
        const source = createCouchDBDiagnosticSource({ settings, fetch, signal: controller.signal });
        await expect(source.info()).rejects.toMatchObject({ name: "AbortError" });
        await expect(source.get("private-id")).rejects.toMatchObject({ name: "AbortError" });
        await source.close();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("reports encrypted documents as unreadable when encryption is disabled", async () => {
        for (const doc of [
            { _id: "h:+encrypted", _rev: "1-chunk", type: "leaf", e_: true, data: "%=ciphertext" },
            { _id: "f:encrypted", _rev: "1-meta", type: "plain", path: "/\\:ciphertext", children: [] },
        ]) {
            const source = createCouchDBDiagnosticSource({ settings, fetch: async () => json(doc) });
            try {
                await expect(source.get(doc._id)).rejects.toMatchObject({ reason: "document-unreadable" });
            } finally {
                await source.close();
            }
        }
    });

    it("discards response text and distinguishes HTTP absence from unreadability", async () => {
        for (const status of [404, 403, 500]) {
            const source = createCouchDBDiagnosticSource({
                settings,
                fetch: async () => new Response("private-server-error-and-password", { status }),
            });
            await expect(source.get("private-id")).rejects.toMatchObject({
                reason: "document-unreadable",
                message: "document-unreadable",
                missing: status === 404,
            });
            await source.close();
        }
    });

    it("rejects encrypted Metadata left undecoded when its stored ID has lost the encryption prefix", async () => {
        const doc = { _id: "wrong-id", _rev: "1-meta", type: "plain", path: "/\\:ciphertext", children: [] };
        const source = createCouchDBDiagnosticSource({
            settings: { ...settings, encrypt: true, passphrase: "test-only", E2EEAlgorithm: E2EEAlgorithms.V2 },
            fetch: async () => json(doc),
        });
        try {
            await expect(source.get(doc._id)).rejects.toMatchObject({ reason: "document-unreadable" });
        } finally {
            await source.close();
        }
    });
});
