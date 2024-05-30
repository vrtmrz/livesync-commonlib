import { Logger } from "../common/logger.ts";
import { LOG_LEVEL_VERBOSE } from "../common/types.ts";

// Map for converting hexString
const revMap: { [key: string]: number } = {};
const numMap: { [key: number]: string } = {};
for (let i = 0; i < 256; i++) {
    revMap[(`00${i.toString(16)}`.slice(-2))] = i;
    numMap[i] = (`00${i.toString(16)}`.slice(-2));
}

function* range(from: number, to: number) {
    for (let i = from; i <= to; i++) {
        yield i;
    }
    return;
}
// Table for converting encoding binary
const table = {} as Record<number, number>;
const revTable = {} as Record<number, number>;

[...range(0xc0, 0x1bf)].forEach((e, i) => {
    table[i] = e;
    revTable[e] = i;
})

const decoderStreamAvailable = (typeof TextDecoderStream !== "undefined");

const BINARY_CHUNK_MAX = 1024 * 1024 * 30;
export function hexStringToUint8Array(src: string): Uint8Array {
    const len = src.length / 2;
    const ret = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        ret[i] = revMap[src[i * 2] + src[i * 2 + 1]];
    }
    return ret;
}

export function uint8ArrayToHexString(src: Uint8Array): string {
    return [...src].map(e => numMap[e]).join("");
}

//
// Safari's JavaScriptCOre hardcoded the argument limit to 65536
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/apply
const QUANTUM = 32768;

