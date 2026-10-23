import { describe, expect, it } from "vitest";

import { splitPiecesRabinKarp } from "./chunks";

const blockBytes = 300 * 1024;

function markerBlocks(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(blockBytes * 3);
    for (let end = blockBytes; end <= bytes.length; end += blockBytes) bytes[end - 1] = 1;
    return bytes;
}

async function splitBinary(bytes: Uint8Array, maximum = 1100 * 1024, minimum = 20): Promise<Buffer[]> {
    const pieces = await splitPiecesRabinKarp(
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
        maximum,
        false,
        minimum
    );
    const chunks: Buffer[] = [];
    for await (const encoded of pieces()) chunks.push(Buffer.from(encoded, "base64"));
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
    return chunks;
}

describe("Rabin–Karp rolling window", () => {
    it("forgets a marker in the preceding binary chunk", async () => {
        // Zero windows hash to zero; each isolated marker hashes to one.
        const chunks = await splitBinary(markerBlocks());

        expect(chunks.map((chunk) => chunk.length)).toEqual([blockBytes, blockBytes, blockBytes]);
    });

    it("reuses the unchanged suffix after an insertion beyond the first binary boundary", async () => {
        const bytes = markerBlocks();
        const original = await splitBinary(bytes);
        const insertionOffset = blockBytes + 128 * 1024;
        const edited = new Uint8Array(bytes.length + 1);
        edited.set(bytes.subarray(0, insertionOffset));
        edited.set(bytes.subarray(insertionOffset), insertionOffset + 1);

        const chunks = await splitBinary(edited);

        expect(chunks.map((chunk) => chunk.length)).toEqual([blockBytes, blockBytes + 1, blockBytes]);
        expect(chunks[0].equals(original[0])).toBe(true);
        expect(chunks.at(-1)!.equals(original.at(-1)!)).toBe(true);
    });

    it("forgets a marker in the preceding text chunk", async () => {
        const block = "\0".repeat(255) + "\x01";
        const text = block.repeat(3);
        const pieces = await splitPiecesRabinKarp(new Blob([text], { type: "text/plain" }), 100 * 1024, true, 20);
        const chunks: string[] = [];
        for await (const chunk of pieces()) chunks.push(chunk);

        expect(chunks.join("")).toBe(text);
        expect(chunks.map((chunk) => chunk.length)).toEqual([block.length, block.length, block.length]);
    });
});

describe("Rabin–Karp proportional binary thresholds", () => {
    it.each([0, 1])("uses content boundaries below the maximum at size %i", async (size) => {
        const block = (size + 1) * 32 * 1024;
        const bytes = new Uint8Array(block * 4);
        for (let end = block; end <= bytes.length; end += block) bytes[end - 1] = 1;
        const maximum = (size + 1) * 100 * 1024;

        const original = await splitBinary(bytes, maximum);
        expect(original.map((chunk) => chunk.length)).toEqual(Array(4).fill(block));

        const offset = block + 16 * 1024;
        const inserted = new Uint8Array(bytes.length + 1);
        inserted.set(bytes.subarray(0, offset));
        inserted.set(bytes.subarray(offset), offset + 1);
        const updated = await splitBinary(inserted, maximum);
        expect(updated.map((chunk) => chunk.length)).toEqual([block, block + 1, block, block]);
        expect(updated.at(-1)!.equals(original.at(-1)!)).toBe(true);

        const deleted = new Uint8Array(bytes.length - 1);
        deleted.set(bytes.subarray(0, offset));
        deleted.set(bytes.subarray(offset + 1), offset);
        const afterDeletion = await splitBinary(deleted, maximum);
        expect(afterDeletion.map((chunk) => chunk.length)).toEqual([block, block - 1, block, block]);
        expect(afterDeletion.at(-1)!.equals(original.at(-1)!)).toBe(true);
    });

    it("suppresses candidates before the proportional minimum", async () => {
        const bytes = new Uint8Array(64 * 1024);
        bytes[16 * 1024 - 1] = 1;
        bytes[32 * 1024 - 1] = 1;
        const chunks = await splitBinary(bytes, 100 * 1024);
        expect(chunks.map((chunk) => chunk.length)).toEqual([32 * 1024, 32 * 1024]);
    });

    it.each([30 * 1024, 100 * 1024, 200 * 1024, 4 * 1024 * 1024])(
        "forces low-entropy cuts at the %i-byte cap and preserves a short EOF tail",
        async (maximum) => {
            const chunks = await splitBinary(new Uint8Array(maximum * 2 + 17), maximum);
            expect(chunks.map((chunk) => chunk.length)).toEqual([maximum, maximum, 17]);
        }
    );

    it("retains the maximum floor and the algorithmic cap", async () => {
        const floor = await splitBinary(new Uint8Array(70 * 1024), 0);
        expect(floor.map((chunk) => chunk.length)).toEqual([30 * 1024, 30 * 1024, 10 * 1024]);
        const capped = await splitBinary(new Uint8Array(9 * 1024 * 1024), 10 * 1024 * 1024);
        expect(capped.map((chunk) => chunk.length)).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024]);
    });

    it("honours the explicit minimum override without increasing the maximum", async () => {
        const bytes = new Uint8Array(210 * 1024);
        bytes[32 * 1024 - 1] = 1;
        const chunks = await splitBinary(bytes, 100 * 1024, 120 * 1024);
        expect(chunks.map((chunk) => chunk.length)).toEqual([100 * 1024, 100 * 1024, 10 * 1024]);
    });

    it("preserves UTF-8 characters when large text uses the binary thresholds", async () => {
        const text = "漢🙂".repeat(600_000);
        const maximum = 100 * 1024;
        const factory = await splitPiecesRabinKarp(new Blob([text], { type: "text/plain" }), maximum, true, 20);
        const chunks: string[] = [];
        for await (const chunk of factory()) chunks.push(chunk);
        expect(chunks.join("")).toBe(text);
        expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= maximum + 3)).toBe(true);
        expect(chunks.some((chunk) => Buffer.byteLength(chunk) >= maximum)).toBe(true);
    });
});
