import type {
    AnyEntry,
    FilePath,
    FilePathWithPrefix,
    UXFileInfo,
    UXFileInfoStub,
    UXInternalFileInfoStub,
} from "@lib/common/types";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import type { StoreFileOptions } from "@lib/interfaces/FileHandler";
import type { APIService } from "@lib/services/base/APIService";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import type { ReplicationService } from "@lib/services/base/ReplicationService";
import type { ConflictService } from "@lib/services/base/ConflictService";
import type { PathService } from "@lib/services/base/PathService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { VaultService } from "@lib/services/base/VaultService";
import type {
    FileReflectionProvenance,
    FileReflectionProvenanceRecord,
} from "@lib/interfaces/FileReflectionProvenance";
import type { LogFunction } from "@lib/services/lib/logUtils";

/** Services captured when the host constructs its file-handler facade. */
export interface ServiceFileHandlerDependencies {
    /** Host event hub used for conflict-cancellation notifications. */
    events: LiveSyncEventHub;
    /** Host logging service used by the inherited module logger. */
    API: APIService;
    /** Database access captured by the facade at construction. */
    databaseFileAccess: DatabaseFileAccess;
    /** Storage access captured by the facade at construction. */
    storageAccess: StorageAccess;
    /** Storage-event handler registration owned by the host. */
    fileProcessing: FileProcessingService;
    /** Replicated-document handler registration owned by the host. */
    replication: ReplicationService;
    /** Conflict review hooks delivered outside document locks. */
    conflict: ConflictService;
    /** Path identity and freshness service captured at construction. */
    path: PathService;
    /** Live settings service captured at construction. */
    setting: SettingService;
    /** Current vault selection and size policy service. */
    vault: VaultService;
    /**
     * Device-local record of the exact database revision reflected in storage.
     *
     * This is optional for compatibility hosts. Maintained hosts should provide
     * it so edits made while a document is conflicted extend the displayed
     * branch instead of whichever branch PouchDB currently selects as winner.
     * The host must finish opening its backing store before it dispatches file
     * or replication events; provenance does not hide lifecycle violations by
     * waiting for readiness.
     */
    fileReflectionProvenance?: FileReflectionProvenance;
}

/** Exact storage bytes and the provenance observed alongside them. */
export type StorageSnapshot = {
    /** Immutable body and raw file statistics captured from storage. */
    file: UXFileInfo;
    /** Copied device-local revision evidence captured with those bytes. */
    revision: FileReflectionProvenanceRecord | undefined;
};
/** Result controlling whether an incoming effect must stop or revalidate a candidate. */
export interface PreservationResult {
    /** Stop the incoming write, including when a preservation branch write was refused. */
    preserved: boolean;
    /** Candidate bytes/provenance requiring final revalidation; absence can mean unstable or unproven safety. */
    snapshot?: StorageSnapshot;
}
/** A conflict review retained until its document lock is released. */
export type DeferredConflictCheck = {
    /** Storage path to review after unlocking. */
    path: FilePathWithPrefix;
    /** Whether only an existing open review should be refreshed. */
    ifOpen: boolean;
};
/** Remaining effect of a saved operation after inspecting current storage. */
export type RestoredFileEventAction =
    | { kind: "none" }
    | { kind: "unresolved" }
    | { kind: "store"; file: UXFileInfoStub; complete?: boolean }
    | { kind: "delete"; path: FilePath }
    | { kind: "rename"; file: UXFileInfoStub; oldPath: FilePathWithPrefix };

/** Dynamic public seams retained for host subclasses and runtime replacements. */
export interface FileHandlerHost {
    /**
     * Resolve the current virtual database getter.
     * @returns Current database access.
     * @remarks Getter overrides and later host replacements remain visible at each access site.
     */
    db(): DatabaseFileAccess;
    /**
     * Resolve the current virtual storage getter.
     * @returns Current storage access.
     * @remarks Getter overrides and later host replacements remain visible at each access site.
     */
    storage(): StorageAccess;
    /** Route diagnostics through the current public logger. */
    log: LogFunction;
    /**
     * Resolve metadata through the current virtual path method.
     * @param entry - Metadata to resolve.
     * @returns Its host path.
     * @remarks This seam does not acquire a document lock.
     */
    getPath(entry: AnyEntry): FilePathWithPrefix;
    /**
     * Resolve a storage path through the current virtual method.
     * @param entry - Metadata to resolve.
     * @returns Its unprefixed host path.
     * @remarks This seam remains independent of the virtual metadata-path method.
     */
    getPathWithoutPrefix(entry: AnyEntry): FilePathWithPrefix;
    /**
     * Read through the current virtual reader.
     * @param file - The supplied observation.
     * @returns Its supplied or current body.
     * @remarks Callers retain their surrounding document lock and original read count.
     */
    readFileFromStub(file: UXFileInfoStub | UXFileInfo): Promise<UXFileInfo>;
    /**
     * Invoke the virtual save boundary used by chunk repair.
     * @param info - File observation or path to save.
     * @param force - Existing force policy.
     * @param onlyChunks - Whether only missing chunks should be created.
     * @param options - Existing recovery revalidation option.
     * @returns Whether the requested save completed or safely skipped.
     * @remarks The public save method owns document locking.
     */
    storeFileToDB(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force?: boolean,
        onlyChunks?: boolean,
        options?: StoreFileOptions
    ): Promise<boolean>;
}

/** Mutable state belonging to one facade instance, never shared across hosts. */
export interface FileHandlerState {
    /** Hashes reused only for the same immutable Blob object. */
    readonly contentHashes: WeakMap<Blob, Promise<string>>;
    /** Pending post-lock hooks keyed by normalised document identity. */
    readonly deferredConflictChecks: Map<string, DeferredConflictCheck[]>;
}
/** Captured service values, per-instance state, and the small virtual host boundary. */
export interface FileHandlerContext {
    /** Existing host event hub. */
    readonly events: LiveSyncEventHub;
    /** Existing conflict-review hooks. */
    readonly conflict: ConflictService;
    /** Existing path identity and freshness policy. */
    readonly path: PathService;
    /** Existing settings service; settings remain live when its getter is called. */
    readonly setting: SettingService;
    /** Existing vault selection and size policy. */
    readonly vault: VaultService;
    /** Optional device-local record store captured at construction. */
    readonly provenance?: FileReflectionProvenance;
    /** Per-instance mutable hashes and deferred hooks. */
    readonly state: FileHandlerState;
    /** Public methods and getters resolved dynamically at use time. */
    readonly host: FileHandlerHost;
}

/**
 * Capture service values and allocate the facade's existing per-instance state.
 * @param services - Services supplied at construction; later property replacement does not change this context.
 * @param host - Dynamic public seams; internal helpers are called directly rather than mirrored here.
 * @returns The isolated context used by responsibility functions.
 * @remarks No I/O, document locking, handler registration, or provenance access occurs here.
 */
export function createFileHandlerContext(
    services: ServiceFileHandlerDependencies,
    host: FileHandlerHost
): FileHandlerContext {
    return {
        events: services.events,
        conflict: services.conflict,
        path: services.path,
        setting: services.setting,
        vault: services.vault,
        provenance: services.fileReflectionProvenance,
        host,
        state: { contentHashes: new WeakMap(), deferredConflictChecks: new Map() },
    };
}
