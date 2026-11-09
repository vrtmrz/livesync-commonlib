/**
 * Convert host watcher notifications into file-event admissions.
 * Payload checks belong here; durable ownership and handler completion belong
 * to the admission and queue modules after the host facade accepts an event.
 */
import type { FilePath } from "@lib/common/types";
import type { FileEvent } from "@lib/interfaces/StorageEventManager";
import type { IStorageEventManagerAdapter, IStorageEventTypeGuardAdapter } from "../adapters";

/** The rename variant requires the source path and remains one operation. */
export type WatchedVaultEvent =
    | { type: "CREATE" | "CHANGED" | "DELETE"; file: unknown }
    | { type: "RENAME"; file: unknown; oldPath: string };

/** Resolve the current adapter and virtual admission method when a notification arrives. */
export interface StorageEventWatchEffects<TFile, TFolder> {
    /** Resolve the current adapter without rebinding its guard or converter methods. */
    adapter(): Pick<IStorageEventManagerAdapter<TFile, TFolder>, "typeGuard" | "converter">;
    /** Report a currently processed path for notification suppression; rename bypasses this check. */
    isProcessing(path: FilePath): boolean;
    /** Complete facade admission without awaiting the admitted file handlers. */
    append(events: FileEvent[], ctx?: unknown): Promise<void>;
}

/**
 * Narrow a host-supplied path at the watcher boundary.
 * The host owns its Vault-relative namespace; this checks the payload type and
 * preserves the path verbatim rather than normalising database prefixes.
 *
 * @param value - The path value received from the host.
 * @returns Whether the value can be treated as a host storage path.
 */
export function isStorageEventPath(value: unknown): value is FilePath {
    return typeof value === "string";
}

/**
 * Check the path property before a host object is used for processing guards.
 *
 * @param value - The host object whose path has not yet been inspected.
 * @returns Whether the object carries a string path in the host storage namespace.
 */
function hasStorageEventPath(value: unknown): value is { path: FilePath } {
    return typeof value === "object" && value !== null && "path" in value && isStorageEventPath(value.path);
}

/**
 * Combine the adapter's platform-specific file guard with the path shape needed
 * by watcher admission. A folder or unrecognised payload never reaches conversion.
 *
 * @typeParam TFile - The file type recognised by the platform adapter.
 * @typeParam TFolder - The folder type recognised by the same adapter.
 * @param file - The notification payload before type narrowing.
 * @param guard - The adapter which owns platform-specific file recognition.
 * @returns Whether both the platform-file and storage-path contracts hold.
 */
export function isWatchedFile<TFile, TFolder>(
    file: unknown,
    guard: IStorageEventTypeGuardAdapter<TFile, TFolder>
): file is TFile & { path: FilePath } {
    return guard.isFile(file) && hasStorageEventPath(file);
}

/**
 * Forward a validated notification through the facade's admission callback.
 * Create, change, and delete suppress notifications while the path is being processed.
 * Rename retains its distinct route: it bypasses that suppression and batching
 * so the queue can preserve the source/destination ordering as one operation.
 * This returns after admission starts; append owns asynchronous failure reporting.
 *
 * @typeParam TFile - The platform file representation accepted by the adapter.
 * @typeParam TFolder - The folder representation used by the same adapter.
 * @param notification - The host event; rename includes the previous path.
 * @param ctx - The host context forwarded unchanged to admission.
 * @param effects - Current adapter access, processing-state checks, and virtual admission.
 * @returns No completion result; accepted notifications start asynchronous admission.
 * @remarks
 * The facade retains its protected watcher methods so host overrides still run.
 * This helper centralises conversion; a host normally extends the adapter or those hooks.
 */
export function forwardVaultEvent<TFile, TFolder>(
    notification: WatchedVaultEvent,
    ctx: unknown,
    effects: StorageEventWatchEffects<TFile, TFolder>
): void {
    const adapter = effects.adapter();
    const file = notification.file;
    if (!isWatchedFile(file, adapter.typeGuard)) return;
    if (notification.type !== "RENAME" && effects.isProcessing(file.path)) return;
    const fileInfo =
        notification.type === "DELETE" ? adapter.converter.toFileInfo(file, true) : adapter.converter.toFileInfo(file);
    const event: FileEvent =
        notification.type === "RENAME"
            ? { type: "RENAME", file: fileInfo, oldPath: notification.oldPath, skipBatchWait: true }
            : { type: notification.type, file: fileInfo };
    void effects.append([event], ctx);
}

/**
 * Validate the common editor envelope before the facade reads its live batching setting.
 *
 * @param info - The editor notification supplied by a platform watcher.
 * @returns Whether a path property exists; its value is checked when the change is read.
 */
export function hasEditorChangePath(info: unknown): info is { path: unknown } {
    return typeof info === "object" && info !== null && "path" in info;
}

/**
 * Extract a usable editor change without admitting it or changing batch gates.
 * Recognised platform files supply their own path; other host editor payloads
 * retain the envelope-path fallback. Optional cached text is accepted only as text.
 *
 * @param info - The editor envelope after its path property has been established.
 * @param isFile - Platform recognition used to choose the authoritative path.
 * @returns The selected file, path, and optional text, or null when the path is unusable.
 */
export function readEditorFileChange(
    info: { path: unknown; file?: unknown; data?: unknown },
    isFile: (file: unknown) => boolean
) {
    if (!("file" in info) || !info.file) return null;
    const file = info.file;
    const path = isFile(file) ? (hasStorageEventPath(file) ? file.path : undefined) : info.path;
    if (!isStorageEventPath(path) || !path) return null;
    const data = "data" in info && typeof info.data === "string" ? info.data : undefined;
    return { file, path, data };
}
