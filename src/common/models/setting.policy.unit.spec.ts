import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./setting.const.defaults";
import { createMarkdownSettings, mergeMarkdownSettings, prepareSettingsForPersistence } from "./setting.policy";
import type { ObsidianLiveSyncSettings } from "./setting.type";

function settings(): ObsidianLiveSyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        accessKey: "synthetic-access-key",
        secretKey: "synthetic-secret-key",
        jwtKey: "synthetic-jwt-key",
        couchDB_CustomHeaders: "Authorization: synthetic-couch-token",
        bucketCustomHeaders: "Authorization: synthetic-bucket-token",
        P2P_passphrase: "synthetic-p2p-passphrase",
        P2P_turnCredential: "synthetic-turn-credential",
        encryptedCouchDBConnection: "synthetic-encrypted-connection",
        additionalSuffixOfDatabaseName: "local-suffix",
        remoteConfigurations: {
            inactive: {
                id: "inactive",
                name: "Inactive",
                uri: "sls+s3://synthetic-access:synthetic-secret@synthetic.invalid/",
                isEncrypted: false,
            },
        },
        activeConfigurationId: "inactive",
    };
}

function profilesWithSpecialIds(): ObsidianLiveSyncSettings["remoteConfigurations"] {
    return JSON.parse(
        JSON.stringify(
            ["__proto__", "constructor", "prototype"].reduce(
                (profiles, id) => ({
                    ...profiles,
                    [id]: {
                        id,
                        name: `Synthetic ${id}`,
                        uri: `sls+s3://synthetic-access:synthetic-secret@synthetic.invalid/${id}`,
                        isEncrypted: false,
                    },
                }),
                {}
            )
        )
    );
}

describe("settings property policy", () => {
    it("applies the connection sharing option to Markdown settings", () => {
        const original = settings();
        const output = createMarkdownSettings(original, false);
        for (const key of [
            "accessKey",
            "secretKey",
            "jwtKey",
            "couchDB_CustomHeaders",
            "bucketCustomHeaders",
            "P2P_passphrase",
            "P2P_turnCredential",
            "remoteConfigurations",
            "activeConfigurationId",
        ]) {
            expect(output).not.toHaveProperty(key);
        }
        expect(output).not.toHaveProperty("encryptedCouchDBConnection");
        expect(output).not.toHaveProperty("additionalSuffixOfDatabaseName");
        expect(original.secretKey).toBe("synthetic-secret-key");
        expect(original.remoteConfigurations.inactive.uri).toContain("synthetic-secret");
    });

    it("includes shared connection values and known properties", () => {
        const original = { ...settings(), unexpectedCredential: "synthetic-unknown-secret" };
        const output = createMarkdownSettings(original, true);
        expect(output.accessKey).toBe(original.accessKey);
        expect(output.secretKey).toBe(original.secretKey);
        expect(output.remoteConfigurations).toEqual(original.remoteConfigurations);
        expect(output.remoteConfigurations).not.toBe(original.remoteConfigurations);
        expect(output).not.toHaveProperty("encryptedCouchDBConnection");
        expect(output).not.toHaveProperty("unexpectedCredential");
    });

    it("retains named profile IDs when connection sharing is enabled", () => {
        const original = { ...settings(), remoteConfigurations: profilesWithSpecialIds() };
        const output = createMarkdownSettings(original, true);
        expect(JSON.parse(JSON.stringify(output.remoteConfigurations))).toEqual(original.remoteConfigurations);
        expect(Object.getPrototypeOf(output.remoteConfigurations)).toBe(Object.prototype);
        for (const id of Object.keys(original.remoteConfigurations)) {
            expect(output.remoteConfigurations![id]).not.toBe(original.remoteConfigurations[id]);
        }
    });

    it.each([false, true])(
        "retains named profile IDs when importing with connection sharing %s",
        (includeCredentials) => {
            const original = { ...settings(), remoteConfigurations: profilesWithSpecialIds() };
            const incoming: Pick<ObsidianLiveSyncSettings, "writeCredentialsForSettingSync" | "remoteConfigurations"> =
                {
                    writeCredentialsForSettingSync: includeCredentials,
                    remoteConfigurations: includeCredentials ? profilesWithSpecialIds() : {},
                };
            const output = mergeMarkdownSettings(incoming, original);
            expect(JSON.parse(JSON.stringify(output.remoteConfigurations))).toEqual(original.remoteConfigurations);
            expect(Object.getPrototypeOf(output.remoteConfigurations)).toBe(Object.prototype);
            for (const id of Object.keys(original.remoteConfigurations)) {
                const source = includeCredentials ? incoming.remoteConfigurations : original.remoteConfigurations;
                expect(output.remoteConfigurations[id]).not.toBe(source[id]);
            }
        }
    );

    it("retains local connections while applying ordinary settings", () => {
        const original = settings();
        const merged = mergeMarkdownSettings(
            {
                writeCredentialsForSettingSync: false,
                periodicReplicationInterval: 123,
                secretKey: "synthetic-incoming-key",
                remoteConfigurations: {},
            },
            original
        );
        expect(merged.periodicReplicationInterval).toBe(123);
        expect(merged.secretKey).toBe(original.secretKey);
        expect(merged.jwtKey).toBe(original.jwtKey);
        expect(merged.bucketCustomHeaders).toBe(original.bucketCustomHeaders);
        expect(merged.remoteConfigurations).toEqual(original.remoteConfigurations);
        expect(merged.remoteConfigurations).not.toBe(original.remoteConfigurations);
        expect(merged.activeConfigurationId).toBe(original.activeConfigurationId);
        expect(merged.additionalSuffixOfDatabaseName).toBe(original.additionalSuffixOfDatabaseName);
    });

    it("imports shared connection settings and retains device-local values", () => {
        const original = settings();
        const merged = mergeMarkdownSettings(
            {
                writeCredentialsForSettingSync: true,
                accessKey: "synthetic-shared-access",
                secretKey: "synthetic-shared-secret",
                additionalSuffixOfDatabaseName: "synthetic-incoming-suffix",
            },
            original
        );
        expect(merged.accessKey).toBe("synthetic-shared-access");
        expect(merged.secretKey).toBe("synthetic-shared-secret");
        expect(merged.additionalSuffixOfDatabaseName).toBe(original.additionalSuffixOfDatabaseName);
    });

    it("requires prepared settings before persistence", () => {
        expect(() => prepareSettingsForPersistence(settings())).toThrow("not prepared for persistence");
    });
});