// Super fast Text Encoder / Decoder alternative.
// TODO: When Capacitor or Electron is upgraded, check and reappraise this.
// Referred https://gist.github.com/kawanet/a66a0e2657464c57bcff2249286d3a24
// https://qiita.com/kawanet/items/52062b0c86597f7dee7d
export const writeString = (string: string) => {
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

export const readString = (buffer: Uint8Array) => {
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

export function binaryToBinaryString(src: Uint8Array): string {
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

const encodeChunkSize = 3 * 50000000;


function arrayBufferToBase64internalBrowser(buffer: DataView | Uint8Array): Promise<string> {
    return new Promise((res, rej) => {
        const blob = new Blob([buffer], { type: "application/octet-binary" });
        const reader = new FileReader();
        reader.onload = function (evt) {
            const dataURI = evt.target?.result?.toString() || "";
            if (buffer.byteLength != 0 && (dataURI == "" || dataURI == "data:")) return rej(new TypeError("Could not parse the encoded string"));
            const result = dataURI.substring(dataURI.indexOf(",") + 1);
            res(result);
        };
        reader.readAsDataURL(blob);
    });
}

export async function arrayBufferToBase64Single(buffer: ArrayBuffer): Promise<string> {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (buf.byteLength < QUANTUM) return btoa(String.fromCharCode.apply(null, [...buf]));
    return await arrayBufferToBase64internalBrowser(buf);
}
export async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string[]> {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (buf.byteLength < QUANTUM) return [btoa(String.fromCharCode.apply(null, [...buf]))];
    const bufLen = buf.byteLength;
    const pieces = [] as string[];
    let idx = 0;
    do {
        const offset = idx * encodeChunkSize;
        const pBuf = new DataView(buf.buffer, offset, Math.min(encodeChunkSize, buf.byteLength - offset));
        pieces.push(await arrayBufferToBase64internalBrowser(pBuf));
        idx++;
    } while (idx * encodeChunkSize < bufLen);
    return pieces;
}

export function base64ToString(base64: string | string[]): string {
    try {
        if (typeof base64 != "string") return base64.map(e => base64ToString(e)).join("");
        const binary_string = atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return readString(bytes);
    } catch (ex) {
        Logger("Base64 To String error", LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        if (typeof base64 != "string") return base64.join("");
        return base64
    }
}
export function base64ToArrayBuffer(base64: string | string[]): ArrayBuffer {
    if (typeof (base64) == "string") return base64ToArrayBufferInternalBrowser(base64);
    const bufItems = base64.map(e => base64ToArrayBufferInternalBrowser(e));
    const len = bufItems.reduce((p, c) => p + c.byteLength, 0);
    const joinedArray = new Uint8Array(len);
    let offset = 0;
    bufItems.forEach(e => {
        joinedArray.set(new Uint8Array(e), offset);
        offset += e.byteLength;
    });
    return joinedArray.buffer;
}


export function base64ToArrayBufferInternalBrowser(base64: string): ArrayBuffer {
    try {
        const binary_string = globalThis.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (ex) {
        Logger("Base64 Decode error", LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        return new ArrayBuffer(0);
    }
}

const regexpBase64 = /^[A-Za-z0-9+/]+=*$/;

export function tryConvertBase64ToArrayBuffer(base64: string): ArrayBuffer | false {
    try {
        const b64F = base64.replace(/\r|\n/g, "");
        if (!regexpBase64.test(b64F)) {
            return false;
        }

        const binary_string = globalThis.atob(b64F);
        if (globalThis.btoa(binary_string) !== b64F) {
            return false;
        }
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (ex) {
        return false;
    }
}
// Misc

export function versionNumberString2Number(version: string): number {
    return version // "1.23.45"
        .split(".") // 1  23  45
        .reverse() // 45  23  1
        .map((e, i) => ((e as any) / 1) * 1000 ** i) // 45 23000 1000000
        .reduce((prev, current) => prev + current, 0); // 1023045
}

export const escapeStringToHTML = (str: string) => {
    if (!str) return "";
    return str.replace(/[<>&"'`]/g, (match) => {
        const escape: any = {
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            '"': "&quot;",
            "'": "&#39;",
            "`": "&#x60;",
        };
        return escape[match];
    });
};

export async function _encodeBinary(buffer: Uint8Array): Promise<string[]> {
    const len = buffer.length;
    if (len < BINARY_CHUNK_MAX) {
        return [await encodeBinaryEach(buffer)];
    }
    const out = [];
    for (let i = 0; i < len; i += BINARY_CHUNK_MAX) {
        out.push(encodeBinaryEach(buffer.subarray(i, i + BINARY_CHUNK_MAX)));
    }
    return Promise.all(out);
}
async function decodeAsync(buffer: Uint16Array): Promise<string> {
    if (buffer.length == 0) return "";
    if (!decoderStreamAvailable) return await decodeAsyncReader(buffer);
    const decoderStream = new TextDecoderStream("utf-16");
    const writer = decoderStream.writable.getWriter();
    writer.write(buffer);
    writer.close();

    const reader = decoderStream.readable.getReader();
    const result = await reader.read();

    if (!result.value) {
        throw new Error("UTF-16 Parse error");
    }

    return result.value;
}
function decodeAsyncReader(buffer: Uint16Array): Promise<string> {
    return new Promise<string>((res, rej) => {
        const blob = new Blob([buffer], { type: "application/octet-binary" });
        const reader = new FileReader();
        reader.onload = function (evt) {
            const result = evt.target?.result as string;
            if (!result) return rej("UTF-16 Parse error");
            return res(result);
        };
        reader.readAsText(blob, "utf-16");
    });
}

export async function encodeBinaryEach(buffer: Uint8Array): Promise<string> {
    const len = buffer.byteLength;
    const out = new Uint16Array(buffer);
    for (let i = 0; i < len; i++) {
        const char = buffer[i];
        if (char >= 0x26 && char <= 0x7e && char != 0x3a) {
            // out[i] = asciiTable[char];
            // We can leave it.
        } else {
            out[i] = table[char];
        }
    }
    // Return it as utf-16 string.
    return await decodeAsync(out);
}

export function decodeToArrayBuffer(src: string[]) {
    if (src.length == 1) return _decodeToArrayBuffer(src[0]);
    const bufItems = src.map(e => _decodeToArrayBuffer(e));
    const len = bufItems.reduce((p, c) => p + c.byteLength, 0);
    const joinedArray = new Uint8Array(len);
    let offset = 0;
    bufItems.forEach(e => {
        joinedArray.set(new Uint8Array(e), offset);
        offset += e.byteLength;
    });
    return joinedArray.buffer;
}

export function _decodeToArrayBuffer(src: string): ArrayBuffer {
    const out = new Uint8Array(src.length);
    const len = src.length;
    for (let i = 0; i < len; i++) {
        // We can simply pick a char, because of it does not contains surrogate pair or any of like them.
        const char = src.charCodeAt(i);
        if (char >= 0x26 && char <= 0x7e && char != 0x3a) {
            out[i] = char;
        } else {
            out[i] = revTable[char];
        }
    }
    return out.buffer
}

export function decodeBinary(src: string | string[]) {
    if (src.length == 0) return new Uint8Array().buffer;
    if (typeof src === "string") {
        if (src[0] === "%") {
            return _decodeToArrayBuffer(src.substring(1));
        }
    } else {
        if (src[0][0] === "%") {
            const [head, ...last] = src;
            return decodeToArrayBuffer([head.substring(1), ...last]);
        }
    }
    return base64ToArrayBuffer(src);
}
export async function encodeBinary(src: Uint8Array | ArrayBuffer): Promise<string[]> {
    return await arrayBufferToBase64(src);
}
