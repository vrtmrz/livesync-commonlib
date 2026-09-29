import { getWebCrypto } from "@lib/mods.ts";
import { hexStringToUint8Array, uint8ArrayToHexString } from "@lib/string_and_binary/convert.ts";
import type { EncryptionSettings } from "@lib/common/models/setting.type.ts";
import { xxhashNew } from "@lib/string_and_binary/hash.ts";

export const ID_DERIVATION_VERSION = 1;
export const ID_RECOVERY_CODE_PREFIX = "sls-id-v1:";
const SOURCE_SALT = new TextEncoder().encode("self-hosted-livesync:id-source:v1");
const SOURCE_ITERATIONS = 310_000;
const HEX_KEY = /^[0-9a-f]{64}$/u;
const CHUNK_KEY_CONTEXT = new TextEncoder().encode("self-hosted-livesync:id-v1:chunk-key:xxhash64");
const CHUNK_ID_PREFIX = "self-hosted-livesync:id-v1:chunk:xxhash64\0";

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

/** Export a saved key in a format which can be imported without deriving it again. */
export function formatIdRecoveryCode(key: string): string {
    if (!HEX_KEY.test(key)) throw new Error("The configured ID key is invalid.");
    return `${ID_RECOVERY_CODE_PREFIX}${key}`;
}

/** Treat a tagged recovery code as a saved key; derive ordinary source strings. */
export async function deriveOrImportIdKey(input: string): Promise<string> {
    const candidate = input.trim();
    if (candidate.startsWith(ID_RECOVERY_CODE_PREFIX)) {
        const key = candidate.slice(ID_RECOVERY_CODE_PREFIX.length);
        if (!HEX_KEY.test(key)) throw new Error("The ID recovery code is invalid.");
        return key;
    }
    if (candidate.startsWith("sls-id-v")) throw new Error("The ID recovery code version is unsupported.");
    return await deriveIdKey(input);
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

/** Prepare a purpose-separated Chunk key for repeated ID calculations. */
export async function createChunkIdGenerator(key: string): Promise<(value: string) => Promise<string>> {
    if (!HEX_KEY.test(key)) throw new Error("The configured ID key is invalid.");
    const crypto = await getWebCrypto();
    const masterKey = await crypto.subtle.importKey(
        "raw",
        hexStringToUint8Array(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const derivedKey = await crypto.subtle.sign("HMAC", masterKey, CHUNK_KEY_CONTEXT);
    const chunkKey = await crypto.subtle.importKey("raw", derivedKey, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
    ]);
    const xxhash = await xxhashNew();
    const encoder = new TextEncoder();
    return async (value) => {
        const digest = xxhash.h64(value).toString(16).padStart(16, "0");
        const id = await crypto.subtle.sign("HMAC", chunkKey, encoder.encode(CHUNK_ID_PREFIX + digest));
        return uint8ArrayToHexString(new Uint8Array(id));
    };
}

/** Derive purpose-separated IDs; repeated Chunk calculations should reuse a prepared generator. */
export async function computeKeyedId(
    key: string,
    purpose: "chunk" | "document" | "peer-agreement" | "remote-agreement",
    value: string
): Promise<string> {
    if (purpose === "chunk") return (await createChunkIdGenerator(key))(value);
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
