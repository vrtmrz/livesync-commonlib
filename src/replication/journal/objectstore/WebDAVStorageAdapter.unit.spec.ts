import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";

import type { WebDAVSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { inspectJournalStorageRemoteFormatV1 } from "./JournalStorageAdapter.ts";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";

interface StatefulWebDAVOptions {
    conditionalCreate?: boolean;
    quotaAvailableBytes?: number;
    quotaUsedBytes?: number;
    range?: boolean;
}

const DEFAULT_REQUIRED_CAPABILITIES = [
    "binary-fidelity",
    "complete-listing",
    "conditional-create",
    "delete-visibility",
    "read-after-write",
] as const;

function settings(uri = "sls+webdav://user:pass@example.invalid/dav?prefix=vault%2F&insecure=true") {
    return { webDAVactiveConnectionURI: uri } as WebDAVSyncSetting;
}

function responseEntry(href: string, properties: string): string {
    return `<d:response>
      <d:href>${href}</d:href>
      <d:propstat><d:prop>${properties}</d:prop></d:propstat>
    </d:response>`;
}

function statefulWebDAV(options: StatefulWebDAVOptions = {}) {
    const objects = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (urlString: string, init: RequestInit = {}) => {
        const url = new URL(urlString);
        const method = init.method ?? "GET";
        const rootPath = "/dav/vault/";
        const key = decodeURIComponent(url.pathname).startsWith(rootPath)
            ? decodeURIComponent(url.pathname).substring(rootPath.length)
            : "";
        if (method === "MKCOL") return new Response(null, { status: 201 });
        if (method === "PUT") {
            const headers = new Headers(init.headers);
            if (options.conditionalCreate !== false && headers.get("if-none-match") === "*" && objects.has(key)) {
                return new Response(null, { status: 412 });
            }
            const body = new Uint8Array(await new Response(init.body).arrayBuffer());
            objects.set(key, body);
            return new Response(null, { headers: { ETag: `"${key}"` }, status: 201 });
        }
        if (method === "GET") {
            const stored = objects.get(key);
            if (!stored) return new Response(null, { status: 404 });
            const requestedRange = new Headers(init.headers).get("range")?.match(/^bytes=([0-9]+)-([0-9]+)$/u);
            if (requestedRange && options.range !== false) {
                const start = Number(requestedRange[1]);
                const end = Number(requestedRange[2]);
                return new Response(stored.slice(start, end + 1), {
                    headers: {
                        "Content-Range": `bytes ${start}-${end}/${stored.byteLength}`,
                        ETag: `"${key}"`,
                    },
                    status: 206,
                });
            }
            return new Response(stored, { headers: { ETag: `"${key}"` }, status: 200 });
        }
        if (method === "DELETE") {
            const deleted = objects.delete(key);
            return new Response(null, { status: deleted ? 204 : 404 });
        }
        if (method === "PROPFIND") {
            const quota = `${
                options.quotaUsedBytes === undefined
                    ? ""
                    : `<d:quota-used-bytes>${options.quotaUsedBytes}</d:quota-used-bytes>`
            }${
                options.quotaAvailableBytes === undefined
                    ? ""
                    : `<d:quota-available-bytes>${options.quotaAvailableBytes}</d:quota-available-bytes>`
            }`;
            const entries = [...objects.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([objectKey, value]) =>
                    responseEntry(
                        `${rootPath}${encodeURIComponent(objectKey)}`,
                        `<d:getcontentlength>${value.byteLength}</d:getcontentlength>`
                    )
                )
                .join("\n");
            return new Response(
                `<?xml version="1.0" encoding="utf-8"?>
                <d:multistatus xmlns:d="DAV:">
                  ${responseEntry(rootPath, `<d:resourcetype><d:collection/></d:resourcetype>${quota}`)}
                  ${entries}
                </d:multistatus>`,
                { status: 207 }
            );
        }
        return new Response(null, { status: 500 });
    });
    return { fetch, objects };
}

