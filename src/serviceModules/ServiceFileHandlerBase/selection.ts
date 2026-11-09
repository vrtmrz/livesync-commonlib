import { isFolderInfo } from "./storage";

import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FileEventItem, FilePathWithPrefix, UXFileInfoStub, UXFolderInfo } from "@lib/common/types";

import { shouldBeIgnored } from "@lib/string_and_binary/path";

import type { FileHandlerContext } from "./context";

/**
 * Validate current absence or an excluded rename target before recording deletion.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param item - The admitted operation intent and related paths.
 * @returns Whether current storage permits the deletion intent; inspection errors propagate after diagnostics.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export async function canRecordStorageDeletion(ctx: FileHandlerContext, item: FileEventItem): Promise<boolean> {
    const path = item.args.file.path;
    try {
        const current = await ctx.host.storage().getStub(path);
        let excludedRenameTarget: UXFileInfoStub | null = null;
        if (item.args.renameTarget !== undefined) {
            const targetPath = item.args.renameTarget as FilePathWithPrefix;
            const targetItem = await ctx.host.storage().getStub(targetPath);
            const target = getExactCurrentFile(ctx, targetItem, targetPath);
            if (targetItem !== null && !target) {
                ctx.host.log(
                    `Preserved ${path}: the rename target no longer resolves to ${targetPath}`,
                    LOG_LEVEL_NOTICE
                );
                return false;
            }
            // A collision can temporarily reject a destination. Only selection
            // policy or a current size limit establishes a move out of scope.
            const targetIsSelected =
                !shouldBeIgnored(targetPath) &&
                (await ctx.vault.isTargetFile(targetPath, { skipCaseCollisionCheck: true })) &&
                !(target && ctx.vault.isFileSizeTooLarge(target.stat.size));
            if (targetIsSelected) {
                ctx.host.log(`Preserved ${path}: rename target ${targetPath} is still selected`, LOG_LEVEL_NOTICE);
                return false;
            }
            excludedRenameTarget = target;
        }
        if (current === null) return true;
        if (isFolderInfo(current)) {
            ctx.host.log(`Preserved ${path}: a current storage item contradicts its deletion event`, LOG_LEVEL_NOTICE);
            return false;
        }

        const [currentId, deletedId] = await Promise.all([ctx.path.path2id(current.path), ctx.path.path2id(path)]);
        if (currentId !== deletedId) return true;
        // A deliberate case-only move out of selection removes the DB
        // entry, even though its excluded destination shares that ID.
        if (
            excludedRenameTarget &&
            ctx.host.storage().normalisePath(current.path) !== ctx.host.storage().normalisePath(path) &&
            ctx.host.storage().normalisePath(current.path) ===
                ctx.host.storage().normalisePath(excludedRenameTarget.path)
        ) {
            return true;
        }

        ctx.host.log(`Preserved ${path}: a current storage item contradicts its deletion event`, LOG_LEVEL_NOTICE);
        return false;
    } catch (ex) {
        ctx.host.log(`Could not validate deletion of ${path}; preserved the database entry`, LOG_LEVEL_NOTICE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
        throw ex;
    }
}

/**
 * Accept only a non-folder storage item resolving to the expected path.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param current - The nullable current storage observation.
 * @param expectedPath - The path the current observation must resolve to.
 * @returns The matching file, or null for folders, aliases, or missing paths.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export function getExactCurrentFile(
    ctx: FileHandlerContext,
    current: UXFileInfoStub | UXFolderInfo | null,
    expectedPath: FilePathWithPrefix
): UXFileInfoStub | null {
    if (current === null || isFolderInfo(current)) {
        return null;
    }
    return ctx.host.storage().normalisePath(current.path) === ctx.host.storage().normalisePath(expectedPath)
        ? current
        : null;
}

/**
 * Check current path selection and the configured size limit.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @returns Whether the current file satisfies path selection and the existing size limit.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export async function isCurrentFileSelected(ctx: FileHandlerContext, file: UXFileInfoStub): Promise<boolean> {
    if (!(await isCurrentPathSelected(ctx, file.path))) {
        return false;
    }
    if (ctx.vault.isFileSizeTooLarge(file.stat.size)) {
        ctx.host.log(`File ${file.path} exceeds the current maximum size`, LOG_LEVEL_VERBOSE);
        return false;
    }
    return true;
}

/**
 * Apply current host selection and built-in ignore policy in their established order.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @returns Whether the current host selection and built-in ignore policy both admit the path.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export async function isCurrentPathSelected(ctx: FileHandlerContext, path: FilePathWithPrefix): Promise<boolean> {
    if (!(await ctx.vault.isTargetFile(path))) {
        ctx.host.log(`File ${path} is not the target file`, LOG_LEVEL_VERBOSE);
        return false;
    }
    if (shouldBeIgnored(path)) {
        ctx.host.log(`File ${path} should be ignored`, LOG_LEVEL_VERBOSE);
        return false;
    }
    return true;
}

/**
 * Check recovery deletion selection while retaining validation diagnostics.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @returns Whether the current path remains selected; inspection errors propagate after diagnostics.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export async function canApplyRestoredDeletion(ctx: FileHandlerContext, path: FilePathWithPrefix): Promise<boolean> {
    try {
        return await isCurrentPathSelected(ctx, path);
    } catch (ex) {
        logRestoredEventValidationFailure(ctx, path, ex);
        throw ex;
    }
}

/**
 * Report why saved operation intent remains pending for a later reconciliation.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param ex - The validation error retained in diagnostics.
 * @returns Completion without a value; underlying errors retain the existing propagation policy.
 * @remarks Selection reads current storage and settings without acquiring another document lock. Inspection failures remain distinguishable from confirmed absence.
 */
export function logRestoredEventValidationFailure(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    ex: unknown
): void {
    ctx.host.log(
        `Could not validate the saved storage operation for ${path} against current storage; the operation remains pending for recovery`,
        LOG_LEVEL_NOTICE
    );
    ctx.host.log(ex, LOG_LEVEL_VERBOSE);
}
