import { Logger } from "./logger.ts";
import { LOG_LEVEL_VERBOSE } from "./types.ts";

import { uint8ArrayToHexString, writeString, atob, hexStringToUint8Array, readString, arrayBufferToBase64Single, decodeBinary, encodeBinaryEach } from "./strbin.ts";
import { webcrypto } from "./mods.ts";


export type encodedData = [encryptedData: string, iv: string, salt: string];
export type KeyBuffer = {
    key: CryptoKey;
    salt: Uint8Array;
    count: number;
};

const KeyBuffs = new Map<string, KeyBuffer>();
const decKeyBuffs = new Map<string, KeyBuffer>();

const KEY_RECYCLE_COUNT = 100;

let semiStaticFieldBuffer: Uint8Array;
const nonceBuffer: Uint32Array = new Uint32Array(1);

// const tex = new TextEncoder();
// const tdx = new TextDecoder();

export async function getKeyForEncrypt(passphrase: string, autoCalculateIterations: boolean): Promise<[CryptoKey, Uint8Array]> {
    // For performance, the plugin reuses the key KEY_RECYCLE_COUNT times.
    const buffKey = `${passphrase}-${autoCalculateIterations}`;
    const f = KeyBuffs.get(buffKey);
    if (f) {
        f.count--;
        if (f.count > 0) {
            return [f.key, f.salt];
        }
        f.count--;
    }
    const passphraseLen = 15 - passphrase.length;
    const iteration = autoCalculateIterations ? ((passphraseLen > 0 ? passphraseLen : 0) * 1000) + 121 - passphraseLen : 100000;
    const passphraseBin = new TextEncoder().encode(passphrase);
    const digest = await webcrypto.subtle.digest({ name: "SHA-256" }, passphraseBin);
    const keyMaterial = await webcrypto.subtle.importKey("raw", digest, { name: "PBKDF2" }, false, ["deriveKey"]);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await webcrypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: iteration,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );
    KeyBuffs.set(buffKey, {
        key,
        salt,
        count: KEY_RECYCLE_COUNT,
    });
    return [key, salt];
}
let keyGCCount = KEY_RECYCLE_COUNT * 5;
let decKeyIdx = 0;
let decKeyMin = 0;
export async function getKeyForDecryption(passphrase: string, salt: Uint8Array, autoCalculateIterations: boolean): Promise<[CryptoKey, Uint8Array]> {

    keyGCCount--;
    if (keyGCCount < 0) {
        keyGCCount = KEY_RECYCLE_COUNT;
        // drop 50% of cache.
        const threshold = (decKeyIdx - decKeyMin) / 2;
        for (const [key, buff] of decKeyBuffs) {
            if (buff.count < threshold) {
                decKeyBuffs.delete(key);
            }
            decKeyMin = decKeyIdx;
        }
    }
    decKeyIdx++;
    const bufKey = passphrase + uint8ArrayToHexString(salt) + autoCalculateIterations;
    const f = decKeyBuffs.get(bufKey);
    if (f) {
        f.count = decKeyIdx;
        return [f.key, f.salt];
    }
    const passphraseLen = 15 - passphrase.length;
    const iteration = autoCalculateIterations ? ((passphraseLen > 0 ? passphraseLen : 0) * 1000) + 121 - passphraseLen : 100000;

    const passphraseBin = new TextEncoder().encode(passphrase);
    const digest = await webcrypto.subtle.digest({ name: "SHA-256" }, passphraseBin);
    const keyMaterial = await webcrypto.subtle.importKey("raw", digest, { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await webcrypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: iteration,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );
    decKeyBuffs.set(bufKey, {
        key,
        salt,
        count: 0,
    });
    return [key, salt];
}

function getSemiStaticField(reset?: boolean) {
    // return fixed field of iv.
    if (semiStaticFieldBuffer != null && !reset) {
        return semiStaticFieldBuffer;
    }
    semiStaticFieldBuffer = webcrypto.getRandomValues(new Uint8Array(12));
    return semiStaticFieldBuffer;
}

function getNonce() {
    // This is nonce, so do not send same thing.
    nonceBuffer[0]++;
    if (nonceBuffer[0] > 10000) {
        // reset semi-static field.
        getSemiStaticField(true);
    }
    return nonceBuffer;
}

export async function encryptV1(input: string, passphrase: string, autoCalculateIterations: boolean) {
    const [key, salt] = await getKeyForEncrypt(passphrase, autoCalculateIterations);
    // Create initial vector with semi-fixed part and incremental part
    // I think it's not good against related-key attacks.
    const fixedPart = getSemiStaticField();
    const invocationPart = getNonce();
    const iv = new Uint8Array([...fixedPart, ...new Uint8Array(invocationPart.buffer)]);
    const plainStringified = JSON.stringify(input);
    const plainStringBuffer: Uint8Array = writeString(plainStringified);
    const encryptedDataArrayBuffer = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainStringBuffer);
    const encryptedData2 = (await arrayBufferToBase64Single(encryptedDataArrayBuffer));
    const ret = `["${encryptedData2}","${uint8ArrayToHexString(iv)}","${uint8ArrayToHexString(salt)}"]`;
    return ret;
}
export async function encrypt(input: string, passphrase: string, autoCalculateIterations: boolean, useV1: boolean) {
    if (useV1) return encryptV1(input, passphrase, autoCalculateIterations);
    const [key, salt] = await getKeyForEncrypt(passphrase, autoCalculateIterations);
    // Create initial vector with semi-fixed part and incremental part
    // I think it's not good against related-key attacks.
    const fixedPart = getSemiStaticField();
    const invocationPart = getNonce();
    const iv = new Uint8Array([...fixedPart, ...new Uint8Array(invocationPart.buffer)]);
    const dataBuf = writeString(input)
    const encryptedDataArrayBuffer = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dataBuf);
    const encryptedData2 = "%" + await encodeBinaryEach(new Uint8Array(encryptedDataArrayBuffer));
    // return data with iv and salt.
    // |%| iv(32) | salt(32) | data ....  
    const ret = `%${uint8ArrayToHexString(iv)}${uint8ArrayToHexString(salt)}${encryptedData2}`;
    return ret;
}

