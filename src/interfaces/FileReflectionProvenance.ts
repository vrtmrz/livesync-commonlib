import type { FilePathWithPrefix } from "@lib/common/types";
import type { SimpleStore } from "@lib/common/utils";

export type FileReflectionProvenanceRecord = {
    /** Exact database revision which most recently produced the storage state. */
    revision: string;
    /** Raw modification time observed from this device's storage after reflection. */
    observedStorageMtime?: number;
};

export interface FileReflectionProvenance {
    get(path: FilePathWithPrefix): Promise<FileReflectionProvenanceRecord | undefined>;
    set(path: FilePathWithPrefix, record: FileReflectionProvenanceRecord): Promise<void>;
    delete(path: FilePathWithPrefix): Promise<void>;
    move(from: FilePathWithPrefix, to: FilePathWithPrefix): Promise<void>;
}

/**
 * Device-local provenance backed by an existing host-owned key-value store.
 *
 * The revision is authoritative. The raw storage mtime is diagnostic and may
 * be used as a fast change hint, but it never proves content or branch identity.
 * The host may construct this object before opening its store, but it must not
 * invoke provenance operations until its normal storage lifecycle is ready.
 * Store failures are reported to the caller rather than hidden by readiness
 * waits, so lifecycle violations and reset races cannot hang file processing.
 */
export class StoredFileReflectionProvenance implements FileReflectionProvenance {
    constructor(private readonly store: SimpleStore<FileReflectionProvenanceRecord>) {}

    async get(path: FilePathWithPrefix): Promise<FileReflectionProvenanceRecord | undefined> {
        return (await this.store.get(path)) ?? undefined;
    }

    async set(path: FilePathWithPrefix, record: FileReflectionProvenanceRecord): Promise<void> {
        await this.store.set(path, record);
    }

    async delete(path: FilePathWithPrefix): Promise<void> {
        await this.store.delete(path);
    }

    async move(from: FilePathWithPrefix, to: FilePathWithPrefix): Promise<void> {
        const record = await this.get(from);
        if (record) {
            await this.set(to, record);
        }
        await this.delete(from);
    }
}
