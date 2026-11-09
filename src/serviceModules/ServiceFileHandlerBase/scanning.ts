import { withFileEventPaths } from "./locking";
import {
    getProvenancePath,
    sameProvenance,
    contentEvidence,
    currentStorageSnapshotMatches,
    hasContentHash,
} from "./provenance";
import { isFolderInfo } from "./storage";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";

import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FilePath, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";
import { isDocContentSame, readContent } from "@lib/common/utils";

import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";

import type { FileHandlerContext } from "./context";

/**
 * Offer a metadata-only scan hint without certifying bytes or changing provenance.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param expected - The database metadata expected by this scan.
 * @returns Whether the scan may skip this unchanged metadata observation.
 * @remarks The scan acquires the document lock before certifying evidence. It writes no document revision or storage content; inspection failures return false.
 */
export async function canSkipUnchangedFile(
    ctx: FileHandlerContext,
    info: UXFileInfoStub,
    expected: MetaEntry
): Promise<boolean> {
    const path = getStoragePathFromUXFileInfo(info);
    const provenance = ctx.provenance;
    if (
        !provenance ||
        !isUnconflictedScanEntry(expected) ||
        ctx.host.storage().hasPendingFileEvent?.(path as FilePath) !== false
    )
        return false;
    try {
        return await withFileEventPaths(ctx, [path], async () => {
            const provenancePath = getProvenancePath(ctx, path);
            const record = await provenance.get(provenancePath);
            if (!scanRecordMatchesFile(record, expected, info)) return false;
            const current = await ctx.host.db().fetchEntryMeta(path, undefined, true);
            if (!isExpectedLiveRevision(current, record.revision)) return false;
            if ((await ctx.host.db().getConflictedRevs(path)).length > 0) return false;
            const stat = await ctx.host.storage().stat(path);
            if (!storageStatMatchesRecord(stat, record)) return false;
            // This skips a scan, but does not create content evidence for a later write.
            return (
                sameProvenance(await provenance.get(provenancePath), record) &&
                ctx.host.storage().hasPendingFileEvent?.(path as FilePath) === false
            );
        });
    } catch (error) {
        ctx.host.log(`Could not inspect unchanged file metadata for ${path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(error, LOG_LEVEL_VERBOSE);
        return false;
    }
}

/**
 * Record an unchanged current revision after rechecking storage and database evidence.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param expectedRevision - The exact revision the scan expects to remain current.
 * @returns Whether the exact still-current revision was recorded without writing file content.
 * @remarks The scan acquires the document lock before certifying evidence. It writes no document revision or storage content; inspection failures return false.
 */
export async function tryRecordUntrackedFileRevision(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo,
    expectedRevision: string
): Promise<boolean> {
    if (!ctx.provenance || !expectedRevision) return false;
    const path = getStoragePathFromUXFileInfo(info);
    try {
        return await withFileEventPaths(ctx, [path], async () => {
            const provenance = ctx.provenance!;
            const provenancePath = getProvenancePath(ctx, path);
            // A recorded branch remains authoritative, even when its
            // current bytes happen to match the database winner.
            const existing = await provenance.get(provenancePath);
            const observed = existing ? { ...existing } : undefined;
            if (!canUpgradeScanRecord(observed, expectedRevision)) return false;
            const stub = await ctx.host.storage().getStub(path);
            if (!stub || isFolderInfo(stub) || stub.path !== path) return false;
            const file = await ctx.host.readFileFromStub(stub);
            const current = await ctx.host.db().fetchEntryMeta(path, undefined, true);
            if (!isExpectedLiveRevision(current, expectedRevision)) return false;
            if ((await ctx.host.db().getConflictedRevs(path)).length > 0) return false;
            const entry = await ctx.host.db().fetchEntry(path, expectedRevision, true, true, true);
            if (!isExpectedLiveRevision(entry, expectedRevision)) return false;
            if (!(await isDocContentSame(readContent(entry), file.body))) return false;

            const evidence = await contentEvidence(ctx, file.body);
            if (!evidence.contentHash) return false;
            const latest = await ctx.host.db().fetchEntryMeta(path, undefined, true);
            if (!isExpectedLiveRevision(latest, expectedRevision)) return false;
            if ((await ctx.host.db().getConflictedRevs(path)).length > 0) return false;
            if (!(await currentStorageSnapshotMatches(ctx, file, observed))) return false;
            if (!sameProvenance(await provenance.get(provenancePath), observed)) return false;
            await provenance.set(provenancePath, {
                revision: expectedRevision,
                observedStorageMtime: file.stat.mtime,
                ...evidence,
            });
            return true;
        });
    } catch (ex) {
        ctx.host.log(`Could not record unchanged file provenance for ${path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
        return false;
    }
}

/** Minimal metadata shared by current records and decoded revision bodies. */
type ScanRevisionMetadata = { _rev?: string; deleted?: boolean; _deleted?: boolean };

/**
 * Recognise a usable, non-conflicted metadata scan candidate.
 * @param expected - Metadata supplied by the scanner.
 * @returns Whether its revision and deletion/conflict fields permit further inspection.
 * @remarks This synchronous predicate preserves field short-circuit order and performs no I/O.
 */
function isUnconflictedScanEntry(expected: MetaEntry): boolean {
    return !!expected._rev && !expected.deleted && !expected._deleted && !expected._conflicts?.length;
}

/**
 * Compare device-local evidence with the scanner's original file observation.
 * @param record - Device-local provenance, when available.
 * @param expected - The expected database metadata.
 * @param info - The original storage statistics.
 * @returns Whether the record supplies matching supported evidence and timestamps.
 * @remarks This predicate does not certify current bytes or mutate provenance.
 */
function scanRecordMatchesFile(
    record: FileReflectionProvenanceRecord | undefined,
    expected: MetaEntry,
    info: UXFileInfoStub
): record is FileReflectionProvenanceRecord {
    return (
        !!record &&
        hasContentHash(record) &&
        record.revision === expected._rev &&
        Number.isFinite(record.observedStorageMtime) &&
        record.observedStorageMtime === info.stat.mtime &&
        record.contentSize === info.stat.size
    );
}

/**
 * Validate the expected live revision before any dependent conflict or body read.
 * @typeParam T - The supplied metadata or decoded-entry type retained after the check.
 * @param entry - The already fetched entry, or false when absent.
 * @param revision - The exact revision required by this scan.
 * @returns Whether the fetched entry names that live revision.
 * @remarks This predicate performs no I/O; callers retain the original conditional conflict queries.
 */
function isExpectedLiveRevision<T extends ScanRevisionMetadata>(
    entry: T | false,
    revision: string | undefined
): entry is T {
    return !!entry && entry._rev === revision && !entry.deleted && !entry._deleted;
}

/**
 * Compare a current file stat with previously recorded scan evidence.
 * @param stat - The storage stat already fetched by the caller.
 * @param record - Supported device-local evidence.
 * @returns Whether type, raw timestamp, and size still match.
 * @remarks Matching metadata remains a scan hint rather than proof of current content.
 */
function storageStatMatchesRecord(
    stat: Awaited<ReturnType<StorageAccess["stat"]>>,
    record: FileReflectionProvenanceRecord
): boolean {
    return (
        !!stat && stat.type === "file" && stat.mtime === record.observedStorageMtime && stat.size === record.contentSize
    );
}

/**
 * Allow only absent provenance or a matching legacy record to acquire new evidence.
 * @param observed - The raw record captured before scanning storage.
 * @param revision - The current revision expected by the scan.
 * @returns Whether the scan may continue towards an evidence-only upgrade.
 * @remarks A different recorded branch or existing content hash remains authoritative.
 */
function canUpgradeScanRecord(observed: FileReflectionProvenanceRecord | undefined, revision: string): boolean {
    return !observed || (observed.revision === revision && !hasContentHash(observed));
}
