import type { FilePathWithPrefix } from "@lib/common/types";
import type { SimpleStore } from "@lib/common/utils";

export type FileReflectionProvenanceRecord = {
    /** Exact revision most recently saved from or reflected in storage; the base for subsequent edits. */
    revision: string;
    /** Raw modification time of the saved snapshot or storage observed after reflection. */
    observedStorageMtime?: number;
    /** Algorithm-tagged hash of the exact saved or reflected bytes, independent of revision retention. */
    contentHash?: string;
    /** Byte length of the hashed snapshot. Old records may omit both content fields. */
    contentSize?: number;
};

export interface FileReflectionProvenance {
    get(path: FilePathWithPrefix): Promise<FileReflectionProvenanceRecord | undefined>;
    set(path: FilePathWithPrefix, record: FileReflectionProvenanceRecord): Promise<void>;
    delete(path: FilePathWithPrefix): Promise<void>;
    move(from: FilePathWithPrefix, to: FilePathWithPrefix): Promise<void>;
    /**
     * Enumerate the complete provenance namespace without reading record values.
     * @returns Existing paths; backing-store failures reject the promise.
     * @remarks Absence of this optional method means that enumeration is unsupported.
     */
    listPaths?: () => Promise<FilePathWithPrefix[]>;
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
    declare listPaths?: () => Promise<FilePathWithPrefix[]>;

    /**
     * Create a provenance view without opening or reading its backing store.
     * @param store - The host-owned, namespaced store used by later operations.
     * @param enableEnumeration - Advertise keys-only enumeration when true; defaults to false.
     * @remarks Registering the optional capability performs no I/O. The host must
     * complete its normal store lifecycle before invoking any provenance operation.
     */
    constructor(
        private readonly store: SimpleStore<FileReflectionProvenanceRecord>,
        enableEnumeration = false
    ) {
        // Register the optional capability without accessing a store which may not yet be open.
        if (enableEnumeration) {
            this.listPaths = async () =>
                (await this.store.keys(undefined, undefined)).map((path) => path as FilePathWithPrefix);
        }
    }

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
