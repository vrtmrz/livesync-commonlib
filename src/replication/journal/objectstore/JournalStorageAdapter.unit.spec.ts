import { describe, expect, it, vi } from "vitest";

import {
    inspectJournalStorageRemoteFormatV1,
    invalidateJournalStorageRemoteFormatV1,
    recordJournalStorageRemoteFormatV1,
    type IJournalStorage,
} from "./JournalStorageAdapter.ts";

function storageWithInspection(
    inspectRemoteFormat: IJournalStorage["inspectRemoteFormat"],
    storageIdentity: () => string = () => "test-storage"
): IJournalStorage {
    return {
        get storageIdentity() {
            return storageIdentity();
        },
        inspectRemoteFormat,
    } as unknown as IJournalStorage;
}

describe("Journal storage remote format cache", () => {
    it("coalesces concurrent inspections and reuses the settled result", async () => {
        const inspectRemoteFormat = vi.fn(async () => "opaque-v1" as const);
        const storage = storageWithInspection(inspectRemoteFormat);

        await expect(
            Promise.all([
                inspectJournalStorageRemoteFormatV1(storage),
                inspectJournalStorageRemoteFormatV1(storage),
                inspectJournalStorageRemoteFormatV1(storage),
            ])
        ).resolves.toEqual(["opaque-v1", "opaque-v1", "opaque-v1"]);
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("opaque-v1");

        expect(inspectRemoteFormat).toHaveBeenCalledOnce();
    });

    it("retries an inspection which failed", async () => {
        const inspectRemoteFormat = vi
            .fn()
            .mockRejectedValueOnce(new Error("temporarily unavailable"))
            .mockResolvedValueOnce("opaque-v1" as const);
        const storage = storageWithInspection(inspectRemoteFormat);

        await expect(inspectJournalStorageRemoteFormatV1(storage)).rejects.toThrow("temporarily unavailable");
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("opaque-v1");

        expect(inspectRemoteFormat).toHaveBeenCalledTimes(2);
    });

    it("does not retain an empty result which another client can initialise", async () => {
        const inspectRemoteFormat = vi.fn(async () => "empty" as const);
        const storage = storageWithInspection(inspectRemoteFormat);

        await expect(
            Promise.all([inspectJournalStorageRemoteFormatV1(storage), inspectJournalStorageRemoteFormatV1(storage)])
        ).resolves.toEqual(["empty", "empty"]);
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("empty");

        expect(inspectRemoteFormat).toHaveBeenCalledTimes(2);
    });

    it("inspects again when the storage identity changes", async () => {
        let identity = "first";
        const inspectRemoteFormat = vi.fn(async () => "opaque-v1" as const);
        const storage = storageWithInspection(inspectRemoteFormat, () => identity);

        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("opaque-v1");
        identity = "second";
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("opaque-v1");

        expect(inspectRemoteFormat).toHaveBeenCalledTimes(2);
    });

    it("records known transitions and supports explicit invalidation", async () => {
        const inspectRemoteFormat = vi.fn(async () => "adaptive-v1" as const);
        const storage = storageWithInspection(inspectRemoteFormat);

        recordJournalStorageRemoteFormatV1(storage, "opaque-v1");
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("opaque-v1");
        expect(inspectRemoteFormat).not.toHaveBeenCalled();

        recordJournalStorageRemoteFormatV1(storage, "empty");
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("adaptive-v1");
        expect(inspectRemoteFormat).toHaveBeenCalledOnce();

        invalidateJournalStorageRemoteFormatV1(storage);
        await expect(inspectJournalStorageRemoteFormatV1(storage)).resolves.toBe("adaptive-v1");
        expect(inspectRemoteFormat).toHaveBeenCalledTimes(2);
    });
});
