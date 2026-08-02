import { describe, expect, it } from "vitest";
import {
    DEFAULT_SETTINGS,
    REMOTE_COUCHDB,
    REMOTE_MINIO,
    REMOTE_P2P,
    REMOTE_POSTGREST,
    REMOTE_WEBDAV,
} from "@lib/common/types.ts";
import { defaultRemoteProviderRegistry } from "./defaultRemoteProviderRegistry.ts";
import { RemoteProviderRegistry, type RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";

describe("RemoteProviderRegistry", () => {
    it("registers the maintained providers in deterministic presentation order", () => {
        expect(defaultRemoteProviderRegistry.providerSummaries()).toEqual([
            expect.objectContaining({ family: "couchdb", remoteType: REMOTE_COUCHDB, type: "couchdb" }),
            expect.objectContaining({ family: "journal", remoteType: REMOTE_MINIO, type: "s3" }),
            expect.objectContaining({ family: "journal", remoteType: REMOTE_WEBDAV, type: "webdav" }),
            expect.objectContaining({ family: "journal", remoteType: REMOTE_POSTGREST, type: "postgrest" }),
            expect.objectContaining({ family: "p2p", remoteType: REMOTE_P2P, type: "p2p" }),
        ]);
        expect(defaultRemoteProviderRegistry.isFrozen()).toBe(true);
    });

    it("projects main and dedicated P2P configurations through provider activation roles", () => {
        const settings = { ...DEFAULT_SETTINGS, remoteType: REMOTE_COUCHDB };
        const p2p = defaultRemoteProviderRegistry.configurationFromSettings("p2p", {
            ...settings,
            P2P_roomID: "team-room",
            P2P_passphrase: "secret",
        });

        defaultRemoteProviderRegistry.applyConfiguration(settings, p2p, "p2p");
        expect(settings.remoteType).toBe(REMOTE_COUCHDB);
        expect(settings.P2P_roomID).toBe("team-room");

        defaultRemoteProviderRegistry.applyConfiguration(settings, p2p);
        expect(settings.remoteType).toBe(REMOTE_P2P);
    });

    it("allows a host to compose and freeze another provider set", () => {
        type TestConfiguration = { type: "test"; settings: { endpoint: string } };
        const testProvider: RemoteProviderDescriptor<"test", { endpoint: string }> = {
            activationRoles: ["main"],
            family: "journal",
            legacyProfileId: "legacy-test",
            legacyProfileName: "Test Remote",
            remoteType: REMOTE_MINIO,
            schemes: ["test"],
            type: "test",
            hasConfiguration: (settings) => !!settings.endpoint,
            parse: (uri) => ({ endpoint: uri.slice("sls+test:".length) }),
            pick: (settings) => ({ endpoint: settings.endpoint }),
            serialise: (settings) => `sls+test:${settings.endpoint}`,
            suggestName: (settings) => `Test ${settings.endpoint}`,
        };
        const registry = new RemoteProviderRegistry<TestConfiguration>().register(testProvider).freeze();

        expect(registry.parse("sls+test:https://example.com")).toEqual({
            settings: { endpoint: "https://example.com" },
            type: "test",
        });
        expect(registry.isRemoteTypeInFamily(REMOTE_MINIO, "journal")).toBe(true);
        expect(() => registry.register(testProvider)).toThrow("frozen");
    });

    it("rejects ambiguous provider identities before freezing", () => {
        const descriptor: RemoteProviderDescriptor<"test", { endpoint: string }> = {
            activationRoles: ["main"],
            family: "journal",
            legacyProfileId: "legacy-test",
            legacyProfileName: "Test Remote",
            remoteType: REMOTE_MINIO,
            schemes: ["test"],
            type: "test",
            hasConfiguration: () => true,
            parse: () => ({ endpoint: "https://example.com" }),
            pick: () => ({ endpoint: "https://example.com" }),
            serialise: () => "sls+test:https://example.com",
            suggestName: () => "Test Remote",
        };
        const registry = new RemoteProviderRegistry().register(descriptor);

        expect(() => registry.register(descriptor)).toThrow("already registered");
    });
});
