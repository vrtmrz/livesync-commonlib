import { withFileEventPaths } from "./locking";
import {
    isCurrentPathSelected,
    getExactCurrentFile,
    canRecordStorageDeletion,
    logRestoredEventValidationFailure,
    isCurrentFileSelected,
    canApplyRestoredDeletion,
} from "./selection";
import { storeFileToDBFromRevision } from "./saving";
import { deleteFileFromDBIfPresent } from "./deletion";
import { renameFileInDBCore } from "./renaming";
import { isFolderInfo } from "./storage";
import { dbToStorageCore } from "./reflection";

import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type {
    FileEventItem,
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfoStub,
    UXFolderInfo,
} from "@lib/common/types";

import { isReconcileEvent } from "@lib/common/models/fileaccess.definition";

import { EVENT_CONFLICT_CANCELLED } from "@lib/events/coreEvents";
import { shouldBeIgnored } from "@lib/string_and_binary/path";

import type { FileHandlerContext, RestoredFileEventAction } from "./context";

/**
 * Reconcile an ordinary or recovery storage event under every related document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param item - The admitted operation intent and related paths.
 * @returns Whether the event completed or safely skipped; unsupported or unresolved work returns false and inspection errors retain their original propagation.
 * @remarks Operation intent is revalidated under related document locks. Policy skips, retained failures, and conservative conflict handling retain their original meanings.
 */
export async function processFileEvent(ctx: FileHandlerContext, item: FileEventItem): Promise<boolean> {
    if (item.restoredFromPreviousRuntime || isReconcileEvent(item)) {
        return await processRestoredFileEvent(ctx, item);
    }
    // Acquire ordinary content only when its queued operation runs. Restored
    // events also revalidate their persisted deletion and rename intentions.
    const eventItem = item.args;
    const type = item.type;
    const path = eventItem.file.path;
    if (type === "RENAME" && !eventItem.oldPath) {
        ctx.host.log(`Rename event for ${path} has no source path`, LOG_LEVEL_VERBOSE);
        return false;
    }
    const relatedPath = type === "RENAME" ? eventItem.oldPath : type === "DELETE" ? eventItem.renameTarget : undefined;
    const eventPaths = relatedPath === undefined ? [path] : [path, relatedPath as FilePathWithPrefix];
    return await withFileEventPaths(ctx, eventPaths, async () => {
        if (!(await isCurrentPathSelected(ctx, path))) {
            return shouldBeIgnored(path) || !(await ctx.vault.isTargetFile(path, { skipCaseCollisionCheck: true }));
        }
        switch (type) {
            case "CREATE":
            case "CHANGED": {
                const current = getExactCurrentFile(ctx, await ctx.host.storage().getStub(path), path);
                // A later deletion or move can supersede a queued content
                // event before its body is acquired. Inspection errors still fail.
                if (!current || ctx.vault.isFileSizeTooLarge(current.stat.size)) return true;
                return await storeFileToDBFromRevision(ctx, current);
            }
            case "DELETE":
                try {
                    if (!(await canRecordStorageDeletion(ctx, item))) return true;
                } catch {
                    return false;
                }
                return await deleteFileFromDBIfPresent(ctx, item.args.file);
            case "RENAME":
                return await renameFileInDBCore(
                    ctx,
                    item.args.file as UXFileInfoStub,
                    item.args.oldPath as FilePathWithPrefix
                );
            case "INTERNAL":
                // this should be handled on the other module.
                return false;
            default:
                ctx.host.log(`Unsupported event type: ${type as string}`, LOG_LEVEL_VERBOSE);
                return false;
        }
    });
}

/**
 * Revalidate saved operation intent against current storage before applying any effect.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param item - The admitted operation intent and related paths.
 * @returns Whether the revalidated effect completed; incomplete validation or remaining effects retain a false result.
 * @remarks Operation intent is revalidated under related document locks. Policy skips, retained failures, and conservative conflict handling retain their original meanings.
 */
