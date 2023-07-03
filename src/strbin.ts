
// Map for converting hexString
const revMap: { [key: string]: number } = {};
const numMap: { [key: number]: string } = {};
for (let i = 0; i < 256; i++) {
    revMap[(`00${i.toString(16)}`.slice(-2))] = i;
    numMap[i] = (`00${i.toString(16)}`.slice(-2));
}

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


function btoa_node(src: string): string {
    return Buffer.from(src, "binary").toString("base64");
}
function atob_node(src: string): string {
    return Buffer.from(src, "base64").toString("binary");
}

export const btoa = typeof window !== "undefined" ? window.btoa : btoa_node;
export const atob = typeof window !== "undefined" ? window.atob : atob_node;

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
function arrayBufferToBase64internalNode(buffer: DataView): string {
    const ret = Buffer.from(buffer.buffer).toString("base64");
    return ret;
}
const arrayBufferToBase64internal = typeof (window) !== "undefined" ? arrayBufferToBase64internalBrowser : arrayBufferToBase64internalNode;

export async function arrayBufferToBase64Single(buffer: ArrayBuffer): Promise<string> {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (buf.byteLength < QUANTUM) return btoa(String.fromCharCode.apply(null, [...buf]));
    if (typeof window !== "undefined") return await arrayBufferToBase64internalBrowser(buf);
    return Buffer.from(buf).toString("base64");
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
        pieces.push(await arrayBufferToBase64internal(pBuf));
        idx++;
    } while (idx * encodeChunkSize < bufLen);
    return pieces;
}

export async function arrayBufferToBase64_old(buffer: ArrayBuffer): Promise<string[]> {
    const bufLen = buffer.byteLength;
    const pieces = [];
    let idx = 0;
    do {
        const offset = idx * encodeChunkSize;
        const pBuf = new DataView(buffer, offset, Math.min(encodeChunkSize, buffer.byteLength - offset));
        pieces.push(await arrayBufferToBase64internal(pBuf));
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
        if (typeof base64 != "string") return base64.join("");
        return base64
    }
}
export function base64ToArrayBuffer(base64: string | string[]): ArrayBuffer {
    if (typeof (base64) == "string") return base64ToArrayBufferInternal(base64);
    const bufItems = base64.map(e => base64ToArrayBufferInternal(e));
    const len = bufItems.reduce((p, c) => p + c.byteLength, 0);
    const joinedArray = new Uint8Array(len);
    let offset = 0;
    bufItems.forEach(e => {
        joinedArray.set(new Uint8Array(e), offset);
        offset += e.byteLength;
    });
    return joinedArray;
}

const base64ToArrayBufferInternal = typeof (window) !== "undefined" ? base64ToArrayBufferInternalBrowser : base64ToArrayBufferInternalNode;

function base64ToArrayBufferInternalNode(base64: string): ArrayBuffer {
    try {
        return Buffer.from(base64, "base64").buffer;
    } catch (ex) {
        return writeString(base64).buffer;
    }
}

function base64ToArrayBufferInternalBrowser(base64: string): ArrayBuffer {
    try {
        const binary_string = atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (ex) {
        const len = base64.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = base64.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

/// Chunk utilities
function* pickPiece(leftData: string[], minimumChunkSize: number): Generator<string> {
    let buffer = "";
    L1:
    do {
        const curLine = leftData.shift();
        if (typeof (curLine) === "undefined") {
            yield buffer;
            break L1;
        }

        // Do not use regexp for performance.
        if (curLine.startsWith("```") || curLine.startsWith(" ```") || curLine.startsWith("  ```") || curLine.startsWith("   ```")) {
            yield buffer;
            buffer = curLine + (leftData.length != 0 ? "\n" : "");
            L2:
            do {
                const curPx = leftData.shift();
                if (typeof (curPx) === "undefined") {
                    break L2;
                }
                buffer += curPx + (leftData.length != 0 ? "\n" : "");
            } while (leftData.length > 0 && !(leftData[0].startsWith("```") || leftData[0].startsWith(" ```") || leftData[0].startsWith("  ```") || leftData[0].startsWith("   ```")));
            const isLooksLikeBASE64 = buffer.endsWith("=");
            const maybeUneditable = buffer.length > 2048;
            // concat code block end mark
            const endOfCodeBlock = leftData.shift();
            if (typeof (endOfCodeBlock) !== "undefined") {
                buffer += endOfCodeBlock;
                buffer += (leftData.length != 0 ? "\n" : "");
            }
            if (!isLooksLikeBASE64 && !maybeUneditable) {
                const splitExpr = /(.*?[;,:<])/g;
                const sx = buffer.split(splitExpr).filter(e => e != '');
                for (const v of sx) {
                    yield v;
                }
            } else {
                yield buffer;
            }
            buffer = "";
        } else {
            buffer += curLine + (leftData.length != 0 ? "\n" : "");
            if (buffer.length >= minimumChunkSize || leftData.length == 0 || leftData[0] == "#" || buffer[0] == "#") {
                yield buffer;
                buffer = "";
            }
        }
    } while (leftData.length > 0);
}
// Split string into pieces within specific lengths (characters).
export function splitPieces2(dataSrc: string | string[], pieceSize: number, plainSplit: boolean, minimumChunkSize: number, longLineThreshold: number) {
    return function* pieces(): Generator<string> {
        const dataList = typeof (dataSrc) == "string" ? [dataSrc] : dataSrc;
        for (const data of dataList) {
            if (plainSplit) {
                const leftData = data.split("\n"); //use memory
                const f = pickPiece(leftData, minimumChunkSize);
                for (const piece of f) {
                    let buffer = piece;
                    do {
                        // split to within maximum pieceSize
                        let ps = pieceSize;
                        if (buffer.charCodeAt(ps - 1) != buffer.codePointAt(ps - 1)) {
                            // If the char at the end of the chunk has been part of the surrogate pair, grow the piece size a bit.
                            ps++;
                        }
                        yield buffer.substring(0, ps);
                        buffer = buffer.substring(ps);
                    } while (buffer != "");
                }
            } else {
                let leftData = data;
                do {
                    const piece = leftData.substring(0, pieceSize);
                    leftData = leftData.substring(pieceSize);
                    yield piece;
                } while (leftData != "");
            }
        }
    };
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
