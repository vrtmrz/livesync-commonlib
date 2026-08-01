import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./types.ts";
import { pickPostgRESTSyncSettings, pickWebDAVSyncSettings } from "./utils.ts";

describe("pickWebDAVSyncSettings", () => {
    it("copies the WebDAV connection and Adaptive Journal protocol fields", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            webDAVactiveConnectionURI: "sls+webdav://alice:secret@dav.example/vault?prefix=notes%2F",
            journalFormat: "adaptive-v1" as const,
            expectedRepositoryId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            packReadPolicy: "range" as const,
        };

        expect(pickWebDAVSyncSettings(settings)).toEqual({
            webDAVactiveConnectionURI: settings.webDAVactiveConnectionURI,
            journalFormat: "adaptive-v1",
            expectedRepositoryId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            packReadPolicy: "range",
        });
    });

    it("normalises missing Journal protocol fields to Opaque defaults", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            webDAVactiveConnectionURI: "sls+webdav://dav.example/vault",
            journalFormat: undefined,
            expectedRepositoryId: undefined,
            packReadPolicy: undefined,
        };

        expect(pickWebDAVSyncSettings(settings)).toEqual({
            webDAVactiveConnectionURI: settings.webDAVactiveConnectionURI,
            journalFormat: "opaque-v1",
            expectedRepositoryId: "",
            packReadPolicy: "whole-pack",
        });
    });
});

describe("pickPostgRESTSyncSettings", () => {
    it("copies the PostgREST connection and fixed Adaptive Journal protocol fields", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            postgrestActiveConnectionURI:
                "sls+postgrest://vault-a:credential@project.example/rest/v1?apiKey=publishable",
            journalFormat: "adaptive-v1" as const,
            expectedRepositoryId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            packReadPolicy: "whole-pack" as const,
        };

        expect(pickPostgRESTSyncSettings(settings)).toEqual({
            postgrestActiveConnectionURI: settings.postgrestActiveConnectionURI,
            journalFormat: "adaptive-v1",
            expectedRepositoryId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            packReadPolicy: "whole-pack",
        });
    });
});
