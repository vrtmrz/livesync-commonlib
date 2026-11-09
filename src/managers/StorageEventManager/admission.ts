/**
 * Select host storage callbacks and admit valid events into the manager's operation queue.
 */
import {
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type FileEventItem,
    type FilePath,
    type ObsidianLiveSyncSettings,
    type UXFileInfoStub,
} from "@lib/common/types";
import { shouldBeIgnored } from "@lib/string_and_binary/path";
import { delay, isRemediationModeActive } from "@lib/common/utils";
import type { FileEvent } from "@lib/interfaces/StorageEventManager";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import type { LogFunction } from "@lib/services/lib/logUtils";
import type { EventAdmission, StorageEventState } from "./state";
import type { PendingFileEvent } from "./operations";

/**
 * Inject host settings, path and file checks, queue actions, and diagnostics into admission.
 * @remarks
 * Admission owns event selection; the facade supplies platform services and asynchronous target checks.
 * Settings are read once for each appended batch, while enqueueing and reporting remain host effects.
 */
export interface StorageEventAdmissionEffects {
    settings(): ObsidianLiveSyncSettings;
    isFolder(file: FileEvent["file"]): boolean;
    isFile(file: FileEvent["file"]): boolean;
    isTarget(path: string): Promise<boolean>;
    isTooLarge(size: number): boolean;
    recentlyTouched: IStorageAccessManager["recentlyTouched"];
    onStorageFileEvent(): void;
    enqueue(event: FileEventItem): void;
    release(operations: readonly PendingFileEvent[]): void;
    reportFailure(error: unknown): void;
    log: LogFunction;
}
/** Normalised event intent before cache data and host context are attached. */
type SelectedFileEvent = Pick<FileEventItem, "type" | "args">;

/**
 * Apply ignore and internal-file rules before asking the host whether a path is a sync target.
 * @param path - The candidate vault path.
 * @param settings - The settings snapshot for this admission batch.
 * @param effects - Host target lookup and other admission services.
 * @returns Whether the path passes local rules and is a host sync target.
 * @throws Any error rejected by the asynchronous host target lookup.
 */
async function isSelectedPath(path: string, settings: ObsidianLiveSyncSettings, effects: StorageEventAdmissionEffects) {
    if (shouldBeIgnored(path)) return false;
    if (!settings.syncInternalFiles && path.startsWith(".")) return false;
    return await effects.isTarget(path);
}

/**
 * Emit the notice used when a selected event is excluded by the file-size limit.
 * @param path - The path of the oversized storage file.
 * @param effects - Host logging service.
 * @returns Nothing; a notice-level log entry is emitted.
 */
function logOversizedEvent(path: string, effects: StorageEventAdmissionEffects): void {
    effects.log(`The storage file has been changed but exceeds the maximum size. Skipping: ${path}`, LOG_LEVEL_NOTICE);
}

/**
 * Convert old and new path selection into the operation which preserves the selected side.
 * @param param - The host rename event.
 * @param oldSelected - Whether the source path is a sync target.
 * @param newSelected - Whether the destination path is a sync target and within the size limit.
 * @returns `null` when neither path is selected; otherwise a CREATE, RENAME, or source-path DELETE intent.
 * @remarks The source-only case asserts that `oldPath` and file `stat` are present; `selectRename` establishes those preconditions.
 */
export function selectRenameFileEvent(
    param: FileEvent,
    oldSelected: boolean,
    newSelected: boolean
): SelectedFileEvent | null {
    if (!oldSelected && !newSelected) return null;
    if (oldSelected && !newSelected) {
        const oldPath = param.oldPath!;
        return {
            type: "DELETE",
            args: {
                file: {
                    path: oldPath as FilePath,
                    name: oldPath.split("/").pop() ?? param.file.name,
                    stat: param.file.stat!,
                    deleted: true,
                },
                oldPath: undefined,
                renameTarget: param.file.path,
            },
        };
    }
    return {
        type: oldSelected ? "RENAME" : "CREATE",
        args: {
            file: param.file,
            oldPath: oldSelected ? param.oldPath : undefined,
        },
    };
}

