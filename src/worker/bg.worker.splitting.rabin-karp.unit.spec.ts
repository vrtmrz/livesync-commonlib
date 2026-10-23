import { describe, expect, it, vi } from "vitest";
import { splitPiecesRabinKarp } from "../string_and_binary/chunks";
import { END_OF_DATA } from "./universalTypes";

const { postBack } = vi.hoisted(() => ({ postBack: vi.fn() }));
vi.mock("./bg.common.ts", () => ({ postBack }));

import { processSplit } from "./bg.worker.splitting";

describe("Rabin–Karp worker message processing", () => {
    it.each([
        ["ordinary Markdown", new Blob(["# Heading\n\nA note with unchanged paragraphs.\n".repeat(100)], { type: "text/plain" }), true],
        ["small-cap binary", new Blob([new Uint8Array(512 * 1024).map((_, i) => (i * 31) % 251)]), false],
        ["large UTF-8 text", new Blob(["漢🙂".repeat(600_000)], { type: "text/plain" }), true],
    ] as const)("preserves the direct boundary sequence for %s", async (_label, dataSrc, plainSplit) => {
        postBack.mockClear();
        const pieceSize = 100 * 1024;
        const direct = await splitPiecesRabinKarp(dataSrc, pieceSize, plainSplit, 20);
        const expected: string[] = [];
        for await (const chunk of direct()) expected.push(chunk);

        await processSplit({
            type: "split", key: 42, dataSrc, pieceSize, plainSplit,
            minimumChunkSize: 20, useSegmenter: false, splitVersion: 3,
        });

        const calls = postBack.mock.calls;
        expect(calls.at(-1)).toEqual([42, expected.length, END_OF_DATA]);
        expect(calls.slice(0, -1).map(([key, seq, result], index) => {
            expect(key).toBe(42);
            expect(seq).toBe(index);
            return result;
        })).toEqual(expected);
    });
});
