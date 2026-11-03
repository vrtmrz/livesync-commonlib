import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCouchDBHttpCache } from "./couchdbHttpCache";

const databaseUri = "https://couchdb.example.test/vault";
const documentUri = `${databaseUri}/metadata?rev=3-preserved&other=kept`;

function requestUrl(request: string | Request): string {
    return typeof request === "string" ? request : request.url;
}

describe("createCouchDBHttpCache", () => {
    it("hashes the startup Unix seconds and Seed together without exposing a stable Seed fingerprint", async () => {
        const seed = new Uint8Array([1, 2, 3, 4]);
        const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        try {
            vi.resetModules();
            const firstModule = await import("./couchdbHttpCache");
            const firstCache = firstModule.createCouchDBHttpCache(databaseUri, async () => seed);
            const first = await firstCache(documentUri);
            const firstNamespace = new URL(requestUrl(first.request)).searchParams.get("_livesync_epoch");

            expect(firstNamespace).toBe(createHash("sha256").update("1800000000:").update(seed).digest("hex"));
            expect(firstNamespace).toMatch(/^[0-9a-f]{64}$/);

            now.mockReturnValue(1_800_000_001_000);
            expect(requestUrl((await firstCache(documentUri)).request)).toBe(requestUrl(first.request));

            vi.resetModules();
            const nextModule = await import("./couchdbHttpCache");
            const nextCache = nextModule.createCouchDBHttpCache(databaseUri, async () => seed);
            const next = await nextCache(documentUri);
            expect(new URL(requestUrl(next.request)).searchParams.get("_livesync_epoch")).not.toBe(firstNamespace);
        } finally {
            now.mockRestore();
            vi.resetModules();
        }
    });

    it.each(["", "/metadata?rev=1-current", "/_all_docs?include_docs=true", "/_local/seed"])(
        "uses headers-only compatibility without resolving the Seed for %s",
        async (path) => {
            const getPBKDF2Salt = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
            const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt, true);
            const request = `${databaseUri}${path}`;

            expect(await cache(request, { method: "GET" })).toEqual({ request, cache: "no-store" });
            expect(getPBKDF2Salt).not.toHaveBeenCalled();
        }
    );

    it("reuses the same URL across connections when Seed bytes are unchanged", async () => {
        const seed = new Uint8Array([1, 2, 3, 4]);
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array(seed));
        const firstConnection = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);
        const secondConnection = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);

        const first = await firstConnection(documentUri, { method: "GET" });
        const second = await secondConnection(documentUri, { method: "GET" });

        expect(getPBKDF2Salt).toHaveBeenCalledTimes(2);
        expect(requestUrl(first.request)).toBe(requestUrl(second.request));
        expect(first.cache).toBe("no-cache");
        expect(second.cache).toBe("no-cache");
    });

    it("changes the URL when Seed bytes change and preserves existing query values", async () => {
        let seed = new Uint8Array([1, 2, 3, 4]);
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array(seed));
        const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);

        const first = await cache(documentUri, { method: "GET" });
        seed = new Uint8Array([4, 3, 2, 1]);
        const second = await cache(documentUri, { method: "GET" });
        const firstURL = new URL(requestUrl(first.request));
        const secondURL = new URL(requestUrl(second.request));

        expect(firstURL.searchParams.get("_livesync_epoch")).not.toBeNull();
        expect(secondURL.searchParams.get("_livesync_epoch")).not.toBe(firstURL.searchParams.get("_livesync_epoch"));
        expect(secondURL.searchParams.get("rev")).toBe("3-preserved");
        expect(secondURL.searchParams.get("other")).toBe("kept");
        expect(getPBKDF2Salt).toHaveBeenCalledTimes(2);
    });

    it("keeps namespaces isolated between helpers with different Seed callbacks", async () => {
        const firstCache = createCouchDBHttpCache(databaseUri, async () => new Uint8Array([1, 2, 3, 4]));
        const secondCache = createCouchDBHttpCache(databaseUri, async () => new Uint8Array([4, 3, 2, 1]));

        const first = await firstCache(documentUri, { method: "GET" });
        const second = await secondCache(documentUri, { method: "GET" });

        expect(new URL(requestUrl(first.request)).searchParams.get("_livesync_epoch")).not.toBe(
            new URL(requestUrl(second.request)).searchParams.get("_livesync_epoch")
        );
    });

    it.each(["", "/_local/name", "/_local%2Fname"])("skips Seed resolution for bootstrap path %s", async (path) => {
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
        const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);
        const url = `${databaseUri}${path}`;

        const result = await cache(url, { method: "GET" });

        expect(result.request).toBe(url);
        expect(result.cache).toBe("no-cache");
        expect(getPBKDF2Salt).not.toHaveBeenCalled();
    });

    it("adds the Seed namespace to collection reads", async () => {
        const cache = createCouchDBHttpCache(databaseUri, async () => new Uint8Array([1, 2, 3, 4]));

        const result = await cache(`${databaseUri}/_all_docs?include_docs=true`, { method: "GET" });
        const url = new URL(requestUrl(result.request));

        expect(url.searchParams.get("_livesync_epoch")).not.toBeNull();
        expect(url.searchParams.get("include_docs")).toBe("true");
        expect(result.cache).toBe("no-cache");
    });

    it.each(["GET", "HEAD", "get", "head"] as const)("revalidates a %s read", async (method) => {
        const cache = createCouchDBHttpCache(databaseUri);
        const result = await cache(documentUri, { method });

        expect(result).toEqual({ request: documentUri, cache: "no-cache" });
    });

    it("uses the options method before the Request method without mutating the Request or options", async () => {
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
        const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);
        const request = new Request(documentUri, {
            method: "POST",
            headers: { Authorization: "Bearer fixture" },
        });
        const originalHeaders = new Headers(request.headers);
        const options: RequestInit = {
            method: "get",
            cache: "force-cache",
            headers: { "X-Option": "fixture" },
        };
        const originalOptions = { ...options, headers: { ...(options.headers as Record<string, string>) } };

        const result = await cache(request, options);
        const transformedRequest = result.request;

        expect(transformedRequest).toBeInstanceOf(Request);
        expect(requestUrl(transformedRequest)).not.toBe(request.url);
        expect(new URL(requestUrl(transformedRequest)).searchParams.get("_livesync_epoch")).not.toBeNull();
        expect(result.cache).toBe("no-cache");
        expect(getPBKDF2Salt).toHaveBeenCalledOnce();
        expect(request.url).toBe(documentUri);
        expect(request.method).toBe("POST");
        expect(request.headers).toEqual(originalHeaders);
        expect(options).toEqual(originalOptions);
    });

    it("lets an options method suppress a read inherited from Request", async () => {
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
        const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);
        const request = new Request(documentUri, { method: "GET" });

        const result = await cache(request, { method: "POST", cache: "force-cache" });

        expect(result).toEqual({ request, cache: "force-cache" });
        expect(getPBKDF2Salt).not.toHaveBeenCalled();
    });

    it.each(["POST", "PUT", "DELETE"] as const)("preserves a %s request without resolving Seed", async (method) => {
        const getPBKDF2Salt = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
        const cache = createCouchDBHttpCache(databaseUri, getPBKDF2Salt);
        const options: RequestInit = { method, cache: "reload" };

        const result = await cache(documentUri, options);

        expect(result).toEqual({ request: documentUri, cache: "reload" });
        expect(getPBKDF2Salt).not.toHaveBeenCalled();
    });
});
