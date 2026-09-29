import qrcode from "qrcode-generator";
import { configURIBase, configURIBaseQR } from "@lib/common/types";
import { decodeAnyArray, encodeAnyArray } from "octagonal-wheels/object";
import {
    DEFAULT_SETTINGS,
    KeyIndexOfSettings,
    LOG_LEVEL_NOTICE,
    omitP2PRuntimeSettings,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { decryptString, encryptString } from "@lib/encryption/stringEncryption";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { configuredIdKey } from "@lib/common/idDerivation";

/**
 * Encode settings to a tiny array to encode in QRCode,
 * Due to size limitation of QR code, we encode settings as an array instead of object.
 * @param settings settings to encode
 */
export function encodeSettingsToQRCodeData(settings: ObsidianLiveSyncSettings) {
    settings = omitP2PRuntimeSettings(settings) as ObsidianLiveSyncSettings;
    configuredIdKey(settings);
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

    configuredIdKey(newSettings);
    return omitP2PRuntimeSettings(newSettings) as ObsidianLiveSyncSettings;
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

const SETUP_URI_WINDOW_MS = 604_800_000;

export type TimeBoundSetupURIMode = "ephemeral" | "persistent";

export interface TimeBoundSetupURIOptions {
    mode?: TimeBoundSetupURIMode;
    removeProperties?: ErasureProperties[];
    skipDefaultValue?: boolean;
}

export interface TimeBoundSetupURIResult {
    uri: string;
    usableUntil: number | null;
}

/** Return the exclusive end of the current fixed Setup URI window. */
export function getTimeBoundSetupURIUsableUntil(): number {
    const usableUntil = (setupURIWindow(Date.now()) + 1) * SETUP_URI_WINDOW_MS;
    if (!Number.isSafeInteger(usableUntil)) throw new Error("Invalid Setup URI clock");
    return usableUntil;
}

/** Check the same fixed window that the Setup URI reader uses. */
export function isTimeBoundSetupURIUsableNow(usableUntil: number | null): boolean {
    if (usableUntil === null) return true;
    if (!Number.isSafeInteger(usableUntil) || usableUntil < SETUP_URI_WINDOW_MS) return false;
    try {
        return setupURIWindow(Date.now()) === usableUntil / SETUP_URI_WINDOW_MS - 1;
    } catch {
        return false;
    }
}

function setupURIWindow(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid Setup URI clock");
    return Math.floor(now / SETUP_URI_WINDOW_MS);
}

async function ephemeralSetupURIPassphrase(passphrase: string, window: number): Promise<string> {
    const text = new TextEncoder();
    const keyBytes = await crypto.subtle.digest("SHA-256", text.encode(passphrase));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const context = JSON.stringify(["livesync/setup-uri", "tb1", "ephemeral", window]);
    const signed = await crypto.subtle.sign("HMAC", key, text.encode(context));
    return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Properties that will always be removed when encoding settings to setup URI
 * These properties generated by other informations, so this is meaningless to include them in the URI.
 */
const necessaryErasureProperties: ErasureProperties[] = [
    "configPassphraseStore",
    "encryptedCouchDBConnection",
    "encryptedPassphrase",
    "encryptedIdDerivationKey",
];

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
    const setting: Partial<ObsidianLiveSyncSettings> = {
        ...omitP2PRuntimeSettings(settingString),
    };
    configuredIdKey({
        idDerivationVersion: setting.idDerivationVersion ?? 0,
        idDerivationKey: setting.idDerivationKey ?? "",
    });
    delete setting.P2P_managedType;
    delete setting.P2P_managedId;
    delete setting.P2P_managedToken;
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
        //@ts-ignore
        setting[prop] = "";
    }
    const encryptedSetting = encodeURIComponent(await encryptString(JSON.stringify(setting), passphrase));
    const uri = `${configURIBase}${encryptedSetting} `;
    return uri;
}

/** Generate a Setup URI for the current UTC window or in the existing persistent format. */
export async function encodeTimeBoundSetupURI(
    settingString: ObsidianLiveSyncSettings,
    passphrase: string,
    options: TimeBoundSetupURIOptions = {}
): Promise<TimeBoundSetupURIResult> {
    const { mode = "ephemeral", removeProperties, skipDefaultValue } = options;
    if (mode === "persistent") {
        return {
            uri: await encodeSettingsToSetupURI(settingString, passphrase, removeProperties, skipDefaultValue),
            usableUntil: null,
        };
    }
    if (mode !== "ephemeral") throw new Error("Invalid Setup URI mode");

    const window = setupURIWindow(Date.now());
    const effectivePassphrase = await ephemeralSetupURIPassphrase(passphrase, window);
    const uri = await encodeSettingsToSetupURI(settingString, effectivePassphrase, removeProperties, skipDefaultValue);
    if (setupURIWindow(Date.now()) !== window) throw new Error("Setup URI window changed during generation");
    return { uri, usableUntil: (window + 1) * SETUP_URI_WINDOW_MS };
}

export async function decodeSettingsFromSetupURI(uri: string, passphrase: string) {
    const encryptedSetting = uri.substring(configURIBase.length);
    const encrypted = decodeURIComponent(encryptedSetting);
    let decrypted: string;
    if (encrypted.startsWith("%$")) {
        let window: number | undefined;
        try {
            window = setupURIWindow(Date.now());
        } catch {
            // Persistent URIs remain available even if the local clock is invalid.
        }

        const matches: { mode: TimeBoundSetupURIMode; value: string }[] = [];
        if (window !== undefined) {
            const candidate = await ephemeralSetupURIPassphrase(passphrase, window);
            try {
                matches.push({ mode: "ephemeral", value: await decryptString(encrypted, candidate) });
            } catch {
                // An authentication failure is expected for another mode or time window.
            }
        }
        try {
            matches.push({ mode: "persistent", value: await decryptString(encrypted, passphrase) });
        } catch {
            // Report one opening failure after both bounded candidates have been tried.
        }
        if (matches.length !== 1) throw new Error("Cannot open Setup URI");
        const matched = matches[0];
        if (matched.mode === "ephemeral" && setupURIWindow(Date.now()) !== window) {
            throw new Error("Cannot open Setup URI");
        }
        decrypted = matched.value;
    } else {
        decrypted = await decryptString(encrypted, passphrase);
    }
    try {
        const imported = JSON.parse(decrypted) as ObsidianLiveSyncSettings;
        const settings = {
            ...imported,
            encryptInternalMetadata:
                typeof imported.encryptInternalMetadata === "boolean" ? imported.encryptInternalMetadata : false,
            idDerivationVersion: imported.idDerivationVersion ?? 0,
            idDerivationKey: imported.idDerivationKey ?? "",
        };
        configuredIdKey(settings);
        return omitP2PRuntimeSettings(settings);
    } catch {
        // JSON parsing errors can include decrypted credentials in their message.
        Logger(`Failed to parse settings from decrypted data`, LOG_LEVEL_NOTICE);
        return false;
    }
}
