import { describe, expect, it, vi } from "vitest";
import { updateToStorage, FilePairProcessResults, syncFileBetweenDBandStorage } from "./offlineScanner";
import { LOG_LEVEL_INFO, type MetaEntry } from "@lib/common/types";
import { TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";

describe("scan reflection terminal failure", () => {
    it("reports a thrown read failure for the selected scan revision", async () => {
        const error = new Error("Metadata read failed");
        const entry = { _id: "note.md", _rev: "3-incoming", path: "note.md", size: 1 } as MetaEntry;
        const onReflectionFailed = vi.fn();
        const host = {
            services: { path: { getPath: () => entry.path }, vault: { isFileSizeTooLarge: () => false } },
            serviceModules: {
                fileHandler: {
                    reflectDatabaseEntry: vi.fn(async () => {
                        throw error;
                    }),
                },
            },
        };
        const result = await updateToStorage(host as never, vi.fn(), LOG_LEVEL_INFO, entry, { onReflectionFailed });
        expect(result).toBe(FilePairProcessResults.FAILED);
        expect(onReflectionFailed).toHaveBeenCalledExactlyOnceWith(
            { documentId: entry._id, revision: "3-incoming" },
            error
        );
    });
});

describe("scan reflection outcome conversion", () => {
    it.each(["completed", "policy", "cancelled"] as const)(
        "maps %s consistently for creation and replacement without publishing skipped work",
        async (status) => {
            const entry = { _id: "note.md", _rev: "3-target", path: "note.md", size: 1 } as MetaEntry;
            const emitEvent = vi.fn();
            const onReflectionFailed = vi.fn();
            const file = { path: "note.md", stat: { size: 1 } };
            const host = {
                services: {
                    context: { events: { emitEvent } },
                    path: { getPath: () => entry.path, compareFileFreshness: () => TARGET_IS_NEW },
                    vault: { isFileSizeTooLarge: () => false },
                },
                serviceModules: { fileHandler: { reflectDatabaseEntry: vi.fn(async () => ({ status })) } },
            };
            const expected = status === "completed" ? FilePairProcessResults.COMPLETED : FilePairProcessResults.SKIPPED;
            expect(await updateToStorage(host as never, vi.fn(), LOG_LEVEL_INFO, entry, { onReflectionFailed })).toBe(
                expected
            );
            expect(
                await syncFileBetweenDBandStorage(host as never, vi.fn(), file as never, entry, { onReflectionFailed })
            ).toBe(expected);
            expect(emitEvent).toHaveBeenCalledTimes(status === "completed" ? 2 : 0);
            expect(onReflectionFailed).not.toHaveBeenCalled();
        }
    );

    it("propagates a failed retention save as its own original rejection", async () => {
        const entry = { _id: "note.md", _rev: "3-target", path: "note.md", size: 1 } as MetaEntry;
        const readError = new Error("read failed");
        const saveError = new Error("snapshot failed");
        const onReflectionFailed = vi.fn(async () => {
            throw saveError;
        });
        const host = {
            services: { path: { getPath: () => entry.path }, vault: { isFileSizeTooLarge: () => false } },
            serviceModules: {
                fileHandler: {
                    reflectDatabaseEntry: vi.fn(async () => {
                        throw readError;
                    }),
                },
            },
        };
        await expect(
            updateToStorage(host as never, vi.fn(), LOG_LEVEL_INFO, entry, { onReflectionFailed })
        ).rejects.toBe(saveError);
        expect(onReflectionFailed).toHaveBeenCalledExactlyOnceWith(
            { documentId: entry._id, revision: entry._rev },
            readError
        );
    });
});
