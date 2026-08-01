import { describe, expect, it } from "vitest";

import { parseWebDAVConnectionURI, serialiseWebDAVConnectionURI } from "./JournalStorageConnection.ts";

describe("WebDAV Journal connection URI", () => {
    it("round-trips browser-safe WebDAV connection fields", () => {
        const uri = serialiseWebDAVConnectionURI({
            customHeaders: "X-Vault: example",
            endpoint: "https://dav.example/remote.php/dav/files/alice",
            password: "p@ss word",
            prefix: "vault/notes/",
            useCustomRequestHandler: true,
            username: "alice@example.com",
        });

        expect(uri).toContain("sls+webdav://");
        expect(parseWebDAVConnectionURI(uri)).toEqual({
            customHeaders: "X-Vault: example",
            endpoint: "https://dav.example/remote.php/dav/files/alice",
            password: "p@ss word",
            prefix: "vault/notes/",
            useCustomRequestHandler: true,
            username: "alice@example.com",
        });
    });

    it("retains an explicit insecure endpoint without changing the persistence scheme", () => {
        const uri = serialiseWebDAVConnectionURI({
            customHeaders: "",
            endpoint: "http://localhost:8080/dav",
            password: "",
            prefix: "",
            useCustomRequestHandler: false,
            username: "",
        });

        expect(uri).toBe("sls+webdav://localhost:8080/dav?insecure=true");
        expect(parseWebDAVConnectionURI(uri).endpoint).toBe("http://localhost:8080/dav");
    });

    it.each([
        "ftp://dav.example/files",
        "https://embedded:top-secret@dav.example/files",
        "https://dav.example/files?token=secret",
        "https://dav.example/files#fragment",
    ])("rejects an endpoint which cannot be represented safely: %s", (endpoint) => {
        expect(() =>
            serialiseWebDAVConnectionURI({
                customHeaders: "",
                endpoint,
                password: "",
                prefix: "",
                useCustomRequestHandler: false,
                username: "",
            })
        ).toThrow();
    });
});
