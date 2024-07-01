import { arrayBufferToBase64, base64ToArrayBuffer, base64ToArrayBufferInternalBrowser, arrayBufferToBase64Single, readString, writeString } from "octagonal-wheels/binary";
export { arrayBufferToBase64, base64ToArrayBuffer, base64ToArrayBufferInternalBrowser, arrayBufferToBase64Single, readString, writeString }
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
