import { withFileEventPaths, queueConflictCheckFor } from "./locking";
import { storeFileToDBFromRevision } from "./saving";
import { getProvenance, deleteProvenance } from "./provenance";

import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FilePath, FilePathWithPrefix, UXFileInfo, UXFileInfoStub } from "@lib/common/types";

import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";

import type { FileHandlerContext } from "./context";

/**
 * Record a rename under both source and destination document locks.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The destination file observation, optionally already containing its body.
 * @param oldPath - The rename source path whose branch must be preserved or deleted safely.
 * @returns True after target/source handling or conservative source preservation; false on target collision or refused work.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function renameFileInDB(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo,
    oldPath: FilePath | FilePathWithPrefix
): Promise<boolean> {
    const newPath = getStoragePathFromUXFileInfo(info);
    return await withFileEventPaths(ctx, [oldPath as FilePathWithPrefix, newPath], () =>
        renameFileInDBCore(ctx, info, oldPath)
    );
}

/**
 * Save a rename target before applying its guarded source deletion.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The destination file observation, optionally already containing its body.
 * @param oldPath - The rename source path whose branch must be preserved or deleted safely.
 * @param retryIfStorageChanges - Whether recovery revalidates storage and permits bounded rereads.
 * @returns True after target/source handling or conservative source preservation; false on target collision or refused work.
 * @remarks Core operations require source and destination document locks as applicable. Unknown conflict ancestry is preserved for review rather than guessed.
 */
export async function renameFileInDBCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo,
    oldPath: FilePath | FilePathWithPrefix,
    retryIfStorageChanges = false
): Promise<boolean> {
    const newPath = getStoragePathFromUXFileInfo(info);
    const [oldDocumentId, newDocumentId] = await Promise.all([ctx.path.path2id(oldPath), ctx.path.path2id(newPath)]);

    if (oldDocumentId === newDocumentId) {
        ctx.host.log(`Updating the stored path for case-only rename: ${oldPath} -> ${newPath}`, LOG_LEVEL_VERBOSE);
        return await storeFileToDBFromRevision(
            ctx,
            info,
            true,
            false,
            oldPath as FilePathWithPrefix,
            retryIfStorageChanges
        );
    }

    const oldEntry = await ctx.host.db().fetchEntryMeta(oldPath, undefined, true);
    const newEntry = await ctx.host.db().fetchEntryMeta(newPath, undefined, true);
    if (newEntry && !newEntry.deleted && !newEntry._deleted) {
        ctx.host.log(
            `Refusing to overwrite the existing database entry while renaming ${oldPath} to ${newPath}`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }
    if (!(await storeFileToDBFromRevision(ctx, info, true, false, undefined, retryIfStorageChanges))) {
        ctx.host.log(`Failed to store rename target; preserving source in the database: ${oldPath}`, LOG_LEVEL_NOTICE);
        return false;
    }
    if (!oldEntry || oldEntry.deleted || oldEntry._deleted) {
        ctx.host.log(`Rename source is not present in the database: ${oldPath}`, LOG_LEVEL_VERBOSE);
        return true;
    }

    return await deleteRenamedSource(ctx, info, oldPath, newPath);
}

/**
 * Remove the remaining rename source only after the destination save succeeded.
 * @param ctx - Captured services, state, and dynamic host seams.
 * @param info - The destination file whose content may identify a source conflict branch.
 * @param oldPath - The source path whose remaining database effect is being applied.
 * @param newPath - The destination path captured before the target save.
 * @returns Whether source deletion completed or unknown source branches were preserved for review.
 * @remarks The caller holds both document locks. Source provenance, content reconstruction,
 * deletion, and deferred conflict notification retain their established order.
 */
async function deleteRenamedSource(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo,
    oldPath: FilePath | FilePathWithPrefix,
    newPath: FilePathWithPrefix
): Promise<boolean> {
    const oldConflicts = await ctx.host.db().getConflictedRevs(oldPath);
    if (oldConflicts.length > 0) {
        let baseRevision = (await getProvenance(ctx, oldPath as FilePathWithPrefix))?.revision;
        if (!baseRevision) {
            const readFile = await ctx.host.readFileFromStub(info);
            const revisions = await ctx.host.db().findContentRevisions(oldPath as FilePathWithPrefix, readFile.body);
            baseRevision = revisions.length === 1 ? revisions[0] : undefined;
        }
        if (!baseRevision) {
            ctx.host.log(
                `Renamed ${oldPath} to ${newPath}, but preserved every conflicted source branch because the displayed source revision is unknown`,
                LOG_LEVEL_NOTICE
            );
            await queueConflictCheckFor(ctx, oldPath as FilePathWithPrefix);
            return true;
        }
        const storedRevision = await ctx.host
            .db()
            .storeDeletionWithBaseRevision(oldPath as FilePathWithPrefix, baseRevision);
        if (storedRevision === false) return false;
        await deleteProvenance(ctx, oldPath as FilePathWithPrefix);
        await queueConflictCheckFor(ctx, oldPath as FilePathWithPrefix);
        return true;
    }
    const deleted = await ctx.host.db().delete(oldPath as FilePathWithPrefix);
    if (deleted) await deleteProvenance(ctx, oldPath as FilePathWithPrefix);
    return deleted;
}
