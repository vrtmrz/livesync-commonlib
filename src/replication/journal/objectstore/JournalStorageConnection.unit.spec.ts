import { describe, expect, it } from "vitest";

import {
    parsePostgRESTConnectionURI,
    parseWebDAVConnectionURI,
    serialisePostgRESTConnectionURI,
    serialiseWebDAVConnectionURI,
} from "./JournalStorageConnection.ts";

describe("PostgREST Journal connection URI", () => {
    it("round-trips only client-safe PostgREST credentials and transport fields", () => {
        const uri = serialisePostgRESTConnectionURI({
            apiKey: "publishable-key",
            endpoint: "https://project.example/rest/v1",
            schema: "livesync_api",
            useCustomRequestHandler: true,
            vaultCredential: "vault secret",
            vaultId: "vault-a",
        });

        expect(uri).toContain("sls+postgrest://vault-a:vault%20secret@project.example/rest/v1?");
        expect(uri).not.toContain("service_role");
        expect(parsePostgRESTConnectionURI(uri)).toEqual({
            apiKey: "publishable-key",
            endpoint: "https://project.example/rest/v1",
            schema: "livesync_api",
            useCustomRequestHandler: true,
            vaultCredential: "vault secret",
            vaultId: "vault-a",
        });
    });

    it("retains an explicit insecure endpoint and validates the schema name", () => {
        const uri = serialisePostgRESTConnectionURI({
            apiKey: "",
            endpoint: "http://localhost:3000",
            schema: "private_sync",
            useCustomRequestHandler: false,
            vaultCredential: "credential",
            vaultId: "vault",
        });

        expect(uri).toContain("insecure=true");
        expect(parsePostgRESTConnectionURI(uri)).toMatchObject({
            endpoint: "http://localhost:3000",
            schema: "private_sync",
        });
        expect(() => parsePostgRESTConnectionURI(uri.replace("schema=private_sync", "schema=bad-name"))).toThrow(
            "schema"
        );
    });

    it("rejects database credentials embedded in the endpoint", () => {
        expect(() =>
            serialisePostgRESTConnectionURI({
                apiKey: "",
                endpoint: "https://database-user:database-password@project.example/rest/v1",
                schema: "livesync_api",
                useCustomRequestHandler: false,
                vaultCredential: "vault-credential",
                vaultId: "vault-id",
            })
        ).toThrow("credentials");
    });
});

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
