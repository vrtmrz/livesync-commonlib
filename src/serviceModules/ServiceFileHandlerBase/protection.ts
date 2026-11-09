import {
    readProvenanceSnapshot,
    currentStorageSnapshotMatches,
    classifyStorageContent,
    rememberMatchingLeaf,
    finaliseStoredRevision,
} from "./provenance";
import { queueConflictCheckFor } from "./locking";
import { isFolderInfo } from "./storage";

import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";

import type { FilePathWithPrefix, MetaEntry, UXFileInfoStub } from "@lib/common/types";
import { isDocContentSame } from "@lib/common/utils";

import type { FileHandlerContext, PreservationResult } from "./context";

/**
 * Preserve changed storage before an incoming write can replace its bytes.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param existDoc - The storage file observed before overwrite protection.
 * @param incomingEntry - The database metadata about to be reflected.
 * @param incomingContent - Already decoded incoming bytes, when available.
 * @returns A PreservationResult: preserved:true stops the incoming effect; preserved:false without a snapshot means no safe candidate was established.
 * @remarks The caller holds the document lock. preserved:true also covers a refused preservation write that must still stop overwrite; any returned snapshot requires later revalidation.
 */
export async function preserveUnsyncedStorageAsConflict(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    existDoc: UXFileInfoStub,
    incomingEntry: MetaEntry,
    incomingContent?: string | string[] | Blob | ArrayBuffer
): Promise<PreservationResult> {
    // Capture bytes and branch identity before classifying against database
    // revisions. A later storage change requires a fresh snapshot.
    const observedProvenance = await readProvenanceSnapshot(ctx, path);
    const readFile = await ctx.host.readFileFromStub(existDoc);
    const snapshot = { file: readFile, revision: observedProvenance };
    if (incomingContent && (await isDocContentSame(incomingContent, readFile.body))) {
        return (await currentStorageSnapshotMatches(ctx, readFile, observedProvenance))
            ? { preserved: false, snapshot }
            : { preserved: false };
    }
    if (!incomingEntry._rev) {
        return { preserved: false };
    }
    const classification = await classifyStorageContent(
        ctx,
        readFile,
        incomingEntry,
        undefined,
        observedProvenance,
        incomingContent ? { _rev: incomingEntry._rev, data: incomingContent } : undefined
    );
    // Classification can await chunk reads or leaf discovery. Revalidate
    // before creating a branch so an edit during that wait is not lost.
    if (!(await currentStorageSnapshotMatches(ctx, readFile, observedProvenance))) {
        return { preserved: false };
    }
    if (classification.kind === "unchanged") {
        return { preserved: false, snapshot };
    }
    if (classification.kind === "matching-leaf") {
        await rememberMatchingLeaf(ctx, path, classification.revision, readFile.stat.mtime, readFile.body);
        await queueConflictCheckFor(ctx, path);
        return { preserved: true };
    }
    const storedRevision =
        classification.kind === "edited"
            ? await ctx.host.db().storeWithBaseRevision(readFile, classification.revision, true)
            : await ctx.host.db().storeIndependentRevision(readFile, true);
    if (storedRevision === false) {
        ctx.host.log(`Prevented overwriting unsynchronised local changes for ${path}`, LOG_LEVEL_NOTICE);
        return { preserved: true };
    }
    // Publish the new provenance only after the same storage snapshot has
    // survived the database write; otherwise the caller must reread it.
    if (!(await finaliseStoredRevision(ctx, readFile, observedProvenance, storedRevision))) {
        return { preserved: false };
    }
    ctx.host.log(`Preserved unsynchronised local changes as a conflict for ${path}`, LOG_LEVEL_NOTICE);
    await queueConflictCheckFor(ctx, path);
    return { preserved: true };
}

/**
 * Repeat overwrite protection after a previous storage observation became stale.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param incomingEntry - The database metadata about to be reflected.
 * @param incomingContent - Already decoded incoming bytes, when available.
 * @param allowExistingConflicts - Whether the caller explicitly selected an existing live conflict leaf.
 * @returns A PreservationResult that either stops the incoming effect or supplies a candidate; missing evidence can leave preserved:false without a snapshot.
 * @remarks The caller holds the document lock. This does not authorise overwrite; callers must validate any candidate at the established final check.
 */
export async function recheckIncomingStorage(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    incomingEntry: MetaEntry,
    incomingContent: string | string[] | Blob | ArrayBuffer | undefined,
    allowExistingConflicts: boolean
): Promise<PreservationResult> {
    const current = await ctx.host.storage().getStub(path);
    if (!current || isFolderInfo(current)) return { preserved: false };
    const protection = await preserveUnsyncedStorageAsConflict(ctx, path, current, incomingEntry, incomingContent);
    if (protection.preserved || !protection.snapshot) return protection;
    if (
        !allowExistingConflicts &&
        !ctx.setting.currentSettings().writeDocumentsIfConflicted &&
        (await ctx.host.db().getConflictedRevs(path)).length > 0
    ) {
        await queueConflictCheckFor(ctx, path, true);
        return { preserved: true };
    }
    return protection;
}
