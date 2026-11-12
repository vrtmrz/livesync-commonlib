import { describe, expect, it, vi } from "vitest";
import { decryptWithEphemeralSalt, encryptWithEphemeralSalt } from "octagonal-wheels/encryption/hkdf";
import type { P2PSyncSetting } from "@lib/common/types";
import { createConfigurationExchange } from "./configurationExchange";

type ConfigurationExchangeDependencies = Parameters<typeof createConfigurationExchange>[0];

function makeRoomSettings(values: Record<string, unknown> = {}): P2PSyncSetting {
    return {
        P2P_AutoAccepting: "off",
        P2P_AutoSyncPeers: "",
        P2P_AutoWatchPeers: "",
        P2P_SyncOnReplication: "",
        P2P_RebuildFrom: "",
        P2P_AutoAcceptingPeers: "",
        P2P_AutoDenyingPeers: "",
        databaseName: "room-database",
        ...values,
    } as unknown as P2PSyncSetting;
}

function makeDependencies(overrides: Partial<ConfigurationExchangeDependencies> = {}) {
    return {
        isSetup: vi.fn(() => false),
        settings: vi.fn(() => makeRoomSettings()),
        askString: vi.fn(async () => "share-pass"),
        translate: vi.fn((key) => key),
        host: vi.fn(() => undefined),
        ...overrides,
    } satisfies ConfigurationExchangeDependencies;
}

async function encryptConfiguration(configuration: Record<string, unknown>, passphrase = "transfer-passphrase") {
    return await encryptWithEphemeralSalt(JSON.stringify(configuration), passphrase, true);
}

