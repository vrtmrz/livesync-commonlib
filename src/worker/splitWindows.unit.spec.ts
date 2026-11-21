import { describe, expect, it } from "vitest";
import { decodeSplitWindow, encodeSplitWindow, groupSplitChunks } from "./splitWindows.ts";

describe("split windows", () => {
    it("keeps each chunk in order and sends an oversized chunk on its own", async () => {
        const chunks = ["a", "😀", "", "x".repeat(70_000), "\0z", "end"];
        const windows = [];
        for await (const window of groupSplitChunks(
            (async function* () {
                yield* chunks;
            })(),
            14
        )) {
            const frame = encodeSplitWindow(window);
            expect(2 * frame.length <= 14 || window.length === 1).toBe(true);
            windows.push(decodeSplitWindow(frame));
        }
        expect(windows).toEqual([["a", "😀"], [""], ["x".repeat(70_000)], ["\0z"], ["end"]]);
        expect(windows.flat()).toEqual(chunks);
    });

    it("rejects an incomplete window frame", () => {
        const frame = encodeSplitWindow(["ab"]);
        expect(() => decodeSplitWindow(frame.slice(0, -1))).toThrow("incomplete chunk");
        expect(() => decodeSplitWindow(frame + "\0")).toThrow("invalid chunk header");
    });
});
