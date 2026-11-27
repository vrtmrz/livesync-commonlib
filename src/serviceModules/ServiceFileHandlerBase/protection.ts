import { ContentReadError } from "@lib/common/LSError.ts";
import type { StorageContentClassification } from "./provenance";
import {
    getProvenancePath,
    readProvenanceSnapshot,
    currentStorageSnapshotMatches,
    classifyStorageContent,
    findMatchingFilenameLeaf,
    rememberMatchingLeaf,
    finaliseStoredRevision,
} from "./provenance";
import { queueConflictCheckFor } from "./locking";
import { isFolderInfo } from "./storage";

import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";

import type { FilePathWithPrefix, MetaEntry, UXFileInfoStub } from "@lib/common/types";
import { isDocContentSame } from "@lib/common/utils";

import type { FileHandlerContext, PreservationResult, StorageSnapshot } from "./context";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";

/** Decoded incoming file body supplied for live-write protection (absent for deletions). */
type IncomingContent = string | string[] | Blob | ArrayBuffer;

/**
 * Narrow decoded incoming content so an empty body (`""`) is treated as present,
 * distinguishing live writes from incoming deletions (`undefined`).
 */
function hasIncomingContent(content: IncomingContent | undefined): content is IncomingContent {
    return content !== undefined;
}

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
    incomingContent?: IncomingContent
): Promise<PreservationResult> {
    // Capture bytes and branch identity before classifying against database
    // revisions. A later storage change requires a fresh snapshot.
    const observedPath = existDoc.path;
    const observedProvenance = await readProvenanceSnapshot(ctx, observedPath);
    const readFile = await ctx.host.readFileFromStub(existDoc);
    if (readFile.path !== observedPath) {
        return { preserved: false };
    }
    const snapshot = { file: readFile, revision: observedProvenance };
    if (hasIncomingContent(incomingContent) && (await isDocContentSame(incomingContent, readFile.body))) {
        return (await currentStorageSnapshotMatches(ctx, readFile, observedProvenance))
            ? { preserved: false, snapshot }
            : { preserved: false };
    }
    if (!incomingEntry._rev) {
        return { preserved: false };
    }
    let classification: StorageContentClassification;
    let unavailableRead: ContentReadError | undefined;
    try {
        classification = await classifyStorageContent(
            ctx,
            readFile,
            incomingEntry,
            undefined,
            observedProvenance,
            hasIncomingContent(incomingContent) ? { _rev: incomingEntry._rev, data: incomingContent } : undefined,
            false
        );
    } catch (error) {
        if (!(error instanceof ContentReadError)) {
            throw error;
        }
        // Independent preservation remains safe without ancestry or a readable leaf.
        unavailableRead = error;
        classification = { kind: "unknown" };
    }
    const result = await preserveStorageSnapshot(ctx, path, snapshot, classification, unavailableRead);
    return result || { preserved: true };
}

/** Preserve the actual name of an untracked file before applying a differently cased database path. */
export async function preserveUntrackedFilename(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    observed: UXFileInfoStub,
    hasConflicts: boolean,
    observedProvenance?: FileReflectionProvenanceRecord
): Promise<boolean> {
    const file = await ctx.host.readFileFromStub(observed);
    if (file.path !== observed.path) return false;
    // An explicitly selected revision can be retried while other leaves are still live.
    const classification = hasConflicts
        ? await findMatchingFilenameLeaf(ctx, file, path, { requireStoredPath: true })
        : { kind: "unknown" } as const;
    const result = await preserveStorageSnapshot(ctx, path, { file, revision: observedProvenance }, classification);
    return result !== false && result.preserved;
}

/** Commit the file captured at its observed spelling after rechecking the bytes and provenance. */
async function preserveStorageSnapshot(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    snapshot: StorageSnapshot,
    classification: StorageContentClassification,
    unavailableRead?: ContentReadError
): Promise<PreservationResult | false> {
    const { file: readFile, revision: observedProvenance } = snapshot;
    // Classification can await chunk reads or leaf discovery. Revalidate
    // before creating a branch so an edit during that wait is not lost.
    if (!(await currentStorageSnapshotMatches(ctx, readFile, observedProvenance))) {
        return { preserved: false };
    }
    if (classification.kind === "unchanged") {
        return { preserved: false, snapshot };
    }
    if (classification.kind === "matching-leaf") {
        await rememberMatchingLeaf(ctx, readFile.path, classification.revision, readFile.stat.mtime, readFile.body);
        await queueConflictCheckFor(ctx, path);
        return { preserved: true };
    }
    const storedRevision =
        classification.kind === "edited"
            ? await ctx.host.db().storeWithBaseRevision(readFile, classification.revision, true)
            : await ctx.host.db().storeIndependentRevision(readFile, true);
    if (storedRevision === false) {
        if (unavailableRead) {
            throw unavailableRead;
        }
        ctx.host.log(`Prevented overwriting unsynchronised local changes for ${path}`, LOG_LEVEL_NOTICE);
        return false;
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
    incomingContent: IncomingContent | undefined,
    allowExistingConflicts: boolean
): Promise<PreservationResult> {
    // Re-read the current storage observation for `path`; abort if absent or replaced by a folder.
    const current = await ctx.host.storage().getStub(path);
    if (!current || isFolderInfo(current)) return { preserved: false };
    if (current.path !== path) {
        // Case-insensitive or Unicode-normalised lookups can return another spelling.
        // Refuse to inspect or protect a file belonging to a distinct document ID.
        const [currentDocumentId, targetDocumentId] = await Promise.all([
            ctx.path.path2id(current.path),
            ctx.path.path2id(path),
        ]);
        if (currentDocumentId !== targetDocumentId) {
            return { preserved: false };
        }
        // For live writes, commit and final validation address provenance under `path`.
        // If storage reverted to another provenance key (for example, a different filename case),
        // defer so reflection restarts through spelling reconciliation instead of splitting keys.
        // Deletions omit `incomingContent` and legitimately target the observed spelling directly.
        if (hasIncomingContent(incomingContent) && getProvenancePath(ctx, current.path) !== getProvenancePath(ctx, path)) {
            return { preserved: false };
        }
    }
    // Re-run overwrite/deletion protection on the fresh observation before checking for new conflicts.
    const protection = await preserveUnsyncedStorageAsConflict(ctx, path, current, incomingEntry, incomingContent);
    if (protection.preserved || !protection.snapshot) return protection;
    // Stop reflection if conflict leaves appeared while storage was being rechecked, unless policy permits writing through them.
    if (
        !allowExistingConflicts &&
        !ctx.setting.currentSettings().writeDocumentsIfConflicted &&
        (await ctx.host.db().readConflictedRevs(path)).length > 0
    ) {
        await queueConflictCheckFor(ctx, path, true);
        return { preserved: true };
    }
    return protection;
}
