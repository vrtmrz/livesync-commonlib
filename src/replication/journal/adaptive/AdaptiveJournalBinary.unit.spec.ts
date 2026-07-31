import { hexStringToUint8Array, uint8ArrayToHexString } from "octagonal-wheels/binary";
import { describe, expect, it } from "vitest";

import { base64UrlToBytes, bytesToBase64Url, bytesToHex } from "./AdaptiveJournalBinary.ts";

describe("Adaptive Journal binary text encodings", () => {
    it("uses the Octagonal Wheels browser-compatible hexadecimal representation", () => {
        const bytes = Uint8Array.of(0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff);
        expect(bytesToHex(bytes)).toBe("00017f80feff");
        expect(bytesToHex(bytes)).toBe(uint8ArrayToHexString(bytes));
        expect(hexStringToUint8Array(bytesToHex(bytes))).toEqual(bytes);
    });

    it("round-trips canonical unpadded Base64URL and rejects aliases with non-zero trailing bits", () => {
        const bytes = Uint8Array.of(0x00, 0xff, 0x10, 0x80);
        const encoded = bytesToBase64Url(bytes);
        expect(encoded).toBe("AP8QgA");
        expect(base64UrlToBytes(encoded)).toEqual(bytes);
        expect(() => base64UrlToBytes("AB")).toThrow(TypeError);
        expect(() => base64UrlToBytes("AP8QgB")).toThrow(TypeError);
    });
});
