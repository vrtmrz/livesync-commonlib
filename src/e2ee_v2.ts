import { Logger } from "./logger";
import { LOG_LEVEL } from "./types";
import { webcrypto as crypto_ } from "crypto";

let webcrypto: Crypto;

if (typeof window !== "undefined" && window.crypto) {
    webcrypto = window.crypto;
} else {
    const crypto = crypto_;
    //@ts-ignore
    webcrypto = crypto;
}

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

export async function getKeyForEncrypt(passphrase: string): Promise<[CryptoKey, Uint8Array]> {
    // For performance, the plugin reuses the key KEY_RECYCLE_COUNT times.
    const f = KeyBuffs.get(passphrase);
    if (f) {
        f.count--;
        if (f.count > 0) {
            return [f.key, f.salt];
        }
        f.count--;
    }
    const passphraseBin = new TextEncoder().encode(passphrase);
    const digest = await webcrypto.subtle.digest({ name: "SHA-256" }, passphraseBin);
    const keyMaterial = await webcrypto.subtle.importKey("raw", digest, { name: "PBKDF2" }, false, ["deriveKey"]);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await webcrypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );
    KeyBuffs.set(passphrase, {
        key,
        salt,
        count: KEY_RECYCLE_COUNT,
    });
    return [key, salt];
}
let keyGCCount = KEY_RECYCLE_COUNT * 5;
let decKeyIdx = 0;
let decKeyMin = 0;
export async function getKeyForDecryption(passphrase: string, salt: Uint8Array): Promise<[CryptoKey, Uint8Array]> {
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
    const bufKey = passphrase + uint8ArrayToHexString(salt);
    const f = decKeyBuffs.get(bufKey);
    if (f) {
        f.count = decKeyIdx;
        return [f.key, f.salt];
    }
    const passphraseBin = new TextEncoder().encode(passphrase);
    const digest = await webcrypto.subtle.digest({ name: "SHA-256" }, passphraseBin);
    const keyMaterial = await webcrypto.subtle.importKey("raw", digest, { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await webcrypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
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

function btoa_node(src: string): string {
    return Buffer.from(src, "binary").toString("base64");
}
function atob_node(src: string): string {
    return Buffer.from(src, "base64").toString("binary");
}
const btoa = typeof window !== "undefined" ? window.btoa : btoa_node;
const atob = typeof window !== "undefined" ? window.atob : atob_node;


const revMap: { [key: string]: number } = {};
const numMap: { [key: number]: string } = {};
for (let i = 0; i < 256; i++) {
    revMap[(`00${i.toString(16)}`.slice(-2))] = i;
    numMap[i] = (`00${i.toString(16)}`.slice(-2));
}
function hexStringToUint8Array(src: string): Uint8Array {
    const len = src.length / 2;
    const ret = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        ret[i] = revMap[src[i * 2] + src[i * 2 + 1]];
    }
    return ret;
}
function uint8ArrayToHexString(src: Uint8Array): string {
    return [...src].map(e => numMap[e]).join("");
}

// Safari's JavaScriptCOre hardcoded the argument limit to 65536
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/apply
const QUANTUM = 32768;

// Super fast Text Encoder / Decoder alternative.
// TODO: When Capacitor or Electron is upgraded, check and reappraise this.
// Referred https://gist.github.com/kawanet/a66a0e2657464c57bcff2249286d3a24
// https://qiita.com/kawanet/items/52062b0c86597f7dee7d
const writeString = (string: string) => {
    // Prepare enough buffer.
    const buffer = new Uint8Array(string.length * 4);
    const length = string.length;
    let index = 0;
    let chr = 0;
    let idx = 0;
    while (idx < length) {
        chr = string.charCodeAt(idx++);
        if (chr < 128) {
            buffer[index++] = chr;
        } else if (chr < 0x800) {
            // 2 bytes
            buffer[index++] = 0xC0 | (chr >>> 6);
            buffer[index++] = 0x80 | (chr & 0x3F);
        } else if (chr < 0xD800 || chr > 0xDFFF) {
            // 3 bytes
            buffer[index++] = 0xE0 | (chr >>> 12);
            buffer[index++] = 0x80 | ((chr >>> 6) & 0x3F);
            buffer[index++] = 0x80 | (chr & 0x3F);
        } else {
            // 4 bytes - surrogate pair
            chr = (((chr - 0xD800) << 10) | (string.charCodeAt(idx++) - 0xDC00)) + 0x10000;
            buffer[index++] = 0xF0 | (chr >>> 18);
            buffer[index++] = 0x80 | ((chr >>> 12) & 0x3F);
            buffer[index++] = 0x80 | ((chr >>> 6) & 0x3F);
            buffer[index++] = 0x80 | (chr & 0x3F);
        }
    }
    return buffer.slice(0, index);
};

const readString = (buffer: Uint8Array) => {
    const length = buffer.length;
    let index = 0;
    const end = length;
    let string = "";
    while (index < end) {
        const chunk = [];
        const cEnd = Math.min(index + QUANTUM, end);
        while (index < cEnd) {
            const chr = buffer[index++];
            if (chr < 128) { // 1 byte
                chunk.push(chr);
            } else if ((chr & 0xE0) === 0xC0) { // 2 bytes
                chunk.push((chr & 0x1F) << 6 |
                    (buffer[index++] & 0x3F));
            } else if ((chr & 0xF0) === 0xE0) { // 3 bytes
                chunk.push((chr & 0x0F) << 12 |
                    (buffer[index++] & 0x3F) << 6 |
                    (buffer[index++] & 0x3F));
            } else if ((chr & 0xF8) === 0xF0) { // 4 bytes
                let code = (chr & 0x07) << 18 |
                    (buffer[index++] & 0x3F) << 12 |
                    (buffer[index++] & 0x3F) << 6 |
                    (buffer[index++] & 0x3F);
                if (code < 0x010000) {
                    chunk.push(code);
                } else { // surrogate pair
                    code -= 0x010000;
                    chunk.push((code >>> 10) + 0xD800, (code & 0x3FF) + 0xDC00);
                }
            }
        }
        string += String.fromCharCode(...chunk);
    }
    return string;
};


function binaryToBinaryString(src: Uint8Array): string {
    const len = src.length;
    if (len < QUANTUM) return String.fromCharCode(...src);
    let ret = "";
    for (let i = 0; i < len; i += QUANTUM) {
        ret += String.fromCharCode(
            ...src.slice(i, i + QUANTUM)
        );
    }
    return ret;
}


export async function encrypt(input: string, passphrase: string) {
    const [key, salt] = await getKeyForEncrypt(passphrase);
    // Create initial vector with semi-fixed part and incremental part
    // I think it's not good against related-key attacks.
    const fixedPart = getSemiStaticField();
    const invocationPart = getNonce();
    const iv = new Uint8Array([...fixedPart, ...new Uint8Array(invocationPart.buffer)]);
    const plainStringified = JSON.stringify(input);

    // const plainStringBuffer: Uint8Array = tex.encode(plainStringified)
    const plainStringBuffer: Uint8Array = writeString(plainStringified);
    const encryptedDataArrayBuffer: ArrayBuffer = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainStringBuffer);
    const encryptedData2 = btoa(binaryToBinaryString(new Uint8Array(encryptedDataArrayBuffer)));
    //return data with iv and salt.
    const ret = `["${encryptedData2}","${uint8ArrayToHexString(iv)}","${uint8ArrayToHexString(salt)}"]`;
    return ret;
}



export async function decrypt(encryptedResult: string, passphrase: string): Promise<string> {
    try {
        if (!encryptedResult.startsWith("[") || !encryptedResult.endsWith("]")) {
            throw new Error("Encrypted data corrupted!");
        }
        const w: any = encryptedResult.substring(1, encryptedResult.length - 1).split(",").map(e => e[0] == '"' ? e.substring(1, e.length - 1) : e);
        const [encryptedData, ivString, salt]: encodedData = w;
        const [key] = await getKeyForDecryption(passphrase, hexStringToUint8Array(salt));
        const iv = hexStringToUint8Array(ivString);
        // decode base 64, it should increase speed and i should with in MAX_DOC_SIZE_BIN, so it won't OOM.
        const encryptedDataBin = atob(encryptedData);
        const len = encryptedDataBin.length;
        const encryptedDataArrayBuffer = new Uint8Array(len);
        // converting binary string to arraybuffer
        for (let i = 0; i < len; i++) {
            encryptedDataArrayBuffer[i] = encryptedDataBin.charCodeAt(i);
        }
        const plainStringBuffer: ArrayBuffer = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedDataArrayBuffer);
        // const plainStringified = tdx.decode(plainStringBuffer);
        const plainStringified = readString(new Uint8Array(plainStringBuffer));
        // const plainStringified = String.fromCodePoint.apply(null, [...new Uint8Array(plainStringBuffer)])
        const plain = JSON.parse(plainStringified);
        return plain;
    } catch (ex) {
        Logger("Couldn't decode! You should wrong the passphrases", LOG_LEVEL.VERBOSE);
        Logger(ex, LOG_LEVEL.VERBOSE);
        throw ex;

    }
}
export async function testCrypt() {
    const src = "supercalifragilisticexpialidocious";
    const encoded = await encrypt(src, "passwordTest");
    const decrypted = await decrypt(encoded, "passwordTest");
    if (src != decrypted) {
        Logger("WARNING! Your device would not support encryption.", LOG_LEVEL.VERBOSE);
        return false;
    } else {
        Logger("CRYPT LOGIC OK", LOG_LEVEL.VERBOSE);
        return true;
    }
}
