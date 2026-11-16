import { describe, expect, it, vi } from "vitest";
import { updateToStorage, FilePairProcessResults } from "./offlineScanner";
import { LOG_LEVEL_INFO, type MetaEntry } from "@lib/common/types";

describe("scan reflection terminal failure", () => {
    it("reports a thrown read failure for the selected scan revision", async () => {
        const error = new Error("Metadata read failed");
        const entry = { _id: "note.md", _rev: "3-incoming", path: "note.md", size: 1 } as MetaEntry;
        const onReflectionFailed = vi.fn();
        const host = {
            services: { path: { getPath: () => entry.path }, vault: { isFileSizeTooLarge: () => false } },
            serviceModules: { fileHandler: { reflectDatabaseEntry: vi.fn(async () => {
                throw error;
            }) } },
        };
        const result = await updateToStorage(host as never, vi.fn(), LOG_LEVEL_INFO, entry, { onReflectionFailed }).catch(() => FilePairProcessResults.FAILED);
        expect(result).toBe(FilePairProcessResults.FAILED);
        expect(onReflectionFailed).toHaveBeenCalledExactlyOnceWith({ documentId: entry._id, revision: "3-incoming" }, error);
    });
});
