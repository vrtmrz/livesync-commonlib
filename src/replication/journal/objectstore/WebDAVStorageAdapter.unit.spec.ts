import { describe, expect, it, vi } from "vitest";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import type { WebDAVSyncSetting } from "@lib/common/types.ts";

function makeEnv(fetchMock: ReturnType<typeof vi.fn>): LiveSyncJournalReplicatorEnv {
    return {
        services: {
            API: {
                webCompatFetch: fetchMock,
                nativeFetch: vi.fn(),
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
}

function makeEnvWithNativeFetch(
    webFetchMock: ReturnType<typeof vi.fn>,
    nativeFetchMock: ReturnType<typeof vi.fn>
): LiveSyncJournalReplicatorEnv {
    return {
        services: {
            API: {
                webCompatFetch: webFetchMock,
                nativeFetch: nativeFetchMock,
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
}

describe("WebDAVStorageAdapter", () => {
    const settings: WebDAVSyncSetting = {
        webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav?prefix=vault%2F&insecure=true",
    };

    it("should upload, list, download, and delete files through WebDAV requests", async () => {
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === "MKCOL") return new Response("", { status: 201 });
            if (init.method === "PUT") return new Response("", { status: 201 });
            if (init.method === "GET") return new Response("payload", { status: 200 });
            if (init.method === "DELETE") return new Response(null, { status: 204 });
            if (init.method === "PROPFIND") {
                return new Response(
                    `<?xml version="1.0" encoding="utf-8"?>
                    <d:multistatus xmlns:d="DAV:">
                      <d:response>
                        <d:href>/dav/vault/</d:href>
                        <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
                      </d:response>
                      <d:response>
                        <d:href>/dav/vault/0002-docs.jsonl.gz</d:href>
                        <d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength></d:prop></d:propstat>
                      </d:response>
                      <d:response>
                        <d:href>/dav/vault/0001-docs.jsonl.gz</d:href>
                        <d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength></d:prop></d:propstat>
                      </d:response>
                    </d:multistatus>`,
                    { status: 207 }
                );
            }
            return new Response("", { status: 500 });
        });
        const adapter = new WebDAVStorageAdapter(settings, makeEnv(fetchMock));

        expect(await adapter.upload("0003-docs.jsonl.gz", new TextEncoder().encode("payload"), "text/plain")).toBe(
            true
        );
        expect(await adapter.listFiles("0001-docs.jsonl.gz")).toEqual(["0002-docs.jsonl.gz"]);
        expect(new TextDecoder().decode((await adapter.download("0002-docs.jsonl.gz")) as Uint8Array)).toBe("payload");
        expect(await adapter.deleteFiles(["0002-docs.jsonl.gz"])).toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            "http://example.com/dav/vault/0003-docs.jsonl.gz",
            expect.objectContaining({
                method: "PUT",
                headers: expect.objectContaining({
                    Authorization: "Basic dXNlcjpwYXNz",
                    "Content-Type": "text/plain",
                }),
            })
        );
    });

    it("should use native fetch when the connection URI requests the internal API", async () => {
        const webFetchMock = vi.fn(async () => new Response("", { status: 500 }));
        const nativeFetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === "MKCOL") return new Response("", { status: 201 });
            if (init.method === "PUT") return new Response("", { status: 201 });
            return new Response("", { status: 500 });
        });
        const adapter = new WebDAVStorageAdapter(
            {
                webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav?prefix=vault%2F&useProxy=true",
            },
            makeEnvWithNativeFetch(webFetchMock, nativeFetchMock)
        );

        expect(await adapter.upload("0003-docs.jsonl.gz", new TextEncoder().encode("payload"), "text/plain")).toBe(
            true
        );
        expect(nativeFetchMock).toHaveBeenCalled();
        expect(webFetchMock).not.toHaveBeenCalled();
    });

    it("should create only prefix collections under the configured endpoint path", async () => {
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === "MKCOL") return new Response("", { status: 201 });
            if (init.method === "PUT") return new Response("", { status: 201 });
            return new Response("", { status: 500 });
        });
        const adapter = new WebDAVStorageAdapter(
            {
                webDAVactiveConnectionURI:
                    "sls+webdav://user:pass@example.com/remote.php/dav/files/user?prefix=vault%2Fjournal%2F",
            },
            makeEnv(fetchMock)
        );

        expect(await adapter.upload("0001-docs.jsonl.gz", new TextEncoder().encode("payload"), "text/plain")).toBe(
            true
        );

        const mkcolUrls = fetchMock.mock.calls
            .filter(([, init]) => init.method === "MKCOL")
            .map(([url]) => url as string);
        expect(mkcolUrls).toEqual([
            "https://example.com/remote.php/dav/files/user/vault",
            "https://example.com/remote.php/dav/files/user/vault/journal",
        ]);
    });
});