describe("createConfigurationExchange", () => {
    it("constructs without IO and reads the room settings only after the sharing prompt", async () => {
        const stages: string[] = [];
        const dependencies = makeDependencies({
            settings: vi.fn(() => {
                stages.push("settings");
                return makeRoomSettings();
            }),
            askString: vi.fn(async () => {
                stages.push("prompt");
                return "share-pass";
            }),
        });

        const exchange = createConfigurationExchange(dependencies);

        expect(dependencies.isSetup).not.toHaveBeenCalled();
        expect(dependencies.settings).not.toHaveBeenCalled();
        expect(dependencies.askString).not.toHaveBeenCalled();
        expect(dependencies.translate).not.toHaveBeenCalled();
        expect(dependencies.host).not.toHaveBeenCalled();

        await exchange.shareConfiguration("snapshot-peer");

        expect(stages.indexOf("prompt")).toBeGreaterThanOrEqual(0);
        expect(stages.indexOf("settings")).toBeGreaterThan(stages.indexOf("prompt"));
    });

    it("returns the setup wire error without prompting or reading settings", async () => {
        const dependencies = makeDependencies({ isSetup: vi.fn(() => true) });
        const exchange = createConfigurationExchange(dependencies);

        const result = await exchange.shareConfiguration("setup-peer");

        expect(result).toMatchObject({ error: { code: "REMOTE_ERROR", message: "The setup is in progress" } });
        expect(dependencies.askString).not.toHaveBeenCalled();
        expect(dependencies.settings).not.toHaveBeenCalled();
    });

    it("clears local secrets and top-level managed fields while retaining saved profile URIs", async () => {
        const profileUri = "sls+p2p://room?managedType=CF&managedId=profile-key&token=profile-token";
        const dependencies = makeDependencies({
            settings: vi.fn(() =>
                makeRoomSettings({
                    configPassphraseStore: "local-passphrase-store",
                    encryptedCouchDBConnection: "encrypted-connection",
                    encryptedPassphrase: "encrypted-passphrase",
                    pluginSyncExtendedSetting: { localSecret: "plugin-secret" },
                    P2P_managedType: "CF",
                    P2P_managedId: "managed-id",
                    P2P_managedToken: "top-level-token",
                    P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
                    P2P_iceServersExpiresAt: 123_456,
                    remoteConfigurations: {
                        p2p: { id: "p2p", name: "Managed P2P", uri: profileUri, isEncrypted: false },
                    },
                })
            ),
            askString: vi.fn(async () => "  share-pass  "),
        });
        const exchange = createConfigurationExchange(dependencies);

        const encrypted = await exchange.shareConfiguration("secrets-peer");
        const shared = JSON.parse(await decryptWithEphemeralSalt(encrypted as string, "share-pass"));

        expect(shared.configPassphraseStore).toBe("");
        expect(shared.encryptedCouchDBConnection).toBe("");
        expect(shared.encryptedPassphrase).toBe("");
        expect(shared.pluginSyncExtendedSetting).toEqual({});
        expect(shared).not.toHaveProperty("P2P_managedType");
        expect(shared).not.toHaveProperty("P2P_managedId");
        expect(shared).not.toHaveProperty("P2P_managedToken");
        expect(shared).not.toHaveProperty("P2P_iceServers");
        expect(shared).not.toHaveProperty("P2P_iceServersExpiresAt");
        expect(shared.remoteConfigurations.p2p.uri).toBe(profileUri);
    });

    it.each([false, ""])("encrypts a masked decoy when sharing is declined with %s", async (answer) => {
        const dependencies = makeDependencies({ askString: vi.fn(async () => answer) });
        const exchange = createConfigurationExchange(dependencies);
        const random = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

        try {
            const encrypted = await exchange.shareConfiguration("declined-peer");
            const decoyPassphrase = (0.123456789).toString(36).substring(7);
            const decoy = JSON.parse(await decryptWithEphemeralSalt(encrypted as string, decoyPassphrase));

            expect(Object.values(decoy).every((value) => typeof value === "string" && /^(\*{6})+$/.test(value))).toBe(
                true
            );
            expect(dependencies.settings).toHaveBeenCalledTimes(1);
        } finally {
            random.mockRestore();
        }
    });

    it("encrypts a duplicate prompt as a masked decoy instead of sharing real settings", async () => {
        let releasePrompt!: (answer: string | false) => void;
        const pendingPrompt = new Promise<string | false>((resolve) => {
            releasePrompt = resolve;
        });
        const dependencies = makeDependencies({
            askString: vi.fn(() => pendingPrompt),
            settings: vi.fn(() => makeRoomSettings({ databaseName: "real-room-database" })),
        });
        const exchange = createConfigurationExchange(dependencies);
        const firstRequest = exchange.shareConfiguration("duplicate-peer");
        const random = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

        try {
            await vi.waitFor(() => expect(dependencies.askString).toHaveBeenCalledTimes(1));
            const duplicatePayload = await exchange.shareConfiguration("duplicate-peer");
            const decoyPassphrase = (0.123456789).toString(36).substring(7);
            const decoy = JSON.parse(await decryptWithEphemeralSalt(duplicatePayload as string, decoyPassphrase));

            expect(Object.values(decoy).every((value) => typeof value === "string" && /^(\*{6})+$/.test(value))).toBe(
                true
            );
            expect(dependencies.settings).toHaveBeenCalledTimes(1);
        } finally {
            random.mockRestore();
            releasePrompt("share-pass");
        }

        const firstPayload = await firstRequest;
        const shared = JSON.parse(await decryptWithEphemeralSalt(firstPayload as string, "share-pass"));
        expect(shared.databaseName).toBe("real-room-database");
        expect(dependencies.settings).toHaveBeenCalledTimes(2);
    });

    it("forwards an import request to the host with timeout zero", async () => {
        const requestConfiguration = vi.fn(async () => "invalid-ciphertext");
        const dependencies = makeDependencies({
            host: vi.fn(() => ({ requestConfiguration })),
        });
        const exchange = createConfigurationExchange(dependencies);

        expect(await exchange.getRemoteConfig("remote-peer")).toBe(false);
        expect(requestConfiguration).toHaveBeenCalledExactlyOnceWith("remote-peer", 0);
        expect(dependencies.askString).toHaveBeenCalledTimes(1);
    });

    it.each([false, ""])(
        "returns false without decrypting when the import passphrase is blank (%s)",
        async (answer) => {
            const requestConfiguration = vi.fn(async () => "invalid-ciphertext");
            const dependencies = makeDependencies({
                host: vi.fn(() => ({ requestConfiguration })),
                askString: vi.fn(async () => answer),
            });
            const exchange = createConfigurationExchange(dependencies);

            expect(await exchange.getRemoteConfig("blank-passphrase-peer")).toBe(false);
            expect(requestConfiguration).toHaveBeenCalledExactlyOnceWith("blank-passphrase-peer", 0);
        }
    );

    it("returns false without prompting when no host is available", async () => {
        const dependencies = makeDependencies();
        const exchange = createConfigurationExchange(dependencies);

        expect(await exchange.getRemoteConfig("remote-peer")).toBe(false);
        expect(dependencies.host).toHaveBeenCalledExactlyOnceWith();
        expect(dependencies.askString).not.toHaveBeenCalled();
    });

    it("defaults legacy ID settings, retains managed settings, and omits only runtime ICE data", async () => {
        const imported = {
            encrypt: true,
            P2P_managedType: "CF",
            P2P_managedId: "managed-id",
            P2P_managedToken: "managed-token",
            P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
            P2P_iceServersExpiresAt: 456_789,
        };
        const encrypted = await encryptConfiguration(imported);
        const dependencies = makeDependencies({
            host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => encrypted) })),
            askString: vi.fn(async () => "transfer-passphrase"),
        });
        const exchange = createConfigurationExchange(dependencies);

        const result = await exchange.getRemoteConfig("legacy-peer");

        expect(result).toMatchObject({
            encrypt: true,
            idDerivationVersion: 0,
            idDerivationKey: "",
            P2P_managedType: "CF",
            P2P_managedId: "managed-id",
            P2P_managedToken: "managed-token",
        });
        expect(result).not.toHaveProperty("P2P_iceServers");
        expect(result).not.toHaveProperty("P2P_iceServersExpiresAt");
    });

    it("accepts a valid configured ID key and rejects incomplete or unsupported derivation settings", async () => {
        const valid = await importRemoteConfiguration({ idDerivationVersion: 1, idDerivationKey: "ab".repeat(32) });
        expect(valid).toMatchObject({ idDerivationVersion: 1, idDerivationKey: "ab".repeat(32) });

        for (const configuration of [
            { idDerivationVersion: 1 },
            { idDerivationVersion: 1, idDerivationKey: "invalid" },
            { idDerivationVersion: 2, idDerivationKey: "ab".repeat(32) },
        ]) {
            expect(await importRemoteConfiguration(configuration)).toBe(false);
        }
    });

    it("uses the untrimmed decrypt passphrase after checking that it is not blank", async () => {
        const encrypted = await encryptConfiguration({ encrypt: true }, "  transfer-passphrase  ");
        const dependencies = makeDependencies({
            host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => encrypted) })),
            askString: vi.fn(async () => "  transfer-passphrase  "),
        });
        const exchange = createConfigurationExchange(dependencies);

        expect(await exchange.getRemoteConfig("whitespace-peer")).toMatchObject({ encrypt: true });
    });

    it("propagates RPC and prompt rejections but converts decrypt failures to false", async () => {
        const rpcError = new Error("RPC failed");
        const rpcFailure = createConfigurationExchange(
            makeDependencies({
                host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => Promise.reject(rpcError)) })),
            })
        );
        await expect(rpcFailure.getRemoteConfig("rpc-error-peer")).rejects.toBe(rpcError);

        const promptError = new Error("Prompt failed");
        const promptFailure = createConfigurationExchange(
            makeDependencies({
                host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => "ciphertext") })),
                askString: vi.fn(async () => Promise.reject(promptError)),
            })
        );
        await expect(promptFailure.getRemoteConfig("prompt-error-peer")).rejects.toBe(promptError);

        const decryptFailure = createConfigurationExchange(
            makeDependencies({
                host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => "not-encrypted") })),
            })
        );
        expect(await decryptFailure.getRemoteConfig("decrypt-error-peer")).toBe(false);
    });
});

async function importRemoteConfiguration(configuration: Record<string, unknown>) {
    const encrypted = await encryptConfiguration(configuration);
    const exchange = createConfigurationExchange(
        makeDependencies({
            host: vi.fn(() => ({ requestConfiguration: vi.fn(async () => encrypted) })),
            askString: vi.fn(async () => "transfer-passphrase"),
        })
    );
    return await exchange.getRemoteConfig("import-peer");
}
