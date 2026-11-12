import { configuredIdKey } from "@lib/common/idDerivation.ts";
import { omitP2PRuntimeSettings, type ObsidianLiveSyncSettings, type P2PSyncSetting } from "@lib/common/types";
import type { Confirm } from "@lib/interfaces/Confirm";
import { skipIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import { decryptWithEphemeralSalt, encryptWithEphemeralSalt } from "octagonal-wheels/encryption/hkdf";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { toP2PWireError } from "../P2PReplicationWire";

const SHARE_PASSPHRASE_KEY = "P2P.AskPassphraseForShare" as const;
const DECRYPT_PASSPHRASE_KEY = "P2P.AskPassphraseForDecrypt" as const;

type ConfigurationExchangeHost = {
    requestConfiguration(peerId: string, timeoutMs: number): Promise<unknown>;
};

type ConfigurationExchangeDependencies = {
    isSetup(): boolean;
    /** Return the immutable settings snapshot associated with this room. */
    settings(): P2PSyncSetting;
    askString: Confirm["askString"];
    translate(key: typeof SHARE_PASSPHRASE_KEY | typeof DECRYPT_PASSPHRASE_KEY): string;
    host(): ConfigurationExchangeHost | undefined;
};

type ShareConfigurationResult = string | { error: ReturnType<typeof toP2PWireError> };

async function encrypt(data: string, passphrase: string) {
    return await encryptWithEphemeralSalt(data, passphrase, true);
}

async function decrypt(encryptedData: string, passphrase: string) {
    return await decryptWithEphemeralSalt(encryptedData, passphrase);
}

/**
 * Create the room-scoped settings transfer operations without prompting or contacting a peer.
 *
 * The sharing boundary omits P2P runtime credentials and clears the established local secret fields.
 * Saved remote profile URIs remain part of the exported settings. The supplied settings getter must
 * return the immutable snapshot for the room, rather than settings from a later room or editor state.
 */
export function createConfigurationExchange(dependencies: ConfigurationExchangeDependencies) {
    /**
     * Ask a peer-scoped sharing prompt, then encrypt the room snapshot after the prompt settles.
     *
     * Blank, cancelled, and duplicate prompts deliberately produce an encrypted masked decoy. The
     * returned string is only the RPC payload; it does not apply settings on the receiving device.
     */
    const shareConfiguration = async (fromPeerId: string): Promise<ShareConfigurationResult> => {
        if (dependencies.isSetup()) {
            return { error: toP2PWireError(new Error("The setup is in progress")) };
        }
        const passphrase = await skipIfDuplicated(`getAllConfig-${fromPeerId}`, async () => {
            return await dependencies.askString(
                "Passphrase required",
                dependencies.translate(SHARE_PASSPHRASE_KEY),
                "something you only know",
                true
            );
        });
        // Read the room snapshot after the prompt settles, preserving the settings used by this peer's room.
        const setting = {
            ...omitP2PRuntimeSettings(dependencies.settings()),
            configPassphraseStore: "",
            encryptedCouchDBConnection: "",
            encryptedPassphrase: "",
            pluginSyncExtendedSetting: {},
        } as Partial<ObsidianLiveSyncSettings>;
        delete setting.P2P_managedType;
        delete setting.P2P_managedId;
        delete setting.P2P_managedToken;
        if (!passphrase || passphrase.trim() == "") {
            Logger(
                "Passphrase is required to transfer the configuration. The peer cannot be decrypt the config\nIf you repeatedly receive unintended configuration-sharing requests, change the RPC channel immediately. It allows you to leave the connection and disappear, while they are trying brute force attack for the decoy on their local.",
                LOG_LEVEL_NOTICE
            );
            const decoy = JSON.stringify(
                Object.fromEntries(
                    Object.entries(setting).map(([key]) => {
                        return [key, "******".repeat(Math.ceil(Math.random() * 10) + 2)];
                    })
                )
            );
            const randomPassphrase = Math.random().toString(36).substring(7);
            // Return masked fields under a random passphrase instead of sharing settings after a declined prompt.
            return encrypt(decoy, randomPassphrase);
        }
        return encrypt(JSON.stringify(setting), passphrase.trim());
    };

    /**
     * Request and validate a peer's settings without applying them to the local device.
     *
     * The remote request and password prompt remain outside the decrypt/parse/validation catch so
     * transport and prompt rejections propagate. A missing host or empty passphrase returns false;
     * decryption, parsing, and ID-validation failures also return false. Success means
     * a parsed configuration with validated ID-key fields and runtime ICE data omitted.
     * The host remains responsible for persisting or activating those settings.
     */
    const getRemoteConfig = async (peerId: string): Promise<ObsidianLiveSyncSettings | false> => {
        const host = dependencies.host();
        if (!host) {
            Logger("Server is not available", LOG_LEVEL_NOTICE);
            return false;
        }
        const encryptedConfig = await host.requestConfiguration(peerId, 0);
        const passphrase = await dependencies.askString(
            "Passphrase required",
            dependencies.translate(DECRYPT_PASSPHRASE_KEY),
            "something you only know",
            true
        );
        if (!passphrase || passphrase.trim() == "") {
            Logger(
                "Passphrase is required to decrypt the configuration. The config cannot be decrypted",
                LOG_LEVEL_NOTICE
            );
            return false;
        }
        // Fetch and prompt failures propagate; only decryption, parsing, and configuration validation become false.
        try {
            const decryptedConfig = JSON.parse(
                await decrypt(encryptedConfig as string, passphrase)
            ) as ObsidianLiveSyncSettings;
            const settings = {
                ...decryptedConfig,
                idDerivationVersion: decryptedConfig.idDerivationVersion ?? 0,
                idDerivationKey: decryptedConfig.idDerivationKey ?? "",
            };
            configuredIdKey(settings);
            return omitP2PRuntimeSettings(settings) as ObsidianLiveSyncSettings;
        } catch (e) {
            Logger("Error while decrypting the configuration", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            return false;
        }
    };

    return { shareConfiguration, getRemoteConfig };
}