async function processRestoredFileEvent(ctx: FileHandlerContext, item: FileEventItem): Promise<boolean> {
    const eventItem = item.args;
    const type = item.type;
    const path = eventItem.file.path;
    if (type === "RENAME" && !eventItem.oldPath) {
        ctx.host.log(`Rename event for ${path} has no source path`, LOG_LEVEL_VERBOSE);
        return true;
    }

    const relatedPath = type === "RENAME" ? eventItem.oldPath : type === "DELETE" ? eventItem.renameTarget : undefined;
    const eventPaths = relatedPath === undefined ? [path] : [path, relatedPath as FilePathWithPrefix];
    return await withFileEventPaths(ctx, eventPaths, async (isSameDocument) => {
        let action: RestoredFileEventAction;
        try {
            action = await planRestoredFileEvent(ctx, item, isSameDocument);
        } catch (ex) {
            logRestoredEventValidationFailure(ctx, path, ex);
            return false;
        }

        switch (action.kind) {
            case "none":
                return true;
            case "unresolved":
                return false;
            case "store": {
                const stored = await storeFileToDBFromRevision(ctx, action.file, false, false, undefined, true);
                return stored && action.complete !== false;
            }
            case "delete":
                return await deleteFileFromDBIfPresent(ctx, action.path);
            case "rename":
                return await renameFileInDBCore(ctx, action.file, action.oldPath, true);
        }
    });
}

/**
 * Select the remaining effect of a saved operation without replaying old file bytes.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param item - The admitted operation intent and related paths.
 * @param isSameDocument - Whether source and target identify the same metadata document.
 * @returns The guarded remaining action, including an unresolved result when inspection was incomplete.
 * @remarks Operation intent is revalidated under related document locks. Policy skips, retained failures, and conservative conflict handling retain their original meanings.
 */
async function planRestoredFileEvent(
    ctx: FileHandlerContext,
    item: FileEventItem,
    isSameDocument: boolean
): Promise<RestoredFileEventAction> {
    const path = item.args.file.path;
    switch (item.type) {
        case "CREATE":
        case "CHANGED": {
            const current = getExactCurrentFile(ctx, await ctx.host.storage().getStub(path), path);
            return current && (await isCurrentFileSelected(ctx, current))
                ? { kind: "store", file: current }
                : { kind: "none" };
        }
        case "DELETE": {
            if (item.args.renameTarget !== undefined) {
                return (await canRecordStorageDeletion(ctx, item)) && (await canApplyRestoredDeletion(ctx, path))
                    ? { kind: "delete", path: path as FilePath }
                    : { kind: "none" };
            }
            const current = await ctx.host.storage().getStub(path);
            return current === null && (await canApplyRestoredDeletion(ctx, path))
                ? { kind: "delete", path: path as FilePath }
                : { kind: "none" };
        }
        case "RENAME":
            return await planRestoredRename(ctx, path, item.args.oldPath as FilePathWithPrefix, isSameDocument);
        case "INTERNAL":
            return { kind: "none" };
        default:
            ctx.host.log(`Unsupported event type: ${item.type as string}`, LOG_LEVEL_VERBOSE);
            return { kind: "none" };
    }
}

/**
 * Plan a guarded rename continuation using current source and target observations.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param newPath - The current rename destination.
 * @param oldPath - The rename source path whose branch must be preserved or deleted safely.
 * @param isSameDocument - Whether source and target identify the same metadata document.
 * @returns The safe remaining rename action; existing unrelated targets remain protected.
 * @remarks Operation intent is revalidated under related document locks. Policy skips, retained failures, and conservative conflict handling retain their original meanings.
 */
async function planRestoredRename(
    ctx: FileHandlerContext,
    newPath: FilePathWithPrefix,
    oldPath: FilePathWithPrefix,
    isSameDocument: boolean
): Promise<RestoredFileEventAction> {
    if (isSameDocument) return await planSameDocumentRename(ctx, newPath, oldPath);
    return await planCrossDocumentRename(ctx, newPath, oldPath);
}

/**
 * Select and reflect a replicated document while retaining host override dispatch.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param entry - The database metadata being processed.
 * @returns Whether replication reflection completed; excluded or unsafe documents retain a false result.
 * @remarks Operation intent is revalidated under related document locks. Policy skips, retained failures, and conservative conflict handling retain their original meanings.
 */
