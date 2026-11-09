import { withFileEventPaths, queueConflictCheckFor } from "./locking";
import { infoToStub } from "./storage";
import { deleteProvenance, getProvenance, findUniqueContentRevision } from "./provenance";
import { applyDatabaseEntryToStorage } from "./reflection";

import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FilePath, FilePathWithPrefix, UXFileInfoStub, UXInternalFileInfoStub } from "@lib/common/types";

import { getStoragePathFromUXFileInfo, getDatabasePathFromUXFileInfo } from "@lib/common/typeUtils";

import { tryGetFilePath } from "@lib/common/utils.doc";

import type { FileHandlerContext } from "./context";

/**
 * Record a storage deletion under the corresponding document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @returns True after deletion or conservative conflict preservation; false for absent/deleted records or a refused write.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function deleteFileFromDB(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXInternalFileInfoStub | FilePath
): Promise<boolean> {
    return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], () => deleteFileFromDBCore(ctx, info));
}

/**
 * Accept an already represented deletion before applying any remaining database effect.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @returns True if deletion is already represented or the remaining effect is accepted; false on refusal.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function deleteFileFromDBIfPresent(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXInternalFileInfoStub | FilePath
): Promise<boolean> {
    // Database lookups accept ordinary observations or namespaced paths, not statless internal stubs.
    const target = typeof info !== "string" && info.isInternal ? getDatabasePathFromUXFileInfo(info) : info;
    const entry = await ctx.host.db().fetchEntryMeta(target, undefined, true);
    if (!entry || entry.deleted || entry._deleted) return true;
    return await deleteFileFromDBCore(ctx, info);
}

/**
 * Delete only the proven displayed branch, preserving unknown conflicted branches.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @returns True after deletion or conservative conflict preservation; false for absent/deleted records or a refused write.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
async function deleteFileFromDBCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXInternalFileInfoStub | FilePath
): Promise<boolean> {
    const file = await infoToStub(ctx, info);
    const path = (typeof info === "string" ? info : tryGetFilePath(info)) as FilePathWithPrefix | undefined;
    if (file == null) return await deleteMissingStorageFile(ctx, info, path);
    if (file.isInternal) {
        ctx.host.log(
            `Internal file ${file.path} is not allowed to be processed on processFileEvent`,
            LOG_LEVEL_VERBOSE
        );
        return false;
    }
    const entry = await ctx.host.db().fetchEntry(file, undefined, true, true);
    if (!entry || entry.deleted || entry._deleted) {
        ctx.host.log(`File ${file.path} is not exist or already deleted on the database`, LOG_LEVEL_VERBOSE);
        return false;
    }
    const conflictedRevs = await ctx.host.db().getConflictedRevs(file);
    if (conflictedRevs.length === 0) {
        const deleted = await ctx.host.db().delete(file);
        if (deleted) await deleteProvenance(ctx, file.path);
        return deleted;
    }
    let baseRevision = (await getProvenance(ctx, file.path))?.revision;
    if (!baseRevision) {
        try {
            const readFile = await ctx.host.readFileFromStub(file);
            baseRevision = await findUniqueContentRevision(ctx, readFile);
        } catch {
            // A deletion event can arrive after storage has removed the
            // file, so content reconstruction is only opportunistic.
        }
    }
    if (!baseRevision) {
        ctx.host.log(
            `The deleted storage file ${file.path} has conflicts, but its displayed revision is unknown; preserving every database branch`,
            LOG_LEVEL_NOTICE
        );
        await queueConflictCheckFor(ctx, file.path);
        return true;
    }
    const storedRevision = await ctx.host.db().storeDeletionWithBaseRevision(file.path, baseRevision);
    if (storedRevision === false) return false;
    await deleteProvenance(ctx, file.path);
    await queueConflictCheckFor(ctx, file.path);
    return true;
}

/**
 * Delete a selected revision under its document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @returns The database deletion result; matching provenance is cleared only after success.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function deleteRevisionFromDB(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | FilePath | FilePathWithPrefix,
    rev: string
): Promise<boolean | undefined> {
    return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], () =>
        deleteRevisionFromDBCore(ctx, info, rev)
    );
}

/**
 * Delete one selected revision and clear only its matching provenance.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @returns The database deletion result; matching device-local provenance clearing is attempted best-effort only after deletion succeeds.
 * @remarks The caller holds the document lock. A true database result does not certify persistence of the optional provenance clear.
 */
