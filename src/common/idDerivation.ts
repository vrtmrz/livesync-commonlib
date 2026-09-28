import { getWebCrypto } from "@lib/mods.ts";
import { hexStringToUint8Array, uint8ArrayToHexString } from "@lib/string_and_binary/convert.ts";
import type { EncryptionSettings } from "@lib/common/models/setting.type.ts";

export const ID_DERIVATION_VERSION = 1;
const SOURCE_SALT = new TextEncoder().encode("self-hosted-livesync:id-source:v1");
const SOURCE_ITERATIONS = 310_000;
const HEX_KEY = /^[0-9a-f]{64}$/u;

/** Derive a portable key once, when the source string is saved. */
export async function deriveIdKey(source: string): Promise<string> {
    if (source.length === 0) {
        throw new Error("An ID source is required.");
    }
    const crypto = await getWebCrypto();
    const sourceKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(source.normalize("NFC")),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: SOURCE_SALT, iterations: SOURCE_ITERATIONS },
        sourceKey,
        256
    );
    return uint8ArrayToHexString(new Uint8Array(bits));
}

/** Return the independent ID key, rejecting an incomplete new-mode setting. */
export function configuredIdKey(
    settings: Pick<EncryptionSettings, "idDerivationVersion" | "idDerivationKey">
): string | false {
    const version = settings.idDerivationVersion;
    const key = settings.idDerivationKey;
    if (version === 0 || version === undefined) {
        if (key) throw new Error("An ID key requires a supported derivation version.");
        return false;
    }
    if (version !== ID_DERIVATION_VERSION || !HEX_KEY.test(key)) {
        throw new Error("The configured ID derivation is unavailable or invalid.");
    }
    return key;
}

/** Derive distinct identifiers for content and document paths from one saved key. */
export async function computeKeyedId(
    key: string,
    purpose: "chunk" | "document" | "peer-agreement" | "remote-agreement",
    value: string
): Promise<string> {
    if (!HEX_KEY.test(key)) throw new Error("The configured ID key is invalid.");
    const crypto = await getWebCrypto();
    const hmacKey = await crypto.subtle.importKey(
        "raw",
        hexStringToUint8Array(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const input = new TextEncoder().encode(`self-hosted-livesync:id-v1:${purpose}\0${value}`);
    const digest = await crypto.subtle.sign("HMAC", hmacKey, input);
    return uint8ArrayToHexString(new Uint8Array(digest));
}