export async function processReplicatedDocument(ctx: FileHandlerContext, entry: MetaEntry): Promise<boolean> {
    return await withFileEventPaths(ctx, [ctx.host.getPath(entry)], async () => {
        if (!(await ctx.vault.isTargetFile(entry.path))) {
            ctx.host.log(`File ${entry.path} is not the target file`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (ctx.vault.isFileSizeTooLarge(entry.size)) {
            ctx.host.log(`File ${entry.path} is too large (on database) to be processed`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (shouldBeIgnored(entry.path)) {
            ctx.host.log(`File ${entry.path} should be ignored`, LOG_LEVEL_VERBOSE);
            return false;
        }
        const path = ctx.host.getPath(entry);

        const targetFile = await ctx.host.storage().getStub(ctx.host.getPathWithoutPrefix(entry));
        if (isFolderInfo(targetFile)) {
            ctx.host.log(`${path} is already exist as the folder`);
            // Nothing to do and other modules should also nothing to do.
            return true;
        } else {
            if (targetFile && ctx.vault.isFileSizeTooLarge(targetFile.stat.size)) {
                ctx.host.log(`File ${targetFile.path} is too large (on storage) to be processed`, LOG_LEVEL_VERBOSE);
                return false;
            }
            ctx.host.log(
                `Processing ${path} (${entry._id.substring(0, 8)} :${entry._rev?.substring(0, 5)}) : Started...`,
                LOG_LEVEL_VERBOSE
            );
            // Before writing (or skipped ), merging dialogue should be cancelled.
            ctx.events.emitEvent(EVENT_CONFLICT_CANCELLED, path);
            const ret = await dbToStorageCore(ctx, entry, targetFile);
            ctx.host.log(`Processing ${path} (${entry._id.substring(0, 8)} :${entry._rev?.substring(0, 5)}) : Done`);
            return ret;
        }
    });
}

/**
 * Reconcile a case-only or alias rename within the same document identity.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param newPath - The current rename destination.
 * @param oldPath - The original rename source.
 * @returns A current-target save, a remaining rename, or a selection skip.
 * @remarks The caller holds the shared document lock. The current target and stored path are inspected in the original order.
 */
async function planSameDocumentRename(
    ctx: FileHandlerContext,
    newPath: FilePathWithPrefix,
    oldPath: FilePathWithPrefix
): Promise<RestoredFileEventAction> {
    const currentTarget = getExactCurrentFile(ctx, await ctx.host.storage().getStub(newPath), newPath);
    if (!currentTarget || !(await isCurrentFileSelected(ctx, currentTarget))) {
        return { kind: "none" };
    }
    const entry = await ctx.host.db().fetchEntryMeta(newPath, undefined, true);
    if (
        entry &&
        !entry.deleted &&
        !entry._deleted &&
        ctx.host.storage().normalisePath(ctx.host.getPath(entry)) === ctx.host.storage().normalisePath(newPath)
    ) {
        return { kind: "store", file: currentTarget };
    }
    return { kind: "rename", file: currentTarget, oldPath };
}

/**
 * Reconcile distinct source and target documents without guessing whether a partial rename owns the target.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param newPath - The current rename destination.
 * @param oldPath - The original rename source.
 * @returns The remaining safe action, including unresolved source inspection or conservative source preservation.
 * @remarks The caller holds both document locks. Missing source data, unknown inspection, and confirmed deletion remain distinct.
 */
async function planCrossDocumentRename(
    ctx: FileHandlerContext,
    newPath: FilePathWithPrefix,
    oldPath: FilePathWithPrefix
): Promise<RestoredFileEventAction> {
    const currentTargetItem = await ctx.host.storage().getStub(newPath);
    let currentSourceItem: UXFileInfoStub | UXFolderInfo | null = null;
    let sourceWasInspected = true;
    try {
        currentSourceItem = await ctx.host.storage().getStub(oldPath);
    } catch (ex) {
        sourceWasInspected = false;
        logRestoredEventValidationFailure(ctx, oldPath, ex);
    }
    const currentTarget = getExactCurrentFile(ctx, currentTargetItem, newPath);
    if (currentTargetItem !== null) {
        if (!currentTarget || !(await isCurrentFileSelected(ctx, currentTarget))) {
            return { kind: "none" };
        }
        if (!sourceWasInspected || currentSourceItem !== null || !(await canApplyRestoredDeletion(ctx, oldPath))) {
            return { kind: "store", file: currentTarget, complete: sourceWasInspected };
        }
        const sourceEntry = await ctx.host.db().fetchEntryMeta(oldPath, undefined, true);
        if (!sourceEntry || sourceEntry.deleted || sourceEntry._deleted) {
            // The source deletion is already represented. Reconcile the
            // current target without forcing another rename revision.
            return { kind: "store", file: currentTarget };
        }
        return { kind: "rename", file: currentTarget, oldPath };
    }
    if (!sourceWasInspected) return { kind: "unresolved" };
    if (currentSourceItem !== null || !(await canApplyRestoredDeletion(ctx, oldPath))) {
        return { kind: "none" };
    }
    return { kind: "delete", path: oldPath as FilePath };
}
