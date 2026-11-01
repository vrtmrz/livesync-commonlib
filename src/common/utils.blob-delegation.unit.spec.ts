import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("indexedDB", undefined);
});

afterEach(() => {
    vi.doUnmock("octagonal-wheels/binary/blob");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function loadDelegation() {
    const shared = await import("octagonal-wheels/binary/blob");
    const isBlobContentEqual = vi.fn(shared.isBlobContentEqual);
    vi.doMock("octagonal-wheels/binary/blob", () => ({ ...shared, isBlobContentEqual }));
    const { isDocContentSame } = await import("./utils");
    return { isDocContentSame, isBlobContentEqual };
}

describe("Blob comparison composition", () => {
    it("delegates the fallback with the original Blobs and a working legacy equality predicate", async () => {
        const { isDocContentSame, isBlobContentEqual } = await loadDelegation();
        const bytes = new Uint8Array(10_001).fill(128);
        const left = new Blob([bytes], { type: "text/plain" });
        const right = new Blob([bytes], { type: "application/custom" });

        expect(await isDocContentSame(left, right)).toBe(true);
        expect(isBlobContentEqual).toHaveBeenCalledExactlyOnceWith(left, right, expect.any(Function));
        const predicate = isBlobContentEqual.mock.calls[0][2]!;
        expect(await predicate(new Uint8Array([0, 128, 255]).buffer, new Uint8Array([0, 128, 255]).buffer)).toBe(true);
        expect(await predicate(new Uint8Array([0, 128, 255]).buffer, new Uint8Array([0, 129, 255]).buffer)).toBe(false);
    });

    it("normalises legacy input representations before invoking the shared comparison", async () => {
        const { isDocContentSame, isBlobContentEqual } = await loadDelegation();

        expect(await isDocContentSame(["first\r", "\n日本語"], "first\r\n日本語")).toBe(true);
        expect(isBlobContentEqual).toHaveBeenCalledTimes(1);
        const [left, right] = isBlobContentEqual.mock.calls[0];
        expect(left).toBeInstanceOf(Blob);
        expect(right).toBeInstanceOf(Blob);
        expect(await left.text()).toBe("first\r\n日本語");
        expect(await right.text()).toBe("first\r\n日本語");
    });

    it("retains the native IndexedDB path without invoking the shared fallback", async () => {
        const cmp = vi.fn(() => 0);
        const indexedDB = { cmp };
        vi.stubGlobal("indexedDB", indexedDB);
        const { isDocContentSame, isBlobContentEqual } = await loadDelegation();

        expect(await isDocContentSame("same", "same")).toBe(true);
        expect(cmp).toHaveBeenCalledTimes(1);
        expect(cmp.mock.contexts[0]).toBe(indexedDB);
        expect(isBlobContentEqual).not.toHaveBeenCalled();
    });
});
