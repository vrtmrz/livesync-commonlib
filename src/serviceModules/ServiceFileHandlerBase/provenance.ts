import { isFolderInfo } from "./storage";

import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FilePathWithPrefix, UXFileInfo } from "@lib/common/types";
import { isDocContentSame, readContent } from "@lib/common/utils";

import { computeFileContentHash } from "@lib/common/fileContentHash";

import { getPathNormalizationVersion, normalisePathForIdentity } from "@lib/common/pathNormalization";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import type { FileHandlerContext } from "./context";

/**
 * Resolve the device-local provenance key using the current path identity policy.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @returns The normalised device-local provenance key.
 * @remarks Reads the current path-normalisation setting without accessing or changing the provenance store.
 */
export function getProvenancePath(ctx: FileHandlerContext, path: FilePathWithPrefix): FilePathWithPrefix {
    return normalisePathForIdentity(
        path,
        getPathNormalizationVersion(ctx.setting.currentSettings())
    ) as FilePathWithPrefix;
}

/**
 * Read usable revision provenance and conservatively discard only unsupported stale records.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @returns The usable record, or undefined when ancestry cannot be established.
 * @remarks May remove a legacy record when its referenced revision is absent or deleted. Inspection errors are logged and yield unknown provenance; host readiness is not retried here.
 */
