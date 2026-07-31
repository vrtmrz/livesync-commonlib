import { uint8ArrayToHexString } from "octagonal-wheels/binary";

const textEncoder = new TextEncoder();

export type CanonicalJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly CanonicalJsonValue[]
    | { readonly [key: string]: CanonicalJsonValue };

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < left.byteLength; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}

export function utf8Bytes(value: string): Uint8Array {
    return textEncoder.encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
    return uint8ArrayToHexString(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    const blockSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
        throw new TypeError("Invalid base64url value");
    }
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) {
        throw new TypeError("Non-canonical base64url value");
    }
    return bytes;
}

function normaliseCanonicalJson(value: unknown, path: string): CanonicalJsonValue {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new TypeError(`Canonical JSON requires a safe integer at ${path}`);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => normaliseCanonicalJson(entry, `${path}[${index}]`));
    }
    if (typeof value !== "object" || value === undefined) {
        throw new TypeError(`Unsupported canonical JSON value at ${path}`);
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
        result[key] = normaliseCanonicalJson(record[key], `${path}.${key}`);
    }
    return result;
}

export function canonicalJsonString(value: unknown): string {
    return JSON.stringify(normaliseCanonicalJson(value, "$"));
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
    return utf8Bytes(canonicalJsonString(value));
}

export function u16be(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
        throw new RangeError("Value does not fit u16");
    }
    const result = new Uint8Array(2);
    new DataView(result.buffer).setUint16(0, value, false);
    return result;
}

export function u32be(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError("Value does not fit u32");
    }
    const result = new Uint8Array(4);
    new DataView(result.buffer).setUint32(0, value, false);
    return result;
}

export function u64be(value: number | bigint): Uint8Array {
    const bigintValue = typeof value === "bigint" ? value : BigInt(value);
    if (bigintValue < 0n || bigintValue > 0xffffffffffffffffn) {
        throw new RangeError("Value does not fit u64");
    }
    const result = new Uint8Array(8);
    new DataView(result.buffer).setBigUint64(0, bigintValue, false);
    return result;
}

export class BinaryReader {
    private offset = 0;

    constructor(private readonly bytes: Uint8Array) {}

    get remaining(): number {
        return this.bytes.byteLength - this.offset;
    }

    get position(): number {
        return this.offset;
    }

    readBytes(length: number): Uint8Array {
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
            throw new RangeError("Binary value is truncated");
        }
        const result = this.bytes.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    readU8(): number {
        return this.readBytes(1)[0];
    }

    readU16(): number {
        const bytes = this.readBytes(2);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, false);
    }

    readU32(): number {
        const bytes = this.readBytes(4);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    }

    readU64(): bigint {
        const bytes = this.readBytes(8);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, false);
    }
}

export function boundedU64ToNumber(value: bigint, maximum: number): number {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || value > BigInt(maximum)) {
        throw new RangeError("Binary length exceeds its configured limit");
    }
    return Number(value);
}

export function fixedLength(bytes: Uint8Array, length: number, label: string): Uint8Array {
    if (bytes.byteLength !== length) {
        throw new RangeError(`${label} must be ${length} bytes`);
    }
    return bytes;
}
