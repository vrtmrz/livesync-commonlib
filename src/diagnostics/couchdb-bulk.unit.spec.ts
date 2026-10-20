import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../common/types.ts";
import { createCouchDBDiagnosticSource } from "./couchdb.ts";

const settings = {
    ...DEFAULT_SETTINGS,
    couchDB_URI: "https://example.invalid",
    couchDB_DBNAME: "diagnostic",
    encrypt: false,
};
const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const document = (id: string) => ({ _id: id, _rev: "2-current", type: "plain", path: `${id}.md`, children: [] });

describe("CouchDB diagnostic bulk reads", () => {
    it("reads only requested documents with conflicts, bounds requests, and preserves per-document failures", async () => {
        const ids = Array.from({ length: 130 }, (_, index) => `document-${index}`);
        const requests: string[][] = [];
        const fetch = vi.fn(async (request: string, options: RequestInit) => {
            expect(options.method).toBe("GET");
            const url = new URL(request);
            expect(url.pathname).toBe("/diagnostic/_all_docs");
            expect(url.searchParams.get("include_docs")).toBe("true");
            expect(url.searchParams.get("conflicts")).toBe("true");
            const keys = JSON.parse(url.searchParams.get("keys")!) as string[];
            requests.push(keys);
            expect(keys.length).toBeLessThanOrEqual(64);
            expect(request.length).toBeLessThanOrEqual(6000);
            return json({
                rows: keys.map((id) =>
                    id === ids[1]
                        ? { key: id, error: "not_found" }
                        : id === ids[2]
                          ? { key: id, id, value: { deleted: true } }
                          : { key: id, id, doc: id === ids[3] ? { ...document(id), _id: "wrong" } : document(id) }
                ),
            });
        });
        const source = createCouchDBDiagnosticSource({ settings, fetch });
        try {
            const result = await source.getMany!(ids, { conflicts: true });
            expect(requests).toHaveLength(3);
            expect(requests.flat()).toEqual(ids);
            expect(result.map((row) => row.id)).toEqual(ids);
            expect(result[0]).toEqual({ id: ids[0], document: document(ids[0]) });
            expect(result[1]).toMatchObject({ error: { missing: true, reason: "document-unreadable" } });
            expect(result[2]).toMatchObject({ error: { missing: true } });
            expect(result[3]).toMatchObject({ error: { missing: false } });
            expect(result.at(-1)).toEqual({ id: ids.at(-1), document: document(ids.at(-1)!) });
        } finally {
            await source.close();
        }
    });

    it("splits encoded URLs and uses a single-document GET for a key too long for a batch", async () => {
        const ids = Array.from({ length: 8 }, (_, index) => `${index}-${"日本語".repeat(50)}`);
        ids.push("x".repeat(6500));
        const fetched: string[] = [];
        const source = createCouchDBDiagnosticSource({
            settings,
            fetch: async (request, options) => {
                expect(options.method).toBe("GET");
                const url = new URL(request);
                if (url.pathname.endsWith("/_all_docs")) {
                    expect(request.length).toBeLessThanOrEqual(6000);
                    const keys = JSON.parse(url.searchParams.get("keys")!) as string[];
                    fetched.push(...keys);
                    return json({ rows: keys.map((id) => ({ key: id, id, doc: document(id) })) });
                }
                const id = decodeURIComponent(url.pathname.slice("/diagnostic/".length));
                fetched.push(id);
                return json(document(id));
            },
        });
        try {
            expect((await source.getMany!(ids)).every((row) => "document" in row)).toBe(true);
            expect(fetched).toEqual(ids);
        } finally {
            await source.close();
        }
    });

    it("retains successful batches when another request fails without substituting missing data", async () => {
        const ids = Array.from({ length: 65 }, (_, index) => `doc-${index}`);
        let requests = 0;
        const source = createCouchDBDiagnosticSource({
            settings,
            fetch: async (request) => {
                if (++requests === 1) return new Response("private server failure", { status: 500 });
                const keys = JSON.parse(new URL(request).searchParams.get("keys")!) as string[];
                return json({ rows: keys.map((id) => ({ key: id, id, doc: document(id) })) });
            },
        });
        try {
            const result = await source.getMany!(ids);
            expect(result.slice(0, 64).every((row) => "error" in row)).toBe(true);
            expect(result[0]).toMatchObject({ error: { missing: false, message: "document-unreadable" } });
            expect(result[64]).toMatchObject({ document: { _id: ids[64] } });
        } finally {
            await source.close();
        }
    });

    it("discards an active response after cancellation and dispatches no further batch", async () => {
        const controller = new AbortController();
        const fetch = vi.fn(async () => {
            controller.abort();
            return json({ rows: [] });
        });
        const source = createCouchDBDiagnosticSource({ settings, fetch, signal: controller.signal });
        try {
            await expect(
                source.getMany!(Array.from({ length: 100 }, (_, index) => String(index)))
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
            await source.close();
        }
    });
});