async function deleteRevisionFromDBCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | FilePath | FilePathWithPrefix,
    rev: string
): Promise<boolean | undefined> {
    const path = getStoragePathFromUXFileInfo(info);
    const provenance = await getProvenance(ctx, path);
    const deleted = await ctx.host.db().delete(info, rev);
    if (deleted && provenance?.revision === rev) {
        await deleteProvenance(ctx, path);
    }
    return deleted;
}

/**
 * Run the legacy delete-and-reflect resolution under one document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @returns False on refusal; the existing undefined result on successful legacy completion.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function resolveConflictedByDeletingRevision(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | FilePath,
    rev: string
): Promise<boolean | undefined> {
    return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], () =>
        resolveConflictedByDeletingRevisionCore(ctx, info, rev)
    );
}

/**
 * Retain captured metadata while applying the legacy resolution sequence.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @returns False on refusal; undefined after successful legacy completion.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
async function resolveConflictedByDeletingRevisionCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | FilePath,
    rev: string
): Promise<boolean | undefined> {
    const path = getStoragePathFromUXFileInfo(info);
    const file = await infoToStub(ctx, info);
    const docEntry = await ctx.host.db().fetchEntryMeta(file ?? info, rev, true);
    if (!docEntry) {
        ctx.host.log(`Failed to read the conflicted revision ${rev} of ${path}`, LOG_LEVEL_VERBOSE);
        return false;
    }
    if (!(await deleteRevisionFromDBCore(ctx, info, rev))) {
        ctx.host.log(`Failed to delete the conflicted revision ${rev} of ${path}`, LOG_LEVEL_VERBOSE);
        return false;
    }
    // This legacy operation deliberately applies the branch which it has
    // just removed. The public exact-revision operation accepts only live
    // branches, so it cannot be used after the deletion. Preserve the old
    // ordering by applying the metadata captured before deletion, then
    // discard any provenance for the now non-live revision.
    if (!(await applyDatabaseEntryToStorage(ctx, docEntry, file, true))) {
        ctx.host.log(`Failed to apply the resolved revision ${rev} of ${path} to the storage`, LOG_LEVEL_VERBOSE);
        return false;
    }
    await deleteProvenance(ctx, path);
}

/**
 * Record a path-based deletion when the storage file has already disappeared.
 * @param ctx - Captured services, state, and dynamic host seams.
 * @param info - The original deletion observation or path used for diagnostics.
 * @param path - The resolved source path, when the observation provides one.
 * @returns Whether deletion completed or unknown conflicted branches were preserved.
 * @remarks The caller holds the source document lock. Confirmed database absence
 * retains the original refusal result; unknown conflict ancestry is never guessed.
 */
async function deleteMissingStorageFile(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXInternalFileInfoStub | FilePath,
    path: FilePathWithPrefix | undefined
): Promise<boolean> {
    // infoToStub -> getFileStub stats the storage, but in the offline-scanner
    // `delete-db` path the file is by definition already gone from storage, so the
    // stub is always null and the delete silently no-ops (returns false). No
    // tombstone ever reaches the database and the next scan resurrects the file.
    // Fall back to a path-based database delete, the same approach the CLI `rm`
    // command uses (databaseFileAccess.delete accepts a bare path).
    if (path === undefined) {
        ctx.host.log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
        return false;
    }
    const entryByPath = await ctx.host.db().fetchEntry(path as FilePathWithPrefix, undefined, true, true);
    if (!entryByPath || entryByPath.deleted || entryByPath._deleted) {
        ctx.host.log(
            `File ${path} is not exist on the storage nor the database (or already deleted)`,
            LOG_LEVEL_VERBOSE
        );
        return false;
    }
    const conflictedRevs = await ctx.host.db().getConflictedRevs(path);
    if (conflictedRevs.length > 0) {
        const provenance = await getProvenance(ctx, path);
        if (!provenance) {
            ctx.host.log(
                `The deleted storage file ${path} has conflicts, but its displayed revision is unknown; preserving every database branch`,
                LOG_LEVEL_NOTICE
            );
            await queueConflictCheckFor(ctx, path);
            return true;
        }
        const storedRevision = await ctx.host.db().storeDeletionWithBaseRevision(path, provenance.revision);
        if (storedRevision === false) return false;
        await deleteProvenance(ctx, path);
        await queueConflictCheckFor(ctx, path);
        return true;
    }
    ctx.host.log(`File ${path} is missing on storage; deleting from the database by path`, LOG_LEVEL_INFO);
    const deleted = await ctx.host.db().delete(path);
    if (deleted) await deleteProvenance(ctx, path);
    return deleted;
}