export async function getProvenance(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix
): Promise<FileReflectionProvenanceRecord | undefined> {
    if (!ctx.provenance) return undefined;
    try {
        const record = await ctx.provenance.get(getProvenancePath(ctx, path));
        if (!record) return undefined;
        const entry = await ctx.host.db().fetchEntryMeta(path, record.revision, true);
        if (entry && !entry._deleted && !entry.deleted) {
            return record;
        }
        if (!hasContentHash(record)) await ctx.provenance.delete(getProvenancePath(ctx, path));
    } catch (ex) {
        // Store readiness is owned by the host lifecycle. Do not wait or
        // retry here: that can hang failed initialisation or become
        // self-referential during reset. Treat an unavailable record as
        // unknown provenance so the operation takes the conservative
        // preserve-for-review path instead of guessing a winner.
        ctx.host.log(`Could not read file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
    }
    return undefined;
}

/**
 * Hash immutable storage bytes with the per-instance cache when provenance is available.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param content - The immutable bytes for this provenance observation.
 * @returns Supported hash and size evidence, or an empty object when evidence is unavailable.
 * @remarks Only the per-instance Blob hash cache changes. A hashing failure evicts its cached promise, logs the error, and returns empty evidence without updating a provenance record.
 */
export async function contentEvidence(
    ctx: FileHandlerContext,
    content: Blob
): Promise<Pick<FileReflectionProvenanceRecord, "contentHash" | "contentSize">> {
    if (!ctx.provenance) return {};
    try {
        let hash = ctx.state.contentHashes.get(content);
        if (!hash) {
            hash = computeFileContentHash(content);
            ctx.state.contentHashes.set(content, hash);
        }
        return { contentHash: await hash, contentSize: content.size };
    } catch (ex) {
        ctx.state.contentHashes.delete(content);
        ctx.host.log("Could not hash file reflection content", LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
        return {};
    }
}

/**
 * Record a saved or reflected revision and its content evidence on this device.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param revision - The observed provenance or selected revision.
 * @param observedStorageMtime - The raw storage timestamp associated with the saved bytes.
 * @param content - The immutable bytes for this provenance observation.
 * @param evidence - Already computed content evidence, when available.
 * @returns Completion after the optional write attempt; provenance-store write errors are logged and suppressed.
 * @remarks No document lock is acquired here. Revision persistence and this optional device-local write are separate; a return does not guarantee durable provenance.
 */
export async function setProvenance(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    revision: string | undefined,
    observedStorageMtime: number | undefined,
    content: Blob,
    evidence?: Pick<FileReflectionProvenanceRecord, "contentHash" | "contentSize">
): Promise<void> {
    if (!ctx.provenance || !revision) return;
    try {
        await ctx.provenance.set(getProvenancePath(ctx, path), {
            revision,
            observedStorageMtime,
            ...(evidence ?? (await contentEvidence(ctx, content))),
        });
    } catch (ex) {
        ctx.host.log(`Could not record file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
    }
}

/**
 * Remove a device-local record without hiding a successful database or storage effect.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @returns Completion after the optional clear attempt; provenance-store deletion errors are logged and suppressed.
 * @remarks No document lock is acquired here. The caller's database or storage effect is not rolled back if device-local cleanup fails.
 */
export async function deleteProvenance(ctx: FileHandlerContext, path: FilePathWithPrefix): Promise<void> {
    if (!ctx.provenance) return;
    try {
        await ctx.provenance.delete(getProvenancePath(ctx, path));
    } catch (ex) {
        ctx.host.log(`Could not delete file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
    }
}

/**
 * Find one unambiguous database revision containing the observed storage bytes.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @returns The unique matching revision, or undefined after ambiguity or an inspection failure.
 * @remarks Inspects database history without recording provenance. Lookup failures are logged and treated as unknown origin.
 */
export async function findUniqueContentRevision(
    ctx: FileHandlerContext,
    file: UXFileInfo
): Promise<string | undefined> {
    try {
        const revisions = await ctx.host.db().findContentRevisions(file, file.body);
        return revisions.length === 1 ? revisions[0] : undefined;
    } catch (ex) {
        ctx.host.log(`Could not reconstruct file reflection provenance for ${file.path}`, LOG_LEVEL_VERBOSE);
        ctx.host.log(ex, LOG_LEVEL_VERBOSE);
        return undefined;
    }
}

/**
 * Prefer the displayed revision before reconstructing provenance from content.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @param preferredPath - The source provenance path used during a rename, when supplied.
 * @returns The displayed or uniquely reconstructed revision, or undefined.
 * @remarks No document lock is acquired here. Callers retain their surrounding operation lock; only device-local provenance and its hash cache may change.
 */
export async function getProvenBaseRevision(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    preferredPath?: FilePathWithPrefix
): Promise<string | undefined> {
    const path = (preferredPath ?? file.path) as FilePathWithPrefix;
    const recorded =
        (await getProvenance(ctx, path)) ??
        (preferredPath && preferredPath !== file.path ? await getProvenance(ctx, file.path) : undefined);
    // A stored record identifies the branch which produced the displayed
    // file. Its current content may legitimately have been edited to equal
    // another branch, so content matching must never override that identity.
    if (recorded) {
        return recorded.revision;
    }
    const matched = await findUniqueContentRevision(ctx, file);
    if (matched) {
        await setProvenance(ctx, path, matched, file.stat.mtime, file.body);
        return matched;
    }
    return undefined;
}

/**
 * Classify bytes against recorded ancestry before considering current matching leaves.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @param currentEntry - The current database metadata, or false when no record exists.
 * @param preferredPath - The source provenance path used during a rename, when supplied.
 * @param recorded - The provenance captured with the storage bytes.
 * @param currentLoaded - An already decoded revision body that may avoid a repeated database read.
 * @param requireReadableContent - Whether unreadable recorded live content must reject recovery.
 * @returns The ancestry-based classification; unreadable required content rejects the operation.
 * @remarks No document lock is acquired here. Callers retain their surrounding operation lock; only device-local provenance and its hash cache may change.
 */
export async function classifyStorageContent(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    currentEntry: { _rev?: string; deleted?: boolean; _deleted?: boolean } | false,
    preferredPath?: FilePathWithPrefix,
    recorded?: FileReflectionProvenanceRecord,
    currentLoaded?: { _rev?: string; data: string | string[] | Blob | ArrayBuffer },
    requireReadableContent = false
): Promise<StorageContentClassification> {
    const path = (preferredPath ?? file.path) as FilePathWithPrefix;
    const recordedRevision = recorded?.revision;
    if (recordedRevision) {
        const classification = await classifyRecordedStorageContent(
            ctx,
            file,
            path,
            recorded,
            recordedRevision,
            currentLoaded,
            requireReadableContent
        );
        if (classification) return classification;
    }
    return await classifyLiveStorageContent(ctx, file, currentEntry);
}

/**
 * Attempt to remember a revision already classified as an unambiguous match by the caller.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param revision - The observed provenance or selected revision.
 * @param mtime - The raw storage timestamp observed with the matching bytes.
 * @param content - The immutable bytes for this provenance observation.
 * @param evidence - Already computed content evidence, when available.
 * @returns Completion after a best-effort update when a truthy revision was supplied; undefined revisions do nothing.
 * @remarks This helper neither discovers a match nor validates live-leaf uniqueness. Its caller establishes that evidence, and provenance publication remains optional and best-effort.
 */
export async function rememberMatchingLeaf(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    revision: string | undefined,
    mtime: number,
    content: Blob,
    evidence?: Pick<FileReflectionProvenanceRecord, "contentHash" | "contentSize">
) {
    if (revision) await setProvenance(ctx, path, revision, mtime, content, evidence);
}

/**
 * Capture an independent raw provenance value for optimistic storage checks.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param requireReadable - Whether a provenance-store read error must propagate.
 * @returns A copied raw record or undefined; required store-read failures propagate.
 * @remarks Does not validate or remove the referenced database revision. An absent store or record, or a suppressed read failure, yields undefined.
 */
export async function readProvenanceSnapshot(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    requireReadable = false
): Promise<FileReflectionProvenanceRecord | undefined> {
    try {
        const record = await ctx.provenance?.get(getProvenancePath(ctx, path));
        return record ? { ...record } : undefined;
    } catch (error) {
        if (requireReadable) throw error;
        return undefined;
    }
}

/**
 * Recheck exact path, bytes, timestamp, and provenance against one observation.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @param revision - The raw provenance record captured alongside the supplied file.
 * @param requireReadableProvenance - Whether a provenance-store read error must propagate during revalidation.
 * @returns Whether the current observation still matches the captured storage and provenance.
 * @remarks Compares a fresh storage observation with raw provenance without writing records. Storage and comparison errors propagate; the flag controls provenance-read errors only.
 */
export async function currentStorageSnapshotMatches(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    revision: FileReflectionProvenanceRecord | undefined,
    requireReadableProvenance = false
): Promise<boolean> {
    const current = await ctx.host.storage().getStub(file.path);
    if (!current || isFolderInfo(current) || current.path !== file.path) return false;
    const readCurrent = await ctx.host.readFileFromStub(current);
    return (
        readCurrent.stat.mtime === file.stat.mtime &&
        (await isDocContentSame(readCurrent.body, file.body)) &&
        sameProvenance(await readProvenanceSnapshot(ctx, file.path, requireReadableProvenance), revision)
    );
}

/**
 * Attempt provenance publication for a durable revision after storage revalidation.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @param observedProvenance - The record captured before the database write.
 * @param storedRevision - The durable revision whose provenance may now be published.
 * @param requireReadableProvenance - Whether a provenance-store read error must propagate during revalidation.
 * @returns Whether storage revalidation allowed a provenance-write attempt; true does not guarantee that the optional record was persisted.
 * @remarks The caller holds its document lock. The database write is already durable; storage mismatch returns false, while provenance-store write errors retain setProvenance's best-effort policy.
 */
export async function finaliseStoredRevision(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    observedProvenance: FileReflectionProvenanceRecord | undefined,
    storedRevision: string,
    requireReadableProvenance = false
): Promise<boolean> {
    const evidence = await contentEvidence(ctx, file.body);
    if (await currentStorageSnapshotMatches(ctx, file, observedProvenance, requireReadableProvenance)) {
        await setProvenance(ctx, file.path, storedRevision, file.stat.mtime, file.body, evidence);
        return true;
    } else {
        // The write is durable, but the storage changed before its provenance
        // could be recorded. The caller must reconcile the current file.
        return false;
    }
}

/**
 * Recognise supported hash evidence without interpreting it as revision ancestry.
 *
 * @param record - The device-local record to inspect.
 * @returns Whether the record contains a supported hash and a non-negative integral content size.
 * @remarks Narrows both optional evidence fields without reading or changing any service or state.
 */
export function hasContentHash(
    record: FileReflectionProvenanceRecord | undefined
): record is FileReflectionProvenanceRecord & { contentHash: string; contentSize: number } {
    return (
        !!record &&
        typeof record.contentHash === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(record.contentHash) &&
        typeof record.contentSize === "number" &&
        Number.isSafeInteger(record.contentSize) &&
        record.contentSize >= 0
    );
}

/**
 * Compare the revision and observed content evidence of two device-local records.
 *
 * @param left - The first provenance observation.
 * @param right - The second provenance observation.
 * @returns Whether every stored provenance field is equal.
 * @remarks No document lock is acquired here. Callers retain their surrounding operation lock; only device-local provenance and its hash cache may change.
 */
export function sameProvenance(
    left: FileReflectionProvenanceRecord | undefined,
    right: FileReflectionProvenanceRecord | undefined
): boolean {
    return (
        left?.revision === right?.revision &&
        left?.observedStorageMtime === right?.observedStorageMtime &&
        left?.contentHash === right?.contentHash &&
        left?.contentSize === right?.contentSize
    );
}

/** Recorded ancestry distinguishes unchanged bytes from an edit on the displayed branch. */
type RecordedStorageClassification = { kind: "unchanged"; revision: string } | { kind: "edited"; revision: string };
/** Classification used by saving and overwrite preservation without guessing ancestry. */
export type StorageContentClassification =
    | RecordedStorageClassification
    | { kind: "matching-leaf"; revision?: string }
    | { kind: "unknown" };
/** A previously decoded body that can satisfy an exact recorded-revision comparison. */
type DecodedProvenanceContent = { _rev?: string; data: string | string[] | Blob | ArrayBuffer };
/**
 * Classify the recorded base before considering any matching live leaf.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param file - The observed immutable storage bytes.
 * @param path - The selected provenance key before classification.
 * @param recorded - The raw provenance captured with the bytes.
 * @param recordedRevision - The recorded base revision, already known to be present.
 * @param currentLoaded - An already decoded matching body, when available.
 * @param requireReadableContent - Whether missing live recorded content must reject recovery.
 * @returns The unchanged or edited recorded branch, or undefined when live-leaf fallback is required.
 * @remarks The caller retains its document lock. Hash comparison, local body reads, and stale-record cleanup keep their original order.
 */
async function classifyRecordedStorageContent(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    path: FilePathWithPrefix,
    recorded: FileReflectionProvenanceRecord | undefined,
    recordedRevision: string,
    currentLoaded: DecodedProvenanceContent | undefined,
    requireReadableContent: boolean
): Promise<RecordedStorageClassification | undefined> {
    if (
        hasContentHash(recorded) &&
        recorded.contentSize === file.body.size &&
        (await contentEvidence(ctx, file.body)).contentHash === recorded.contentHash
    ) {
        return { kind: "unchanged", revision: recordedRevision };
    }
    const loadedContentIsDecoded = currentLoaded?._rev === recordedRevision;
    const base = loadedContentIsDecoded
        ? currentLoaded
        : await ctx.host.db().fetchEntry(file, recordedRevision, true, true, true);
    if (
        base &&
        base._rev === recordedRevision &&
        !("deleted" in base && base.deleted) &&
        !("_deleted" in base && base._deleted)
    ) {
        const baseContent = loadedContentIsDecoded ? base.data : readContent(base as Parameters<typeof readContent>[0]);
        return (await isDocContentSame(baseContent, file.body))
            ? { kind: "unchanged", revision: recordedRevision }
            : { kind: "edited", revision: recordedRevision };
    }
    if (!base) {
        const meta = await ctx.host.db().fetchEntryMeta(file, recordedRevision, true);
        if (requireReadableContent && meta && !meta.deleted && !meta._deleted) {
            throw new Error(`Could not read the recorded file revision for ${file.path}`);
        }
        if ((!meta || meta.deleted || meta._deleted) && !hasContentHash(recorded)) await deleteProvenance(ctx, path);
    }
    return undefined;
}

/**
 * Match current live leaves only after recorded ancestry could not classify the bytes.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param file - The observed immutable storage bytes.
 * @param currentEntry - Current metadata, or false when no record exists.
 * @returns A matching-leaf result or unknown ancestry; several matches do not identify provenance.
 * @remarks This stage reads current leaves without writing storage, database revisions, or provenance.
 */
async function classifyLiveStorageContent(
    ctx: FileHandlerContext,
    file: UXFileInfo,
    currentEntry: { _rev?: string; deleted?: boolean; _deleted?: boolean } | false
): Promise<StorageContentClassification> {
    const matches = currentEntry ? await ctx.host.db().findLiveContentRevisions(file, file.body) : [];
    if (matches.length) {
        return { kind: "matching-leaf", revision: matches.length === 1 ? matches[0] : undefined };
    }
    return { kind: "unknown" };
}