function createAdapter(
    webCompatFetch: ReturnType<typeof vi.fn>,
    currentSettings = settings(),
    nativeFetch: ReturnType<typeof vi.fn> = vi.fn()
) {
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const env = {
        services: {
            API: { nativeFetch, requestCount, responseCount, webCompatFetch },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    return {
        adapter: new WebDAVStorageAdapter(currentSettings, env),
        nativeFetch,
        requestCount,
        responseCount,
        settings: currentSettings,
        webCompatFetch,
    };
}

describe("WebDAVStorageAdapter", () => {
    it("supports the Opaque lifecycle and creates the configured collection once", async () => {
        const { fetch, objects } = statefulWebDAV();
        const { adapter } = createAdapter(fetch);
        const payload = new TextEncoder().encode("payload");

        await expect(adapter.upload("0002-journal.jsonl.gz", payload, "application/gzip")).resolves.toBe(true);
        await expect(adapter.upload("0001-journal.jsonl.gz", payload, "application/gzip")).resolves.toBe(true);
        await expect(adapter.listFiles("0001-journal.jsonl.gz")).resolves.toEqual(["0002-journal.jsonl.gz"]);
        await expect(adapter.download("0002-journal.jsonl.gz")).resolves.toEqual(payload);
        await expect(adapter.deleteFiles(["0002-journal.jsonl.gz"])).resolves.toBe(true);

        expect(objects.has("0002-journal.jsonl.gz")).toBe(false);
        expect(fetch.mock.calls.filter(([, init]) => init.method === "MKCOL")).toHaveLength(1);
        const put = fetch.mock.calls.find(([, init]) => init.method === "PUT");
        expect(put?.[0]).toBe("http://example.invalid/dav/vault/0002-journal.jsonl.gz");
        expect(new Headers(put?.[1].headers).get("authorization")).toBe("Basic dXNlcjpwYXNz");
    });

    it("keeps object and prefix paths inside the configured DAV collection", () => {
        const { fetch } = statefulWebDAV();
        const { adapter } = createAdapter(fetch);

        expect(adapter.keyFromHref("/dav/vault2/unrelated.bin")).toBe(false);
        expect(() => adapter.makeUrl("../outside.bin")).toThrow("flat names");

        const escapedPrefix = createAdapter(
            fetch,
            settings("sls+webdav://example.invalid/dav?prefix=..%2Foutside&insecure=true")
        ).adapter;
        expect(() => escapedPrefix.storageIdentity).toThrow("dot path segments");
        expect(
            () => createAdapter(fetch, settings("sls+webdav:example.invalid/dav?insecure=true")).adapter.storageIdentity
        ).toThrow("Invalid WebDAV connection URI");
    });

    it("encodes non-ASCII Basic credentials without relying on Node Buffer", async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 201 }));
        const { adapter } = createAdapter(
            fetch,
            settings("sls+webdav://us%C3%A9r:p%C3%A4ss@example.invalid/dav?insecure=true")
        );

        await expect(adapter.upload("file.bin", new Uint8Array([1]), "application/octet-stream")).resolves.toBe(true);
        expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Basic dXPDqXI6cMOkc3M=");
    });

    it("tracks native-fetch failure and web-fetch fallback as separate physical attempts", async () => {
        const nativeFetch = vi.fn(async () => {
            throw new Error("native transport unavailable");
        });
        const webCompatFetch = vi.fn(async () => new Response(null, { status: 201 }));
        const currentSettings = settings("sls+webdav://user:pass@example.invalid/dav?insecure=true&useProxy=true");
        const { adapter, requestCount, responseCount } = createAdapter(webCompatFetch, currentSettings, nativeFetch);

        await expect(adapter.upload("file.bin", new Uint8Array([1]), "application/octet-stream")).resolves.toBe(true);
        expect(nativeFetch).toHaveBeenCalledOnce();
        expect(webCompatFetch).toHaveBeenCalledOnce();
        expect(requestCount.value).toBe(2);
        expect(responseCount.value).toBe(2);
    });

    it("keeps a download active until the response body has been consumed", async () => {
        const body = promiseWithResolvers<ArrayBuffer>();
        const webCompatFetch = vi.fn(
            async () =>
                ({
                    arrayBuffer: () => body.promise,
                    body: null,
                    headers: new Headers(),
                    ok: true,
                    status: 200,
                }) as Response
        );
        const { adapter, requestCount, responseCount } = createAdapter(
            webCompatFetch,
            settings("sls+webdav://example.invalid/dav?insecure=true")
        );

        const downloading = adapter.download("file.bin");
        await vi.waitFor(() => expect(requestCount.value - responseCount.value).toBe(1));
        body.resolve(new Uint8Array([1, 2, 3]).buffer);

        await expect(downloading).resolves.toEqual(new Uint8Array([1, 2, 3]));
        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("uses conditional create and validates an exact byte-range response", async () => {
        const { fetch } = statefulWebDAV();
        const { adapter } = createAdapter(fetch);
        const body = new Uint8Array([0, 1, 2, 3, 4]);

        await expect(
            adapter.createAdaptiveObject("a1~pack~one.bin", body, "application/octet-stream")
        ).resolves.toEqual({
            identity: '"a1~pack~one.bin"',
            status: "created",
        });
        await expect(
            adapter.createAdaptiveObject("a1~pack~one.bin", new Uint8Array([9]), "application/octet-stream")
        ).resolves.toEqual({ status: "already-exists" });
        await expect(adapter.readAdaptiveObject("a1~pack~one.bin", { length: 3, offset: 1 })).resolves.toEqual({
            identity: '"a1~pack~one.bin"',
            status: "found",
            value: new Uint8Array([1, 2, 3]),
        });
    });

    it.each([
        {
            expected: { failure: { category: "authentication", retry: "never" }, status: "failed" },
            response: async () => new Response(null, { status: 401 }),
        },
        {
            expected: { failure: { category: "permission", retry: "never" }, status: "failed" },
            response: async () => new Response(null, { status: 403 }),
        },
        {
            expected: { failure: { category: "unavailable", retry: "verify-first" }, status: "failed" },
            response: async () => {
                throw new Error("connection closed after upload");
            },
        },
    ] as const)("classifies an Adaptive mutation failure without assuming absence", async ({ expected, response }) => {
        const { adapter } = createAdapter(vi.fn(response), settings("sls+webdav://example.invalid/dav?insecure=true"));

        await expect(
            adapter.createAdaptiveObject("a1~commit~one", new Uint8Array([1]), "application/octet-stream")
        ).resolves.toEqual(expected);
    });

    it("actively verifies, cleans, and caches the selected Adaptive capabilities", async () => {
        const { fetch, objects } = statefulWebDAV();
        const currentSettings = settings();
        const { adapter } = createAdapter(fetch, currentSettings);

        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            status: "verified",
        });
        expect(objects.size).toBe(0);
        const callsAfterProbe = fetch.mock.calls.length;

        adapter.applyNewConfig({ ...currentSettings, journalFormat: "adaptive-v1", packReadPolicy: "range" });
        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            status: "verified",
        });
        expect(fetch).toHaveBeenCalledTimes(callsAfterProbe);
    });

    it("retries a transient capability failure instead of caching it", async () => {
        const { fetch, objects } = statefulWebDAV();
        fetch.mockRejectedValueOnce(new Error("temporary connection failure"));
        const { adapter } = createAdapter(fetch);

        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            failure: { category: "unavailable", retry: "verify-first" },
            status: "failed",
        });
        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            status: "verified",
        });
        expect(objects.size).toBe(0);
    });

    it("reports conditional-create semantics which the server does not honour", async () => {
        const { fetch, objects } = statefulWebDAV({ conditionalCreate: false });
        const { adapter } = createAdapter(fetch);

        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            missing: ["conditional-create"],
            status: "unsupported",
        });
        expect(objects.size).toBe(0);
    });

    it("accepts whole-pack reads but reports a server which ignores byte ranges", async () => {
        const { fetch } = statefulWebDAV({ range: false });
        const { adapter } = createAdapter(fetch);

        await expect(adapter.verifyCapabilities(DEFAULT_REQUIRED_CAPABILITIES)).resolves.toEqual({
            status: "verified",
        });
        await expect(adapter.verifyCapabilities([...DEFAULT_REQUIRED_CAPABILITIES, "byte-range"])).resolves.toEqual({
            missing: ["byte-range"],
            status: "unsupported",
        });
    });

    it("reuses one complete listing only within a receive phase", async () => {
        const { fetch, objects } = statefulWebDAV();
        objects.set("a1~commit~one", new Uint8Array([1]));
        objects.set("a1~writer~one", new Uint8Array([2]));
        const { adapter } = createAdapter(fetch);

        await adapter.runAdaptiveJournalReceivePhase(async () => {
            await expect(adapter.listAdaptiveObjects("a1~commit~")).resolves.toEqual({
                keys: ["a1~commit~one"],
                status: "ok",
            });
            await expect(adapter.listAdaptiveObjects("a1~writer~")).resolves.toEqual({
                keys: ["a1~writer~one"],
                status: "ok",
            });
            objects.set("a1~commit~two", new Uint8Array([3]));
            await expect(adapter.listAdaptiveObjects("a1~commit~")).resolves.toEqual({
                keys: ["a1~commit~one"],
                status: "ok",
            });
        });
        expect(fetch.mock.calls.filter(([, init]) => init.method === "PROPFIND")).toHaveLength(1);

        await adapter.runAdaptiveJournalReceivePhase(async () => {
            await expect(adapter.listAdaptiveObjects("a1~commit~")).resolves.toEqual({
                keys: ["a1~commit~one", "a1~commit~two"],
                status: "ok",
            });
        });
        expect(fetch.mock.calls.filter(([, init]) => init.method === "PROPFIND")).toHaveLength(2);
    });

    it("restores receive-phase listing scope after a connection change", async () => {
        const { fetch, objects } = statefulWebDAV();
        objects.set("a1~commit~one", new Uint8Array([1]));
        const currentSettings = settings();
        const { adapter } = createAdapter(fetch, currentSettings);

        await adapter.runAdaptiveJournalReceivePhase(async () => {
            await adapter.listAdaptiveObjects("a1~commit~");
            adapter.applyNewConfig({
                ...currentSettings,
                webDAVactiveConnectionURI:
                    "sls+webdav://user:rotated@example.invalid/dav?prefix=vault%2F&insecure=true",
            });
        });
        await adapter.runAdaptiveJournalReceivePhase(async () => {
            await adapter.listAdaptiveObjects("a1~commit~");
            await adapter.listAdaptiveObjects("a1~writer~");
        });

        expect(fetch.mock.calls.filter(([, init]) => init.method === "PROPFIND")).toHaveLength(2);
    });

    it.each([
        { expected: "empty", keys: [] },
        { expected: "empty", keys: ["a1~probe~orphan.bin"] },
        { expected: "opaque-v1", keys: ["0001-journal.jsonl.gz"] },
        { expected: "adaptive-v1", keys: ["a1~manifest.json", "a1~writer~one"] },
        { expected: "mixed", keys: ["0001-journal.jsonl.gz", "a1~manifest.json"] },
    ] as const)("detects $expected WebDAV Journal storage", async ({ expected, keys }) => {
        const { fetch, objects } = statefulWebDAV();
        for (const key of keys) objects.set(key, new Uint8Array([1]));
        const { adapter } = createAdapter(fetch);

        await expect(adapter.inspectRemoteFormat()).resolves.toBe(expected);
    });

    it("retains format evidence for protocol-only changes and invalidates it for connection changes", async () => {
        const { fetch, objects } = statefulWebDAV();
        objects.set("0001-journal.jsonl.gz", new Uint8Array([1]));
        const currentSettings = settings();
        const { adapter } = createAdapter(fetch, currentSettings);

        await expect(inspectJournalStorageRemoteFormatV1(adapter)).resolves.toBe("opaque-v1");
        adapter.applyNewConfig({ ...currentSettings, journalFormat: "adaptive-v1" });
        await expect(inspectJournalStorageRemoteFormatV1(adapter)).resolves.toBe("opaque-v1");
        expect(fetch.mock.calls.filter(([, init]) => init.method === "PROPFIND")).toHaveLength(1);

        adapter.applyNewConfig({
            ...currentSettings,
            webDAVactiveConnectionURI: "sls+webdav://user:rotated@example.invalid/dav?prefix=vault%2F&insecure=true",
        });
        await expect(inspectJournalStorageRemoteFormatV1(adapter)).resolves.toBe("opaque-v1");
        expect(fetch.mock.calls.filter(([, init]) => init.method === "PROPFIND")).toHaveLength(2);
    });

    it("classifies malformed WebDAV listing XML as an invalid response", async () => {
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === "MKCOL") return new Response(null, { status: 201 });
            return new Response(
                '<d:multistatus xmlns:d="DAV:"><d:response><d:href>&#x110000;</d:href></d:response></d:multistatus>',
                { status: 207 }
            );
        });
        const { adapter } = createAdapter(fetch);

        await expect(adapter.listAdaptiveObjects("a1~commit~")).resolves.toEqual({
            failure: { category: "invalid-response", retry: "never" },
            status: "failed",
        });
    });

    it("reports listing size and optional WebDAV quota properties", async () => {
        const { fetch, objects } = statefulWebDAV({ quotaAvailableBytes: 2048, quotaUsedBytes: 1024 });
        objects.set("one.bin", new Uint8Array(7));
        objects.set("two.bin", new Uint8Array(5));
        const { adapter } = createAdapter(fetch);

        await expect(adapter.getUsage()).resolves.toEqual({
            estimatedSize: 12,
            webDAVQuotaAvailableBytes: 2048,
            webDAVQuotaUsedBytes: 1024,
        });
    });
});