async function decryptV2(encryptedResult: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    try {
        const ivStr = encryptedResult.substring(1, 33);
        const salt = encryptedResult.substring(33, 65);
        const encryptedData = encryptedResult.substring(65);
        const [key] = await getKeyForDecryption(passphrase, hexStringToUint8Array(salt), autoCalculateIterations);
        const iv = hexStringToUint8Array(ivStr);
        const encryptedDataArrayBuffer = decodeBinary(encryptedData)
        const dataBuffer = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedDataArrayBuffer);
        const plain = readString(new Uint8Array(dataBuffer));
        return plain;
    } catch (ex) {
        Logger("Couldn't decode! You should wrong the passphrases (V2)", LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        throw ex;
    }
}

export async function decrypt(encryptedResult: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    try {
        if (encryptedResult[0] == "%") {
            return decryptV2(encryptedResult, passphrase, autoCalculateIterations);
        }
        if (!encryptedResult.startsWith("[") || !encryptedResult.endsWith("]")) {
            throw new Error("Encrypted data corrupted!");
        }
        const w: any = encryptedResult.substring(1, encryptedResult.length - 1).split(",").map(e => e[0] == '"' ? e.substring(1, e.length - 1) : e);
        const [encryptedData, ivString, salt]: encodedData = w;
        const [key] = await getKeyForDecryption(passphrase, hexStringToUint8Array(salt), autoCalculateIterations);
        const iv = hexStringToUint8Array(ivString);
        // decode base 64, it should increase speed and i should with in MAX_DOC_SIZE_BIN, so it won't OOM.
        const encryptedDataBin = atob(encryptedData);
        const len = encryptedDataBin.length;
        const encryptedDataArrayBuffer = new Uint8Array(len);
        // converting binary string to arraybuffer
        for (let i = len; i >= 0; --i) {
            encryptedDataArrayBuffer[i] = encryptedDataBin.charCodeAt(i);
        }
        const plainStringBuffer: ArrayBuffer = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedDataArrayBuffer);
        const plainStringified = readString(new Uint8Array(plainStringBuffer));
        const plain = JSON.parse(plainStringified);
        return plain;
    } catch (ex) {
        Logger("Couldn't decode! You should wrong the passphrases", LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        throw ex;
    }
}

export async function tryDecrypt(encryptedResult: string, passphrase: string | false, autoCalculateIterations: boolean): Promise<string | false> {
    if (!passphrase) return false;
    try {
        return await decrypt(encryptedResult, passphrase, autoCalculateIterations);
    } catch (ex) {
        return false;
    }
}
export async function testCrypt() {
    const src = "supercalifragilisticexpialidocious";

    const encoded = await encrypt(src, "passwordTest", false, false);
    const encoded2 = await encrypt(src, "passwordTest", false, true);
    const decrypted = await decrypt(encoded, "passwordTest", false);
    const decrypted2 = await decrypt(encoded2, "passwordTest", false);

    if (src != decrypted || src != decrypted2) {
        Logger("WARNING! Your device would not support encryption.", LOG_LEVEL_VERBOSE);
        return false;
    } else {
        Logger("CRYPT LOGIC OK", LOG_LEVEL_VERBOSE);
        return true;
    }
}
