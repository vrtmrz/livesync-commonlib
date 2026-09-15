import qrcode from "qrcode-generator";
import { configURIBase, configURIBaseQR, configURIBaseV2, hasManagedP2PIceServerSource } from "@lib/common/types";
import { decodeAnyArray, encodeAnyArray } from "octagonal-wheels/object";
import {
    DEFAULT_SETTINGS,
    KeyIndexOfSettings,
    LOG_LEVEL_NOTICE,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { decryptString, encryptString } from "@lib/encryption/stringEncryption";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";

/**
 * Encode settings to a tiny array to encode in QRCode,
 * Due to size limitation of QR code, we encode settings as an array instead of object.
 * @param settings settings to encode
 */
export function encodeSettingsToQRCodeData(settings: ObsidianLiveSyncSettings) {
    if (hasManagedP2PIceServerSource(settings)) {
        throw new Error(
            "Managed P2P source profiles cannot be shared as a plain QR code. Use an encrypted Setup URI instead."
        );
    }

    const fullIndexes = Object.entries(KeyIndexOfSettings) as [keyof ObsidianLiveSyncSettings, number][];

    // Find the maximum index to properly size the array
    let maxIndex = 0;
    for (const [, index] of fullIndexes) {
        if (index >= 0 && index > maxIndex) {
            maxIndex = index;
        }
    }

    // Create a dense array with proper size
    const settingArr = new Array(maxIndex + 1).fill(undefined);

    for (const [settingKey, index] of fullIndexes) {
        const settingValue = settings[settingKey];
        if (index < 0) {
            // This setting should be ignored.
            continue;
        }
        settingArr[index] = settingValue;
    }
    return encodeAnyArray(settingArr);
}

/**
 * Decode settings from QR code data string
 * @param qr data string from QR code
 * @returns Decoded settings
 */
export function decodeSettingsFromQRCodeData(qr: string): ObsidianLiveSyncSettings {
    const settingArr = decodeAnyArray(qr);
    const fullIndexes = Object.entries(KeyIndexOfSettings) as [keyof ObsidianLiveSyncSettings, number][];
    const newSettings = { ...DEFAULT_SETTINGS } as ObsidianLiveSyncSettings;

    // Diagnostic: track which settings are missing due to array size
    const skippedSettings: string[] = [];

    for (const [settingKey, index] of fullIndexes) {
        if (index < 0) {
            // This setting should be ignored.
            continue;
        }
        if (index >= settingArr.length) {
            // Possibly a new setting added.
            skippedSettings.push(`${settingKey} (index ${index})`);
            continue;
        }
        const settingValue = settingArr[index];
        //@ts-ignore
        newSettings[settingKey] = settingValue;
    }

    // Log warning if critical settings were skipped
    if (skippedSettings.length > 0) {
        Logger(
            `Warning: ${skippedSettings.length} settings were skipped during QR decode (array length: ${settingArr.length}): ${skippedSettings.slice(0, 5).join(", ")}${skippedSettings.length > 5 ? "..." : ""}`,
            LOG_LEVEL_VERBOSE
        );
    }

    if (hasManagedP2PIceServerSource(newSettings)) {
        throw new Error(
            "Managed P2P source profiles cannot be imported from a plain QR code. Use an encrypted Setup URI instead."
        );
    }

    return newSettings;
}

export enum OutputFormat {
    SVG = 0,
    ASCII = 1,
}

const AGGREGATOR_URL = "https://vrtmrz.github.io/obsidian-livesync/aggregator.html";

export interface SplitQRCodeData {
    total: number;
    parts: string[];
}

/**
 * Encode setting string to QR code in specified format
 * @param settingString Setting string to encode
 * @param format Output format
 */
export function encodeQR(settingString: string, format: OutputFormat): string | SplitQRCodeData {
    const tryEncode = (data: string) => {
        const qr = qrcode(0, "L");
        qr.addData(data);
        qr.make();
        if (format === OutputFormat.SVG) {
            return qr.createSvgTag(3);
        } else if (format === OutputFormat.ASCII) {
            return qr.createASCII(3);
        }
        return "";
    };

    const uri = `${configURIBaseQR}${encodeURIComponent(settingString)}`;
    try {
        return tryEncode(uri);
    } catch (ex) {
        // Fallback to aggregator
        Logger(`QR Code size exceeded, switching to aggregator mode`, LOG_LEVEL_NOTICE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        const id = Math.random().toString(36).substring(2, 10);
        const data = encodeURIComponent(settingString);
        const chunkSize = 2000; // Safe data amount per QR code (QR Version 40, L, Binary can hold up to ~2953 bytes)
        const total = Math.ceil(data.length / chunkSize);
        const parts: string[] = [];

        for (let i = 0; i < total; i++) {
            const chunk = data.substring(i * chunkSize, (i + 1) * chunkSize);
            const partUri = `${AGGREGATOR_URL}#id=${id}&n=${total}&i=${i}&d=${chunk}`;
            try {
                parts.push(tryEncode(partUri));
            } catch (ex2) {
                Logger(`Failed to encode split QR Code (${(ex2 as any)?.message || String(ex2)})`, LOG_LEVEL_NOTICE);
                return "";
            }
        }
        return { total, parts };
    }
}

type ErasureProperties = keyof ObsidianLiveSyncSettings;

/**
 * Properties that will always be removed when encoding settings to setup URI
 * These properties generated by other informations, so this is meaningless to include them in the URI.
 */
const necessaryErasureProperties: ErasureProperties[] = [
    "configPassphraseStore",
    "encryptedCouchDBConnection",
    "encryptedPassphrase",
    "encryptedP2PIceServerSource",
];

export const SETUP_SETTINGS_ENVELOPE_VERSION = 2 as const;

/** Versioned payload used by Setup URIs which include managed P2P sources. */
export interface SetupSettingsEnvelope {
    version: typeof SETUP_SETTINGS_ENVELOPE_VERSION;
    settings: ObsidianLiveSyncSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Generate setup URI with encrypted settings
 * @param settingString Settings to encode
 * @param passphrase Passphrase to encrypt the settings
 * @param removeProperties Properties to remove from the settings
 * Means these properties will not be included in the generated setup URI,
 * See also necessaryErasureProperties for properties that will always be removed.
 * @param skipDefaultValue Whether to skip default values
 * @returns Generated setup URI
 */
export async function encodeSettingsToSetupURI(
    settingString: ObsidianLiveSyncSettings,
    passphrase: string,
    removeProperties: ErasureProperties[] = ["pluginSyncExtendedSetting"],
    skipDefaultValue = false
) {
    if (
        !settingString.P2P_iceServerSource &&
        typeof settingString.encryptedP2PIceServerSource === "string" &&
        settingString.encryptedP2PIceServerSource !== ""
    ) {
        throw new Error("Managed P2P source data must be decrypted before creating a Setup URI.");
    }
    const managedSourcePresent = hasManagedP2PIceServerSource(settingString);
    const setting = {
        ...settingString,
    };
    if (skipDefaultValue) {
        const keys = Object.keys(setting) as (keyof ObsidianLiveSyncSettings)[];
        for (const k of keys) {
            if (
                JSON.stringify(k in setting ? setting[k] : "") ==
                JSON.stringify(k in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[k] : "*")
            ) {
                delete setting[k];
            }
        }
    }
    for (const prop of [...removeProperties]) {
        delete setting[prop];
    }
    for (const prop of necessaryErasureProperties) {
        if (prop === "encryptedP2PIceServerSource") {
            delete setting[prop];
            continue;
        }
        if (!(prop in setting)) continue;
        //@ts-ignore
        setting[prop] = "";
    }
    const payload: ObsidianLiveSyncSettings | SetupSettingsEnvelope = managedSourcePresent
        ? {
              version: SETUP_SETTINGS_ENVELOPE_VERSION,
              settings: setting,
          }
        : setting;
    const encryptedSetting = encodeURIComponent(await encryptString(JSON.stringify(payload), passphrase));
    const uri = `${managedSourcePresent ? configURIBaseV2 : configURIBase}${encryptedSetting} `;
    return uri;
}

async function decryptSetupPayload(uri: string, passphrase: string, base: string): Promise<unknown> {
    const trimmedURI = uri.trim();
    if (!trimmedURI.startsWith(base)) {
        throw new Error(`Unsupported Setup URI. Expected ${base}`);
    }
    const encryptedSetting = trimmedURI.substring(base.length);
    const decrypted = await decryptString(decodeURIComponent(encryptedSetting), passphrase);
    return JSON.parse(decrypted) as unknown;
}

/**
 * Decrypt and validate the versioned Setup URI envelope used for managed P2P
 * sources. A false result means the URI was not a valid v2 envelope.
 */
export async function decodeSettingsFromSetupURIV2(
    uri: string,
    passphrase: string
): Promise<SetupSettingsEnvelope | false> {
    try {
        const payload = await decryptSetupPayload(uri, passphrase, configURIBaseV2);
        if (!isRecord(payload) || payload.version !== SETUP_SETTINGS_ENVELOPE_VERSION || !isRecord(payload.settings)) {
            return false;
        }
        return {
            version: SETUP_SETTINGS_ENVELOPE_VERSION,
            settings: payload.settings as unknown as ObsidianLiveSyncSettings,
        };
    } catch {
        // Keep decryption and parsing failures opaque: a malformed payload can
        // contain provider credentials, and error objects are not safe logs.
        Logger(`Failed to decode versioned settings from Setup URI`, LOG_LEVEL_NOTICE);
        return false;
    }
}

/** Decrypt either a legacy Setup URI or the validated managed-source v2 form. */
export async function decodeSettingsFromSetupURI(uri: string, passphrase: string) {
    const trimmedURI = uri.trim();
    if (trimmedURI.startsWith(configURIBaseV2)) {
        const envelope = await decodeSettingsFromSetupURIV2(trimmedURI, passphrase);
        return envelope ? envelope.settings : false;
    }
    try {
        const payload = await decryptSetupPayload(trimmedURI, passphrase, configURIBase);
        if (!isRecord(payload)) {
            throw new Error("Decrypted Setup URI payload is not an object.");
        }
        return payload as unknown as ObsidianLiveSyncSettings;
    } catch (e) {
        Logger(`Failed to parse settings from decrypted data`, LOG_LEVEL_NOTICE);
        Logger(e, LOG_LEVEL_VERBOSE);
        return false;
    }
}
