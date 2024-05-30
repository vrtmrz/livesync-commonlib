import { Logger } from "../common/logger.ts";
import { webcrypto } from "../mods.ts";
import { LOG_LEVEL_VERBOSE } from "../common/types.ts";
import { default as xxhashOld, type Exports } from "xxhash-wasm";
import { default as xxhashNew } from "../../patched_xxhash_wasm/xxhash-wasm.js";
import type { XXHashAPI } from "xxhash-wasm-102";
import { arrayBufferToBase64Single, writeString } from "./convert.ts";

const crc32kTable = new Uint32Array(256);
const crc32cTable = new Uint32Array(256);

function generateCRC32KTable(): void {
    const polynomial = 0xEDB88320;

    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ polynomial;
            } else {
                crc >>>= 1;
            }
        }
        crc32kTable[i] = crc;
    }
}
function generateCRC32CTable(): void {
    const polynomial = 0x1EDC6F41;

    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ polynomial;
            } else {
                crc >>>= 1;
            }
        }
        crc32cTable[i] = crc;
    }
}
generateCRC32CTable();
generateCRC32KTable();
export function crc32CHash(strSrc: string): string {
    let crc = 0xFFFFFFFF;
    const src = `s0` + strSrc + `\u0012\u0009` + strSrc.length;
    let i = src.length;
    while (--i) {
        const code = src.charCodeAt(i);
        const codeLow = (code & 0xff);
        const codeHigh = code >> 8
        crc = (crc >>> 8) ^ crc32cTable[(crc ^ codeLow) & 0xFF];
        crc = (crc >>> 8) ^ crc32cTable[(crc ^ codeHigh) & 0xFF];
    }
    crc ^= 0xFFFFFFFF;
    return crc.toString(32);
}
export function crc32CKHash(strSrc: string): string {
    let crc = 0xFFFFFFFF;
    let crc2 = 0xFFFFFFFF;
    const src = `s0` + strSrc + `\u0012\u0009` + strSrc.length;
    let i = src.length;
    while (--i) {
        const code = src.charCodeAt(i);
        const codeLow = (code & 0xff);
        const codeHigh = code >> 8
        crc = (crc >>> 8) ^ crc32cTable[(crc ^ codeLow) & 0xFF];
        crc = (crc >>> 8) ^ crc32cTable[(crc ^ codeHigh) & 0xFF];
        crc2 = (crc2 >>> 8) ^ crc32kTable[(crc2 ^ codeLow) & 0xFF];
        crc2 = (crc2 >>> 8) ^ crc32kTable[(crc2 ^ codeHigh) & 0xFF];
    }
    crc ^= 0xFFFFFFFF;
    crc2 ^= 0xFFFFFFFF;
    return crc.toString(32) + "-" + crc2.toString(32);
}

let hashFunc: (input: string, seed?: number) => string;

async function initHashFunc() {
    try {
        const { h32ToString } = await (xxhashNew as unknown as () => Promise<XXHashAPI>)();
        hashFunc = h32ToString;
        Logger(`xxhash for plugin initialised`, LOG_LEVEL_VERBOSE);
    } catch (ex) {
        Logger(`Could not initialise xxhash. fallback...`, LOG_LEVEL_VERBOSE);
        Logger(ex);
        try {
            const { h32 } = (await xxhashOld()) as unknown as Exports;
            hashFunc = (str) => h32(str);
        } catch (ex) {
            Logger(`Could not initialise old xxhash for plugin: use sha1`, LOG_LEVEL_VERBOSE);
            Logger(ex);
            hashFunc = (str) => str;
        }
    }
    return hashFunc;
}
initHashFunc();
export async function sha1(src: string) {
    const bytes = writeString(src);
    const digest = await webcrypto.subtle.digest({ name: "SHA-1" }, bytes);
    return await arrayBufferToBase64Single(digest);
}

export function digestHash(src: string[]) {
    let hash = "";
    for (const v of src) {
        hash = hashFunc(hash + v);
    }
    if (hash == "") {
        return hashFunc("**");
    }
    return hash;
}
