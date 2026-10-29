import { promiseWithResolvers } from "octagonal-wheels/promises";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.doUnmock("octagonal-wheels/binary");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function loadComparison(indexedDB: unknown = undefined) {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("indexedDB", indexedDB);
    return (await import("./utils")).isDocContentSame;
}

function trackReads(blob: Blob, label: string, events: string[] = []) {
    const read = vi.spyOn(blob, "arrayBuffer");
    const originalSlice = blob.slice.bind(blob);
    const parts: { size: number; read: MockInstance<() => Promise<ArrayBuffer>> }[] = [];
    const slice = vi.spyOn(blob, "slice").mockImplementation((start, end, contentType) => {
        const part = originalSlice(start, end, contentType);
        const originalRead = part.arrayBuffer.bind(part);
        const readPart = vi.spyOn(part, "arrayBuffer").mockImplementation(() => {
            events.push(`${label}:${start}:${end}`);
            return originalRead();
        });
        parts.push({ size: part.size, read: readPart });
        return part;
    });
    return { blob, read, slice, parts };
}

describe("legacy Blob content comparison", () => {
    it.each([false, true])("rejects a size mismatch without reading, IndexedDB=%s", async (useIndexedDB) => {
        const cmp = vi.fn(() => 0);
        const isDocContentSame = await loadComparison(useIndexedDB ? { cmp } : undefined);
        const left = trackReads(new Blob(["short"]), "left");
        const right = trackReads(new Blob(["longer"]), "right");

        expect(await isDocContentSame(left.blob, right.blob)).toBe(false);
        for (const input of [left, right]) {
            expect(input.read).not.toHaveBeenCalled();
            expect(input.slice).not.toHaveBeenCalled();
        }
        expect(cmp).not.toHaveBeenCalled();
    });

    it("reads sequential 10,000-byte parts and ignores MIME differences", async () => {
        const isDocContentSame = await loadComparison();
        const bytes = Uint8Array.from({ length: 25_001 }, (_, index) => index % 256);
        const events: string[] = [];
        const left = trackReads(new Blob([bytes], { type: "application/custom" }), "left", events);
        const right = trackReads(new Blob([bytes], { type: "text/plain" }), "right", events);

        expect(await isDocContentSame(left.blob, right.blob)).toBe(true);
        expect(events).toEqual([
            "left:0:10000",
            "right:0:10000",
            "left:10000:20000",
            "right:10000:20000",
            "left:20000:30000",
            "right:20000:30000",
        ]);
        for (const input of [left, right]) {
            expect(input.read).not.toHaveBeenCalled();
            expect(input.parts.map((part) => part.size)).toEqual([10_000, 10_000, 5_001]);
            for (const part of input.parts) expect(part.read).toHaveBeenCalledTimes(1);
        }
    });

    it.each([0, 10_000, 20_000])("stops after the part containing a difference at byte %s", async (offset) => {
        const isDocContentSame = await loadComparison();
        const original = new Uint8Array(25_001);
        const changed = original.slice();
        changed[offset] = 1;
        const left = trackReads(new Blob([original]), "left");
        const right = trackReads(new Blob([changed]), "right");

        expect(await isDocContentSame(left.blob, right.blob)).toBe(false);
        const expectedReads = offset / 10_000 + 1;
        expect(left.slice).toHaveBeenCalledTimes(expectedReads);
        expect(right.slice).toHaveBeenCalledTimes(expectedReads);
    });

    it.each([0, 10_000, 10_001, 20_000])("does not read an extra part at length %s", async (length) => {
        const isDocContentSame = await loadComparison();
        const left = trackReads(new Blob([new Uint8Array(length)]), "left");
        const right = trackReads(new Blob([new Uint8Array(length)]), "right");

        expect(await isDocContentSame(left.blob, right.blob)).toBe(true);
        expect(left.slice).toHaveBeenCalledTimes(Math.ceil(length / 10_000));
        expect(right.slice).toHaveBeenCalledTimes(Math.ceil(length / 10_000));
        expect(left.read).not.toHaveBeenCalled();
        expect(right.read).not.toHaveBeenCalled();
    });

    it.each([-1, 0, 1])(
        "uses IndexedDB with its receiver and treats result %s as an ordering value",
        async (result) => {
            const cmp = vi.fn<(left: ArrayBuffer, right: ArrayBuffer) => number>(() => result);
            const indexedDB = { cmp };
            const isDocContentSame = await loadComparison(indexedDB);
            const left = trackReads(new Blob([new Uint8Array([0, 128, 255])]), "left");
            const right = trackReads(new Blob([new Uint8Array([1, 129, 254])]), "right");

            expect(await isDocContentSame(left.blob, right.blob)).toBe(result === 0);
            expect(cmp).toHaveBeenCalledTimes(1);
            expect(cmp.mock.contexts[0]).toBe(indexedDB);
            const [first, second] = cmp.mock.calls[0];
            expect(new Uint8Array(first)).toEqual(new Uint8Array([0, 128, 255]));
            expect(new Uint8Array(second)).toEqual(new Uint8Array([1, 129, 254]));
            expect(left.read).toHaveBeenCalledTimes(1);
            expect(right.read).toHaveBeenCalledTimes(1);
            expect(left.slice).not.toHaveBeenCalled();
            expect(right.slice).not.toHaveBeenCalled();
        }
    );

    it("still reads and delegates empty inputs to IndexedDB", async () => {
        const cmp = vi.fn(() => 0);
        const isDocContentSame = await loadComparison({ cmp });
        const left = trackReads(new Blob(), "left");
        const right = trackReads(new Blob(), "right");

        expect(await isDocContentSame(left.blob, right.blob)).toBe(true);
        expect(left.read).toHaveBeenCalledTimes(1);
        expect(right.read).toHaveBeenCalledTimes(1);
        expect(cmp).toHaveBeenCalledExactlyOnceWith(new ArrayBuffer(0), new ArrayBuffer(0));
    });

    it("retains the IndexedDB method and receiver selected before asynchronous reads", async () => {
        const cmp = vi.fn(() => 0);
        const indexedDB = { cmp };
        const isDocContentSame = await loadComparison(indexedDB);
        const firstRead = promiseWithResolvers<ArrayBuffer>();
        const secondRead = promiseWithResolvers<ArrayBuffer>();
        const left = trackReads(new Blob(["a"]), "left");
        const right = trackReads(new Blob(["a"]), "right");
        left.read.mockReturnValue(firstRead.promise);
        right.read.mockReturnValue(secondRead.promise);

        const result = isDocContentSame(left.blob, right.blob);
        expect(left.read).toHaveBeenCalledTimes(1);
        expect(right.read).not.toHaveBeenCalled();
        const replacement = vi.fn(() => 1);
        indexedDB.cmp = replacement;
        vi.stubGlobal("indexedDB", { cmp: replacement });
        firstRead.resolve(new Uint8Array([1]).buffer);
        await Promise.resolve();
        expect(right.read).toHaveBeenCalledTimes(1);
        secondRead.resolve(new Uint8Array([1]).buffer);

        expect(await result).toBe(true);
        expect(cmp.mock.contexts[0]).toBe(indexedDB);
        expect(replacement).not.toHaveBeenCalled();
    });

    it("selects IndexedDB availability at import but resolves its method for each call", async () => {
        const original = vi.fn(() => 1);
        const isDocContentSame = await loadComparison({ cmp: original });
        const replacement = { cmp: vi.fn(() => 0) };
        vi.stubGlobal("indexedDB", replacement);

        expect(await isDocContentSame("same", "same")).toBe(true);
        expect(original).not.toHaveBeenCalled();
        expect(replacement.cmp.mock.contexts[0]).toBe(replacement);
    });

    it("keeps the sliced fallback when IndexedDB appears after import", async () => {
        const isDocContentSame = await loadComparison();
        const cmp = vi.fn(() => 1);
        vi.stubGlobal("indexedDB", { cmp });
        const left = trackReads(new Blob(["same"]), "left");

        expect(await isDocContentSame(left.blob, "same")).toBe(true);
        expect(left.slice).toHaveBeenCalledTimes(1);
        expect(left.read).not.toHaveBeenCalled();
        expect(cmp).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "propagates a first read failure without reading the other Blob, IndexedDB=%s",
        async (useIndexedDB) => {
            const cmp = vi.fn(() => 0);
            const isDocContentSame = await loadComparison(useIndexedDB ? { cmp } : undefined);
            const error = new Error("Blob read failed");
            const left = new Blob(["same"]);
            const right = trackReads(new Blob(["same"]), "right");
            if (useIndexedDB) {
                vi.spyOn(left, "arrayBuffer").mockRejectedValue(error);
            } else {
                const part = new Blob(["same"]);
                vi.spyOn(part, "arrayBuffer").mockRejectedValue(error);
                vi.spyOn(left, "slice").mockReturnValue(part);
            }

            await expect(isDocContentSame(left, right.blob)).rejects.toBe(error);
            expect(right.read).not.toHaveBeenCalled();
            expect(right.slice).not.toHaveBeenCalled();
            expect(cmp).not.toHaveBeenCalled();
        }
    );

    it("propagates an IndexedDB comparison error", async () => {
        const error = new Error("IndexedDB comparison failed");
        const cmp = vi.fn(() => {
            throw error;
        });
        const isDocContentSame = await loadComparison({ cmp });

        await expect(isDocContentSame("same", "same")).rejects.toBe(error);
        expect(cmp).toHaveBeenCalledTimes(1);
    });

    it("retains the selected host's Buffer fallback when the primary encoder fails", async () => {
        const error = new Error("Primary encoder failed");
        const encode = vi.fn().mockRejectedValue(error);
        vi.doMock("octagonal-wheels/binary", async (importOriginal) => ({
            ...(await importOriginal<typeof import("octagonal-wheels/binary")>()),
            arrayBufferToBase64Single: encode,
        }));
        const fallback = {
            from: vi.fn((buffer: ArrayBuffer, offset: number, length: number) => Buffer.from(buffer, offset, length)),
        };
        vi.stubGlobal("window", { fetch: globalThis.fetch, Buffer: fallback });
        const { isDocContentSame } = await import("./utils");

        expect(
            await isDocContentSame(new Blob([new Uint8Array([0, 128, 255])]), new Uint8Array([0, 128, 255]).buffer)
        ).toBe(true);
        expect(encode).toHaveBeenCalledTimes(2);
        expect(fallback.from).toHaveBeenCalledTimes(2);
        expect(fallback.from.mock.contexts).toEqual([fallback, fallback]);
        for (const [buffer, offset, length] of fallback.from.mock.calls) {
            expect(new Uint8Array(buffer, offset, length)).toEqual(new Uint8Array([0, 128, 255]));
        }
    });

    it("preserves an encoder failure when the selected host has no Buffer fallback", async () => {
        const error = new Error("Primary encoder failed");
        const encode = vi.fn().mockRejectedValue(error);
        vi.doMock("octagonal-wheels/binary", async (importOriginal) => ({
            ...(await importOriginal<typeof import("octagonal-wheels/binary")>()),
            arrayBufferToBase64Single: encode,
        }));
        vi.stubGlobal("window", { fetch: globalThis.fetch });
        const { isDocContentSame } = await import("./utils");

        await expect(isDocContentSame("same", "same")).rejects.toBe(error);
        expect(encode).toHaveBeenCalledTimes(1);
    });
});
