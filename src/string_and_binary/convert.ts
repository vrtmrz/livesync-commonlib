// Misc
import {
    arrayBufferToBase64,
    base64ToArrayBuffer,
    base64ToArrayBufferInternalBrowser,
    arrayBufferToBase64Single as arrayBufferToBase64SingleInternal,
    readString,
    writeString,
    tryConvertBase64ToArrayBuffer,
} from "octagonal-wheels/binary";
export {
    arrayBufferToBase64,
    base64ToArrayBuffer,
    base64ToArrayBufferInternalBrowser,
    readString,
    writeString,
    tryConvertBase64ToArrayBuffer,
};
export async function arrayBufferToBase64Single(buffer: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
    try {
        return await arrayBufferToBase64SingleInternal(buffer);
    } catch (ex) {
        // In Node.js/CLI, FileReader is unavailable. Use Buffer as a runtime fallback.
        const maybeBuffer = (globalThis as any)?.Buffer;
        if (typeof maybeBuffer?.from === "function") {
            const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            return maybeBuffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
        }
        throw ex;
    }
}
export { uint8ArrayToHexString, hexStringToUint8Array } from "octagonal-wheels/binary/hex";
export { encodeBinaryEach, decodeToArrayBuffer } from "octagonal-wheels/binary/encodedUTF16";
export { decodeBinary, encodeBinary } from "octagonal-wheels/binary";
export { escapeStringToHTML } from "octagonal-wheels/string";
export function versionNumberString2Number(version: string): number {
    return version // "1.23.45"
        .split(".") // 1  23  45
        .reverse() // 45  23  1
        .map((e, i) => ((e as any) / 1) * 1000 ** i) // 45 23000 1000000
        .reduce((prev, current) => prev + current, 0); // 1023045
}
