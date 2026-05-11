import { beforeEach, describe, expect, it, vi } from "vitest";
import { END_OF_DATA } from "./universalTypes";

const hoisted = vi.hoisted(() => {
    const postBack = vi.fn();
    const splitPiecesRabinKarp = vi.fn(() => {
        return Promise.resolve(async function* () {
            await Promise.resolve();
            yield "chunk-1";
            yield "chunk-2";
        });
    });
    const splitPieces2V2 = vi.fn();
    const splitPieces2 = vi.fn();
    return {
        postBack,
        splitPiecesRabinKarp,
        splitPieces2V2,
        splitPieces2,
    };
});

vi.mock("./bg.common.ts", () => ({
    postBack: hoisted.postBack,
}));

vi.mock("../string_and_binary/chunks.ts", () => ({
    splitPiecesRabinKarp: hoisted.splitPiecesRabinKarp,
    splitPieces2V2: hoisted.splitPieces2V2,
    splitPieces2: hoisted.splitPieces2,
}));

describe("bg.worker.splitting/processSplit", () => {
    beforeEach(() => {
        hoisted.postBack.mockReset();
        hoisted.splitPiecesRabinKarp.mockClear();
        hoisted.splitPieces2V2.mockClear();
        hoisted.splitPieces2.mockClear();
    });

    it("should stream split results and post END_OF_DATA without recursive callback", async () => {
        const { processSplit } = await import("./bg.worker.splitting");

        await expect(
            processSplit({
                type: "split",
                key: 42,
                dataSrc: new Blob(["abcdef"]),
                pieceSize: 2,
                plainSplit: false,
                minimumChunkSize: 1,
                filename: "note.md",
                useSegmenter: false,
                splitVersion: 3,
            })
        ).resolves.toBeUndefined();

        expect(hoisted.splitPiecesRabinKarp).toHaveBeenCalledTimes(1);
        expect(hoisted.postBack).toHaveBeenCalledTimes(3);
        expect(hoisted.postBack).toHaveBeenNthCalledWith(1, 42, 0, "chunk-1");
        expect(hoisted.postBack).toHaveBeenNthCalledWith(2, 42, 1, "chunk-2");
        expect(hoisted.postBack).toHaveBeenNthCalledWith(3, 42, 2, END_OF_DATA);
    });
});
