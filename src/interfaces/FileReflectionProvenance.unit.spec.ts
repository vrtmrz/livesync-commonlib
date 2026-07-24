import { describe, expect, it, vi } from "vitest";
import type { FilePathWithPrefix } from "@lib/common/types";
import type { SimpleStore } from "@lib/common/utils";
import { StoredFileReflectionProvenance, type FileReflectionProvenanceRecord } from "./FileReflectionProvenance";

function createStore() {
    const values = new Map<string, FileReflectionProvenanceRecord>();
    const store = {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: FileReflectionProvenanceRecord) => {
            values.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
            values.delete(key);
        }),
        keys: vi.fn(async () => [...values.keys()]),
        db: undefined,
    } as unknown as SimpleStore<FileReflectionProvenanceRecord>;
    return { store, values };
}

describe("StoredFileReflectionProvenance", () => {
    it("stores the exact revision and raw observed storage mtime", async () => {
        const { store } = createStore();
        const provenance = new StoredFileReflectionProvenance(store);
        const path = "note.md" as FilePathWithPrefix;
        const record = { revision: "3-displayed", observedStorageMtime: 1234.567 };

        await provenance.set(path, record);

        await expect(provenance.get(path)).resolves.toEqual(record);
        expect(store.set).toHaveBeenCalledWith(path, record);
    });

    it("moves one device-local record without retaining the old path", async () => {
        const { store, values } = createStore();
        const provenance = new StoredFileReflectionProvenance(store);
        const oldPath = "Old.md" as FilePathWithPrefix;
        const newPath = "new.md" as FilePathWithPrefix;
        const record = { revision: "4-renamed", observedStorageMtime: 42 };
        values.set(oldPath, record);

        await provenance.move(oldPath, newPath);

        await expect(provenance.get(oldPath)).resolves.toBeUndefined();
        await expect(provenance.get(newPath)).resolves.toEqual(record);
    });

});