/**
 * Validate a rename, select both paths, and exclude an oversized destination.
 * @param param - The host rename event to examine.
 * @param settings - The settings snapshot for this admission batch.
 * @param effects - Host file guards, target lookup, size check, and logging.
 * @returns The selected CREATE, RENAME, or DELETE intent, or `null` when invalid or unselected.
 * @throws Any error rejected by asynchronous target lookup.
 */
async function selectRename(
    param: FileEvent,
    settings: ObsidianLiveSyncSettings,
    effects: StorageEventAdmissionEffects
): Promise<SelectedFileEvent | null> {
    const file = param.file as UXFileInfoStub;
    if (!param.oldPath || !effects.isFile(file) || !file.stat) {
        effects.log(`Invalid rename event skipped: ${file.path}`, LOG_LEVEL_VERBOSE);
        return null;
    }
    const oldSelected = await isSelectedPath(param.oldPath, settings, effects);
    let newSelected = await isSelectedPath(file.path, settings, effects);
    if (newSelected && effects.isTooLarge(file.stat.size)) {
        logOversizedEvent(param.file.path, effects);
        newSelected = false;
    }
    return selectRenameFileEvent(param, oldSelected, newSelected);
}

/**
 * Select a non-rename event and apply size filtering to ordinary creates and changes.
 * @param param - The host event to examine.
 * @param settings - The settings snapshot for this admission batch.
 * @param effects - Host target lookup, file-size checks, and logging.
 * @returns The normalised event intent, or `null` when its path is not selected or its file is oversized.
 * @throws Any error rejected by asynchronous target lookup.
 */
async function selectOrdinaryEvent(
    param: FileEvent,
    settings: ObsidianLiveSyncSettings,
    effects: StorageEventAdmissionEffects
): Promise<SelectedFileEvent | null> {
    if (!(await isSelectedPath(param.file.path, settings, effects))) return null;
    if (param.type !== "INTERNAL") {
        const size = (param.file as UXFileInfoStub).stat.size;
        if (effects.isTooLarge(size) && (param.type === "CREATE" || param.type === "CHANGED")) {
            logOversizedEvent(param.file.path, effects);
            return null;
        }
    }
    return { type: param.type, args: { file: param.file, oldPath: undefined } };
}

/**
 * Check whether an eligible file event was recently touched by storage access.
 * @param event - The selected intent to inspect.
 * @param effects - Host file guard and recent-access check.
 * @returns A promise for the host check after a 10 ms delay; non-file and non-create/change/rename intents return `false`.
 * @throws Any error raised or rejected by the host recent-access check.
 */
async function wasRecentlyTouched(event: SelectedFileEvent, effects: StorageEventAdmissionEffects): Promise<boolean> {
    if (!effects.isFile(event.args.file)) return false;
    if (event.type !== "CREATE" && event.type !== "CHANGED" && event.type !== "RENAME") return false;
    await delay(10);
    const file = event.args.file;
    return effects.recentlyTouched({ path: file.path as FilePath, stat: file.stat ?? { ctime: 0, mtime: 0, size: 0 } });
}

/**
 * Filter a host event and attach admission metadata to its selected intent.
 * @param param - The raw host watcher event.
 * @param settings - The settings snapshot shared by the current admission batch.
 * @param ctx - Optional opaque host context to retain with the event.
 * @param effects - Host guards, filtering, recent-access checks, and diagnostics.
 * @returns A queued file event, or `null` when the input is a folder, unselected, oversized, or recently touched.
 * @throws Errors from asynchronous target or recent-access checks.
 */
