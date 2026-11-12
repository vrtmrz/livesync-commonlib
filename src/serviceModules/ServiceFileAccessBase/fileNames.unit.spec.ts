import { describe, expect, it, vi } from "vitest";
import { parseFilePath } from "@lib/platform/pathComparison.ts";
import type { FilePath, PathComparisonSettings } from "@lib/platform/pathTypes.ts";
import {
    createFallbackFileNameLookup,
    findPathIdentityCandidates,
    getIndex,
    invalidateFileNameLookup,
    type FallbackFileNameLookupState,
} from "./fileNames.ts";

const insensitive: PathComparisonSettings = { pathNormalizationVersion: 0, handleFilenameCaseSensitive: false };

function deferredNames() {
    let resolve!: (paths: FilePath[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<FilePath[]>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function names(...paths: string[]): FilePath[] {
    return paths.map(parseFilePath);
}

describe("non-indexed host file-name lookup", () => {
    it("shares a pending listing and returns every matching original spelling", async () => {
        const read = deferredNames();
        const getFileNames = vi.fn(() => read.promise);
        const lookup = createFallbackFileNameLookup({ getFileNames, getStorageFileEventCount: () => 0 });

        const first = lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive);
        const second = lookup.findPathIdentityCandidates(parseFilePath("A.md"), insensitive);
        expect(getFileNames).toHaveBeenCalledOnce();
        read.resolve(names("a.md", "A.md"));
        await expect(first).resolves.toEqual(["A.md", "a.md"]);
        await expect(second).resolves.toEqual(["A.md", "a.md"]);
    });

    it("retires a request invalidated while its host listing starts", async () => {
        const getFileNames = vi.fn(async () => {
            if (getFileNames.mock.calls.length === 1) {
                lookup.invalidate();
                return names("A.md");
            }
            return names("A.md", "a.md");
        });
        const lookup = createFallbackFileNameLookup({ getFileNames, getStorageFileEventCount: () => 0 });
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual(["A.md"]);
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(2);
    });

    it("keeps a newer request when an invalidated older listing finishes", async () => {
        const oldRead = deferredNames();
        const getFileNames = vi
            .fn()
            .mockImplementationOnce(() => oldRead.promise)
            .mockResolvedValue(names("A.md", "a.md"));
        const lookup = createFallbackFileNameLookup({ getFileNames, getStorageFileEventCount: () => 0 });
        const old = lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive);

        lookup.invalidate();
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        oldRead.resolve(names("A.md"));
        await expect(old).resolves.toEqual(["A.md"]);
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(2);
    });

    it("retries a failed listing without evicting a newer request on an older failure", async () => {
        const oldRead = deferredNames();
        const getFileNames = vi
            .fn()
            .mockRejectedValueOnce(new Error("initial read failed"))
            .mockImplementationOnce(() => oldRead.promise)
            .mockResolvedValue(names("A.md", "a.md"));
        const lookup = createFallbackFileNameLookup({ getFileNames, getStorageFileEventCount: () => 0 });
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).rejects.toThrow(
            "initial read failed"
        );
        const old = lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive);
        const rejectedOld = expect(old).rejects.toThrow("older read failed");

        lookup.invalidate();
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        oldRead.reject(new Error("older read failed"));
        await rejectedOld;
        await expect(lookup.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(3);
    });

    it("reads again when the active comparison policy or storage event count changes", async () => {
        let eventCount = 0;
        const getFileNames = vi.fn(async () => names("cafe\u0301.md", "café.md"));
        const lookup = createFallbackFileNameLookup({ getFileNames, getStorageFileEventCount: () => eventCount });
        const legacy = { pathNormalizationVersion: 0, handleFilenameCaseSensitive: true } as const;
        const nfc = { pathNormalizationVersion: 1, handleFilenameCaseSensitive: true } as const;

        await expect(lookup.findPathIdentityCandidates(parseFilePath("café.md"), legacy)).resolves.toEqual(["café.md"]);
        await lookup.findPathIdentityCandidates(parseFilePath("café.md"), legacy);
        expect(getFileNames).toHaveBeenCalledOnce();
        await expect(lookup.findPathIdentityCandidates(parseFilePath("café.md"), nfc)).resolves.toEqual([
            "cafe\u0301.md",
            "café.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(2);
        eventCount++;
        await lookup.findPathIdentityCandidates(parseFilePath("café.md"), nfc);
        expect(getFileNames).toHaveBeenCalledTimes(3);
    });

    it("keeps listings independent between service instances", async () => {
        const first = createFallbackFileNameLookup({
            getFileNames: async () => names("first.md"),
            getStorageFileEventCount: () => 0,
        });
        const second = createFallbackFileNameLookup({
            getFileNames: async () => names("second.md"),
            getStorageFileEventCount: () => 0,
        });
        await expect(first.findPathIdentityCandidates(parseFilePath("first.md"), insensitive)).resolves.toEqual([
            "first.md",
        ]);
        await expect(second.findPathIdentityCandidates(parseFilePath("first.md"), insensitive)).resolves.toEqual([]);
        first.invalidate();
        await expect(second.findPathIdentityCandidates(parseFilePath("second.md"), insensitive)).resolves.toEqual([
            "second.md",
        ]);
    });
});

describe("standalone fallback lookup operations", () => {
    it("shares the same pending index promise using only the host listing port", async () => {
        const read = deferredNames();
        const getFileNames = vi.fn(() => read.promise);
        const state: FallbackFileNameLookupState = { retained: undefined };
        const snapshot = { storageEventCount: 0, policy: insensitive };

        const first = getIndex({ getFileNames }, state, snapshot);
        const second = getIndex({ getFileNames }, state, snapshot);

        expect(first).toBe(second);
        expect(getFileNames).toHaveBeenCalledOnce();
        read.resolve(names("a.md", "A.md"));
        const index = await first;
        expect(index.findPathIdentityCandidates(parseFilePath("a.md"), insensitive)).toEqual(["A.md", "a.md"]);
        expect(state.retained?.index).toBe(first);
    });

    it("publishes the request before a host callback can invalidate it", async () => {
        const state: FallbackFileNameLookupState = { retained: undefined };
        let publishedBeforeHostRead = false;
        const getFileNames = vi.fn(() => {
            publishedBeforeHostRead = state.retained !== undefined;
            invalidateFileNameLookup(state);
            return Promise.resolve(names("old.md"));
        });

        const index = await getIndex({ getFileNames }, state, { storageEventCount: 0, policy: insensitive });

        expect(publishedBeforeHostRead).toBe(true);
        expect(state.retained).toBeUndefined();
        expect(index.getFileNames()).toEqual(["old.md"]);
    });

    it("does not let an invalidated older rejection retire a newer index request", async () => {
        const oldRead = deferredNames();
        const getFileNames = vi
            .fn()
            .mockImplementationOnce(() => oldRead.promise)
            .mockResolvedValue(names("A.md", "a.md"));
        const state: FallbackFileNameLookupState = { retained: undefined };
        const snapshot = { storageEventCount: 0, policy: insensitive };
        const old = getIndex({ getFileNames }, state, snapshot);
        const oldRejection = expect(old).rejects.toThrow("retired read failed");

        invalidateFileNameLookup(state);
        const current = getIndex({ getFileNames }, state, snapshot);
        oldRead.reject(new Error("retired read failed"));
        await oldRejection;
        await current;

        expect(getIndex({ getFileNames }, state, snapshot)).toBe(current);
        expect(getFileNames).toHaveBeenCalledTimes(2);
    });

    it("retires a rejected active request so the next caller can retry", async () => {
        const getFileNames = vi
            .fn()
            .mockRejectedValueOnce(new Error("active read failed"))
            .mockResolvedValue(names("retry.md"));
        const state: FallbackFileNameLookupState = { retained: undefined };
        const snapshot = { storageEventCount: 0, policy: insensitive };

        await expect(getIndex({ getFileNames }, state, snapshot)).rejects.toThrow("active read failed");
        expect(state.retained).toBeUndefined();
        const index = await getIndex({ getFileNames }, state, snapshot);

        expect(index.getFileNames()).toEqual(["retry.md"]);
        expect(getFileNames).toHaveBeenCalledTimes(2);
    });

    it("captures policy values before awaiting names and rereads after a new observation", async () => {
        const read = deferredNames();
        const getFileNames = vi
            .fn()
            .mockImplementationOnce(() => read.promise)
            .mockResolvedValue(names("A.md", "a.md"));
        let storageEventCount = 0;
        const dependencies = { getFileNames, getStorageFileEventCount: () => storageEventCount };
        const state: FallbackFileNameLookupState = { retained: undefined };
        const policy = { ...insensitive };

        const pending = findPathIdentityCandidates(dependencies, state, parseFilePath("a.md"), policy);
        policy.handleFilenameCaseSensitive = true;
        read.resolve(names("A.md", "a.md"));
        await expect(pending).resolves.toEqual(["A.md", "a.md"]);
        await expect(findPathIdentityCandidates(dependencies, state, parseFilePath("a.md"), policy)).resolves.toEqual([
            "a.md",
        ]);
        storageEventCount++;
        await findPathIdentityCandidates(dependencies, state, parseFilePath("a.md"), policy);

        expect(getFileNames).toHaveBeenCalledTimes(3);
    });
});