async function prepareEvent(
    param: FileEvent,
    settings: ObsidianLiveSyncSettings,
    ctx: unknown,
    effects: StorageEventAdmissionEffects
): Promise<FileEventItem | null> {
    const key = [0, 0, 0, 0, 0, 0].map(() => `${Math.floor(Math.random() * 100000)}`).join("-");
    if (effects.isFolder(param.file)) {
        effects.log(`Folder event skipped: ${param.file.path}`, LOG_LEVEL_VERBOSE);
        return null;
    }
    const selected =
        param.type === "RENAME"
            ? await selectRename(param, settings, effects)
            : await selectOrdinaryEvent(param, settings, effects);
    if (!selected || (await wasRecentlyTouched(selected, effects))) return null;
    return {
        ...selected,
        args: { ...selected.args, cache: param.cachedData || undefined, ctx },
        skipBatchWait: param.skipBatchWait,
        key,
    };
}

/**
 * Enqueue a selected item and associate its operation with the admission boundary.
 * @param state - Mutable operation ownership state.
 * @param admission - The batch admission record receiving this operation.
 * @param item - The selected event to enqueue.
 * @param effects - Queue and release actions supplied by the facade.
 * @returns Nothing; a found operation receives admission time, failure boundary, and attempt tracking.
 */
function registerAdmission(
    state: StorageEventState,
    admission: EventAdmission,
    item: FileEventItem,
    effects: StorageEventAdmissionEffects
): void {
    effects.enqueue(item);
    const operation = state.operations.get(item);
    if (!operation) return;
    operation.acceptedAt = admission.acceptedAt;
    operation.failureBoundary = admission.failureBoundary;
    if (admission.flushRequested) effects.release([operation]);
    admission.operations.set(operation, operation.attempt);
}

/**
 * Apply one settings snapshot and prepare events sequentially for queue admission.
 * @param state - Mutable event state.
 * @param params - Host watcher events to examine in order.
 * @param ctx - Optional host context attached to admitted events.
 * @param admission - The admission record which owns accepted operations.
 * @param effects - Host settings, filters, enqueueing, release, logging, and failure reporting.
 * @returns A promise fulfilled after filtering and enqueueing; it does not await file handlers.
 * @remarks Unconfigured, suspended, and remediation modes return before notifying the file processor.
 * @throws Errors from host filtering, event preparation, or enqueue effects.
 */
async function appendStorageEvents(
    state: StorageEventState,
    params: readonly FileEvent[],
    ctx: unknown,
    admission: EventAdmission,
    effects: StorageEventAdmissionEffects
): Promise<void> {
    const settings = effects.settings();
    if (!settings.isConfigured || settings.suspendFileWatching || isRemediationModeActive(settings)) return;
    effects.onStorageFileEvent();
    for (const param of params) {
        const item = await prepareEvent(param, settings, ctx, effects);
        if (item) registerAdmission(state, admission, item, effects);
    }
}

/**
 * Start and track a batch of host events through filtering and queue admission.
 * @param state - Mutable state which owns admission and operation boundaries.
 * @param params - Host watcher events to select.
 * @param ctx - Optional host context forwarded to admitted items.
 * @param effects - Host services used during selection and enqueueing.
 * @returns A promise for admission completion, not handler completion; rejected admission is reported and remains rejected.
 * @remarks When the manager no longer accepts events, this returns an already-fulfilled promise without admitting them.
 */
export function admitStorageEvents(
    state: StorageEventState,
    params: readonly FileEvent[],
    ctx: unknown,
    effects: StorageEventAdmissionEffects
): Promise<void> {
    if (!state.acceptingEvents) return Promise.resolve();
    const admission: EventAdmission = {
        acceptedAt: Date.now(),
        completion: Promise.resolve(),
        operations: new Map(),
        failureBoundary: state.nextFailureSequence,
        flushRequested: false,
    };
    state.admissions.add(admission);
    admission.completion = appendStorageEvents(state, params, ctx, admission, effects);
    void admission.completion.then(
        () => state.admissions.delete(admission),
        (error) => {
            state.admissions.delete(admission);
            effects.reportFailure(error);
        }
    );
    return admission.completion;
}
