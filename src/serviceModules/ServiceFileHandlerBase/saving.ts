import { isFolderInfo, infoToStub } from "./storage";
import { withFileEventPaths, queueConflictCheckFor } from "./locking";
import {
    setProvenance,
    readProvenanceSnapshot,
    getProvenBaseRevision,
    deleteProvenance,
    classifyStorageContent,
    contentEvidence,
    hasContentHash,
    currentStorageSnapshotMatches,
    rememberMatchingLeaf,
    finaliseStoredRevision,
} from "./provenance";
import { dbToStorageCore } from "./reflection";
import type { StorageContentClassification } from "./provenance";

import type { LoadedEntry } from "@lib/common/types";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type {
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
    UXInternalFileInfoStub,
} from "@lib/common/types";
import { displayRev, getDocDataAsArray, isDocContentSame, readContent } from "@lib/common/utils";

import type { StoreFileOptions } from "@lib/interfaces/FileHandler";
import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";
import { EVEN } from "@lib/common/models/shared.const.symbols";
import { tryGetFilePath } from "@lib/common/utils.doc";

import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import type { FileHandlerContext } from "./context";

/**
 * Start at most two fresh recovery retries after a storage observation changes.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param preferredBasePath - The source provenance path used during a rename, when supplied.
 * @param snapshotRetry - The number of storage rereads already consumed.
 * @returns The next fresh retry result, or false when the retry budget is exhausted or the current path is absent or a folder.
 * @remarks The caller retains the document lock. The counter limits fresh retry attempts after the initial save; snapshot validation can reread storage without consuming that counter.
 */
async function retryCurrentStorage(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    preferredBasePath: FilePathWithPrefix | undefined,
    snapshotRetry: number
): Promise<boolean> {
    if (snapshotRetry >= 2) {
        ctx.host.log(`Storage kept changing while saving ${path}; a fresh event is required`, LOG_LEVEL_NOTICE);
        return false;
    }
    const fresh = await ctx.host.storage().getStub(path);
    if (!fresh || isFolderInfo(fresh)) return false;
    return await storeFileToDBFromRevision(ctx, fresh, false, false, preferredBasePath, true, snapshotRetry + 1);
}

/**
 * Save ordinary storage content under its document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @param onlyChunks - Whether to repair chunks without creating a document revision.
 * @param options - The existing recovery revalidation option for this save.
 * @returns True when current bytes are represented or chunk repair succeeds; false for refused or unstable observations.
 * @remarks Core helpers require the caller's document lock. Ordinary revision writes reuse the captured body; legacy-evidence upgrades retain their validation reads, and recovery permits two fresh retries in addition to validation rereads.
 */
export async function storeFileToDB(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
    force: boolean = false,
    onlyChunks: boolean = false,
    options: StoreFileOptions = {}
): Promise<boolean> {
    return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], () =>
        storeFileToDBFromRevision(ctx, info, force, onlyChunks, undefined, options.revalidateStorage)
    );
}

/**
 * Save current bytes under one selected live database revision.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param baseRevision - The exact selected live database revision.
 * @param createIfDifferent - Whether differing bytes may create a child of the selected revision.
 * @returns True when matching bytes are certified or a selected-base child is stored; false when the live-base or content condition refuses it.
 * @remarks Core helpers require the caller's document lock. Ordinary revision writes reuse the captured body; legacy-evidence upgrades retain their validation reads, and recovery permits two fresh retries in addition to validation rereads.
 */
export async function storeFileToDBWithBaseRevision(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
    baseRevision: string,
    createIfDifferent: boolean = true
): Promise<boolean> {
    return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], () =>
        storeFileToDBWithBaseRevisionCore(ctx, info, baseRevision, createIfDifferent)
    );
}

/**
 * Validate a selected live base and conditionally save or certify its content.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param baseRevision - The exact selected live database revision.
 * @param createIfDifferent - Whether differing bytes may create a child of the selected revision.
 * @returns True after certifying matching bytes or storing a child of the selected live revision; false on refusal.
 * @remarks Core helpers require the caller's document lock. Ordinary revision writes reuse the captured body; legacy-evidence upgrades retain their validation reads, and recovery permits two fresh retries in addition to validation rereads.
 */
async function storeFileToDBWithBaseRevisionCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
    baseRevision: string,
    createIfDifferent: boolean
): Promise<boolean> {
    const file = await infoToStub(ctx, info);
    if (file == null) {
        ctx.host.log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
        return false;
    }
    if (file.isInternal) {
        ctx.host.log(
            `Internal file ${file.path} is not allowed to be stored through the ordinary file handler`,
            LOG_LEVEL_VERBOSE
        );
        return false;
    }

    const [baseEntry, currentEntry, conflictedRevisions] = await Promise.all([
        ctx.host.db().fetchEntryMeta(file, baseRevision, true),
        ctx.host.db().fetchEntryMeta(file, undefined, true),
        ctx.host.db().getConflictedRevs(file),
    ]);
    const liveRevisions = new Set([
        ...(currentEntry && currentEntry._rev ? [currentEntry._rev] : []),
        ...conflictedRevisions,
    ]);
    if (!baseEntry || baseEntry._rev !== baseRevision || !liveRevisions.has(baseRevision)) {
        ctx.host.log(
            `Could not store ${file.path} on revision ${baseRevision}; the selected revision is no longer live`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }

    const readFile = await ctx.host.readFileFromStub(file);
    if (!baseEntry.deleted && !baseEntry._deleted) {
        const loadedBase = await ctx.host.db().fetchEntry(file, baseRevision, true, true);
        if (loadedBase && (await isDocContentSame(getDocDataAsArray(loadedBase.data), readFile.body))) {
            await setProvenance(ctx, file.path, baseRevision, readFile.stat.mtime, readFile.body);
            await queueConflictCheckFor(ctx, file.path);
            return true;
        }
    }
    if (!createIfDifferent) {
        ctx.host.log(
            `Could not mark ${file.path} as revision ${baseRevision}; the storage content differs`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }

    const storedRevision = await ctx.host.db().storeWithBaseRevision(readFile, baseRevision, true);
    if (storedRevision === false) {
        return false;
    }
    await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
    await queueConflictCheckFor(ctx, file.path);
    return true;
}

/**
 * Save one observed storage body using provenance and the current revision tree.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @param onlyChunks - Whether to repair chunks without creating a document revision.
 * @param preferredBasePath - The source provenance path used during a rename, when supplied.
 * @param retryIfStorageChanges - Whether recovery revalidates storage and permits bounded rereads.
 * @param snapshotRetry - The number of storage rereads already consumed.
 * @returns True when the observed bytes are represented; false after a refused write or exhausted recovery rechecks.
 * @remarks Core helpers require the caller's document lock. Ordinary revision writes reuse the captured body; legacy-evidence upgrades retain their validation reads, and recovery permits two fresh retries in addition to validation rereads.
 */
export async function storeFileToDBFromRevision(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
    force: boolean = false,
    onlyChunks: boolean = false,
    preferredBasePath?: FilePathWithPrefix,
    retryIfStorageChanges = false,
    snapshotRetry = 0
): Promise<boolean> {
    const file = await infoToStub(ctx, info);
    if (file == null) {
        ctx.host.log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
        return false;
    }
    if (file.isInternal) {
        ctx.host.log(
            `Internal file ${file.path} is not allowed to be processed on processFileEvent`,
            LOG_LEVEL_VERBOSE
        );
        return false;
    }
    if (onlyChunks) {
        const readFile = await ctx.host.readFileFromStub(file);
        return await ctx.host.db().createChunks(readFile, force, true);
    }
    const save = await observeStorageSave(ctx, file, preferredBasePath, retryIfStorageChanges);
    const currentEntry = save.currentEntry;
    const currentIsLive = currentEntry && !currentEntry.deleted && !currentEntry._deleted;
    if (!force && (currentIsLive || retryIfStorageChanges)) {
        return await saveClassifiedStorage(ctx, save, preferredBasePath, retryIfStorageChanges, snapshotRetry);
    }
    if (save.isConflicted) return await saveConflictedStorage(ctx, save, force, preferredBasePath);
    if (!currentEntry || currentEntry.deleted || currentEntry._deleted)
        return await createStorageRevision(ctx, save, preferredBasePath);
    return await saveCurrentStorage(ctx, save, currentEntry, force, onlyChunks, preferredBasePath);
}

/** Observations acquired in order while the caller holds the document lock. */
interface StorageSaveObservation {
    /** File identity and statistics used for this attempt. */
    readonly file: UXFileInfoStub;
    /** One immutable storage body read inside the lock. */
    readonly readFile: UXFileInfo;
    /** Raw provenance captured before reading the body. */
    readonly observedProvenance: FileReflectionProvenanceRecord | undefined;
    /** Decoded current body, when readable. */
    readonly entry: LoadedEntry | false;
    /** Current metadata, including unreadable or deleted entries. */
    readonly currentEntry: MetaEntry | LoadedEntry | false;
    /** Whether the observed current tree has another live leaf. */
    readonly isConflicted: boolean;
}
/**
 * Capture provenance, one storage body, and the current database tree in the existing order.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param file - The file selected for this attempt.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @param retryIfStorageChanges - Whether recovery revalidates the observed storage snapshot.
 * @returns The immutable body and associated provenance/database observations.
 * @remarks The caller holds the document lock. Recovery reads may retrieve missing Chunks through the settings-controlled path; ordinary reads remain local-only. This stage creates no Metadata revision and starts no retry.
 */
async function observeStorageSave(
    ctx: FileHandlerContext,
    file: UXFileInfoStub,
    preferredBasePath: FilePathWithPrefix | undefined,
    retryIfStorageChanges: boolean
): Promise<StorageSaveObservation> {
    const observedProvenance = await readProvenanceSnapshot(
        ctx,
        (preferredBasePath ?? file.path) as FilePathWithPrefix,
        retryIfStorageChanges
    );
    const readFile = await ctx.host.readFileFromStub(file);
    // Recovery comparisons may need chunks omitted by on-demand replication.
    // Ordinary saves retain their local-first read.
    const entry = await ctx.host.db().fetchEntry(file, undefined, true, true, !retryIfStorageChanges);
    const currentEntry = entry || (await ctx.host.db().fetchEntryMeta(file, undefined, true));
    const conflictedRevs = await ctx.host.db().getConflictedRevs(file);
    const isConflicted = conflictedRevs.length > 0;
    return { file, readFile, observedProvenance, entry, currentEntry, isConflicted };
}

/**
 * Reconcile provenance-classified content and commit its remaining database effect.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param save - The body and database observations captured for this attempt.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @param retryIfStorageChanges - Whether recovery revalidates the observed storage snapshot.
 * @param snapshotRetry - Storage rereads already consumed by this recovery operation.
 * @returns Whether unchanged, matched, or newly stored content completed safely.
 * @remarks The caller holds the document lock. Evidence is acquired before effect-specific revalidation. Recovery permits at most two fresh retries; validation reads are not themselves counted as retries.
 */
async function saveClassifiedStorage(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    preferredBasePath: FilePathWithPrefix | undefined,
    retryIfStorageChanges: boolean,
    snapshotRetry: number
): Promise<boolean> {
    const { entry, currentEntry } = save;
    const currentIsLive = currentEntry && !currentEntry.deleted && !currentEntry._deleted;
    if (retryIfStorageChanges && currentIsLive && !entry) {
        const revision = currentEntry._rev ? displayRev(currentEntry._rev) : "unknown";
        ctx.host.log(
            `Could not reconcile ${save.file.path}: content for current database revision ${revision} is unavailable; this file remains unresolved for a later scan.`,
            LOG_LEVEL_VERBOSE
        );
        return false;
    }
    const details = await observeClassifiedStorage(ctx, save, preferredBasePath, retryIfStorageChanges);
    const recovery: StorageSaveRecovery = { preferredBasePath, retryIfStorageChanges, snapshotRetry };
    const classification = details.classification;
    if (classification.kind === "unchanged")
        return await finishUnchangedStorageSave(ctx, save, classification.revision, details, recovery);
    if (classification.kind === "matching-leaf")
        return await finishMatchingStorageSave(ctx, save, classification.revision, details, recovery);
    return await storeClassifiedStorageEdit(ctx, save, classification, recovery);
}

/**
 * Save a displayed conflict branch or preserve unknown content as a sibling.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param save - The body and database observations captured for this attempt.
 * @param force - Whether the existing force policy bypasses unchanged-content skipping.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @returns True when unchanged displayed bytes were recognised or known/unknown conflict content was stored; false after a refused write or missing current revision.
 * @remarks The caller holds the document lock. An unknown-origin sibling save is a successful preservation outcome; device-local provenance publication remains best-effort.
 */
async function saveConflictedStorage(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    force: boolean,
    preferredBasePath: FilePathWithPrefix | undefined
): Promise<boolean> {
    const { file, readFile, entry } = save;
    const baseRevision = await getProvenBaseRevision(ctx, readFile, preferredBasePath);
    if (baseRevision) {
        const baseEntry = await ctx.host.db().fetchEntry(file, baseRevision, true, true);
        if (baseEntry && (await isDocContentSame(getDocDataAsArray(baseEntry.data), readFile.body)) && !force) {
            await setProvenance(ctx, file.path, baseRevision, readFile.stat.mtime, readFile.body);
            ctx.host.log(`File ${file.path} is not changed on its displayed conflict branch`, LOG_LEVEL_VERBOSE);
            return true;
        }
        const storedRevision = await ctx.host.db().storeWithBaseRevision(readFile, baseRevision, true);
        if (storedRevision === false) return false;
        if (preferredBasePath && preferredBasePath !== file.path) {
            await deleteProvenance(ctx, preferredBasePath);
        }
        await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
        await queueConflictCheckFor(ctx, file.path);
        return true;
    }
    const currentEntry = entry || (await ctx.host.db().fetchEntryMeta(file, undefined, true));
    const currentRevision = currentEntry && currentEntry._rev;
    if (!currentRevision) {
        ctx.host.log(
            `Could not preserve the unknown conflict branch for ${file.path}; no current revision is available`,
            LOG_LEVEL_NOTICE
        );
        await queueConflictCheckFor(ctx, file.path);
        return false;
    }
    const storedRevision = await ctx.host.db().storeAsConflictedRevisionWithResult(readFile, currentRevision, true);
    if (storedRevision === false) {
        ctx.host.log(`Could not preserve the unknown conflict branch for ${file.path}`, LOG_LEVEL_NOTICE);
        await queueConflictCheckFor(ctx, file.path);
        return false;
    }
    if (preferredBasePath && preferredBasePath !== file.path) {
        await deleteProvenance(ctx, preferredBasePath);
    }
    await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
    await queueConflictCheckFor(ctx, file.path);
    return true;
}

/**
 * Create the remaining storage revision when current metadata is absent or deleted.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param save - The body and database observations captured for this attempt.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @returns Whether the database revision was stored and any source cleanup/new provenance updates were attempted; true does not certify provenance persistence.
 * @remarks The caller holds the document lock. Device-local provenance writes and clearing are optional and best-effort after the successful database effect.
 */
async function createStorageRevision(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    preferredBasePath: FilePathWithPrefix | undefined
): Promise<boolean> {
    const { file, readFile, entry } = save;
    const storedRevision = await ctx.host.db().storeWithBaseRevision(readFile, entry ? entry._rev : undefined, true);
    if (storedRevision === false) return false;
    if (preferredBasePath && preferredBasePath !== file.path) {
        await deleteProvenance(ctx, preferredBasePath);
    }
    await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
    return true;
}

/**
 * Compare timestamps and bytes before advancing the current non-conflicted revision.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param save - The body and database observations captured for this attempt.
 * @param currentEntry - The already validated current live metadata.
 * @param force - Existing force policy for this save.
 * @param onlyChunks - Existing chunk-only flag retained by the comparison condition.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @returns Whether unchanged content was recognised or its new revision was stored.
 * @remarks The caller holds the document lock. Marking equivalent timestamps and updating provenance retain their existing order.
 */
async function saveCurrentStorage(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    currentEntry: MetaEntry | LoadedEntry,
    force: boolean,
    onlyChunks: boolean,
    preferredBasePath: FilePathWithPrefix | undefined
): Promise<boolean> {
    const { file, readFile, entry } = save;
    let shouldApplied = false;
    if (!force && !onlyChunks && entry) {
        // 1. if the time stamp is far different, then it should be updated.
        // Note: This checks only the mtime with the resolution reduced to 2 seconds.
        //       2 seconds it for the ZIP file's mtime. If not, we cannot backup the vault as the ZIP file.
        //       This is hardcoded on `compareMtime` of `src/common/utils.ts`.
        if (ctx.path.compareFileFreshness(file, entry) !== EVEN) {
            shouldApplied = true;
        }
        // 2. if not, the content should be checked.
        if (!shouldApplied) {
            if (await isDocContentSame(getDocDataAsArray(entry.data), readFile.body)) {
                // Timestamp is different but the content is same. therefore, two timestamps should be handled as same.
                // So, mark the changes are same.
                ctx.path.markChangesAreSame(readFile, readFile.stat.mtime, entry.mtime);
            } else {
                shouldApplied = true;
            }
        }

        if (!shouldApplied) {
            await setProvenance(ctx, file.path, entry._rev, readFile.stat.mtime, readFile.body);
            ctx.host.log(`File ${file.path} is not changed`, LOG_LEVEL_VERBOSE);
            return true;
        }
    }
    const storedRevision = await ctx.host.db().storeWithBaseRevision(readFile, currentEntry._rev, true);
    if (storedRevision === false) return false;
    if (preferredBasePath && preferredBasePath !== file.path) {
        await deleteProvenance(ctx, preferredBasePath);
    }
    await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
    return true;
}

/** Classification and evidence acquired before the final effect-specific storage check. */
interface ClassifiedStorageEvidence {
    /** Recorded ancestry or a current-leaf content match. */
    readonly classification: StorageContentClassification;
    /** Whether a legacy current record is eligible for a content-evidence upgrade. */
    readonly upgradeCurrentRecord: boolean;
    /** Evidence computed only when the selected effect needs it. */
    readonly evidence: Pick<FileReflectionProvenanceRecord, "contentHash" | "contentSize"> | undefined;
}
/** Existing recovery inputs shared by classification effect stages. */
interface StorageSaveRecovery {
    /** Source provenance path during rename, when supplied. */
    readonly preferredBasePath: FilePathWithPrefix | undefined;
    /** Whether current storage must be revalidated. */
    readonly retryIfStorageChanges: boolean;
    /** Existing count of consumed recovery rereads. */
    readonly snapshotRetry: number;
}
/**
 * Acquire ancestry classification and any required hash evidence before the final storage check.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param save - The already captured storage and database observations.
 * @param preferredBasePath - Rename-source provenance path, when supplied.
 * @param retryIfStorageChanges - Whether recovery requires readable recorded content.
 * @returns Classification, legacy-record upgrade intent, and evidence for the next effect stage.
 * @remarks The caller holds the document lock. This stage may read or repair provenance but does not certify a later destructive effect.
 */
async function observeClassifiedStorage(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    preferredBasePath: FilePathWithPrefix | undefined,
    retryIfStorageChanges: boolean
): Promise<ClassifiedStorageEvidence> {
    const { readFile, observedProvenance, entry, currentEntry } = save;
    const classification = await classifyStorageContent(
        ctx,
        readFile,
        currentEntry,
        preferredBasePath,
        observedProvenance,
        entry ? { _rev: entry._rev, data: readContent(entry) } : undefined,
        retryIfStorageChanges
    );
    const upgradeCurrentRecord = shouldUpgradeSavedRecord(save, classification);
    const evidence =
        upgradeCurrentRecord || (classification.kind === "matching-leaf" && classification.revision)
            ? await contentEvidence(ctx, readFile.body)
            : undefined;

    return { classification, upgradeCurrentRecord, evidence };
}

/**
 * Decide whether unchanged current bytes can upgrade a legacy provenance record.
 * @param save - The original storage and database observations.
 * @param classification - The ancestry classification already acquired.
 * @returns Whether evidence must be computed and storage revalidated before upgrading provenance.
 * @remarks This predicate reads captured values only and performs no I/O.
 */
function shouldUpgradeSavedRecord(save: StorageSaveObservation, classification: StorageContentClassification): boolean {
    const { currentEntry, isConflicted, observedProvenance } = save;
    return (
        classification.kind === "unchanged" &&
        !isConflicted &&
        currentEntry &&
        !currentEntry.deleted &&
        !currentEntry._deleted &&
        classification.revision === currentEntry._rev &&
        !hasContentHash(observedProvenance)
    );
}

/**
 * Complete unchanged-content handling without moving revalidation away from its provenance effect.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param save - The immutable body and associated database observations.
 * @param revision - The recorded unchanged revision.
 * @param details - Classification evidence acquired before final revalidation.
 * @param recovery - The existing rename path and bounded recovery policy.
 * @returns Whether the unchanged observation was handled by conflict review, advanced reflection, or best-effort provenance bookkeeping.
 * @remarks The caller holds the lock. The final snapshot check and dependent provenance update remain in this stage.
 */
async function finishUnchangedStorageSave(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    revision: string,
    details: ClassifiedStorageEvidence,
    recovery: StorageSaveRecovery
): Promise<boolean> {
    const { file, readFile, observedProvenance, currentEntry, isConflicted } = save;
    const { upgradeCurrentRecord, evidence } = details;
    const { preferredBasePath, retryIfStorageChanges, snapshotRetry } = recovery;
    const snapshotMatches =
        retryIfStorageChanges || upgradeCurrentRecord
            ? await currentStorageSnapshotMatches(ctx, readFile, observedProvenance, retryIfStorageChanges)
            : true;
    if (retryIfStorageChanges && !snapshotMatches)
        return await retryCurrentStorage(ctx, file.path, preferredBasePath, snapshotRetry);
    if (isConflicted) {
        await queueConflictCheckFor(ctx, file.path);
    } else if (!currentEntry || currentEntry.deleted || currentEntry._deleted || revision !== currentEntry._rev) {
        if (!currentEntry) return false;
        return await dbToStorageCore(ctx, file.path as FilePathWithPrefix, file);
    } else {
        if (upgradeCurrentRecord && snapshotMatches) {
            await setProvenance(ctx, file.path, revision, readFile.stat.mtime, readFile.body, evidence);
        }
        ctx.path.markChangesAreSame(readFile, readFile.stat.mtime, currentEntry.mtime);
    }
    return true;
}

/**
 * Record an unambiguous current-leaf match after any required final recovery check.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param save - The immutable body and associated database observations.
 * @param revision - The matching live revision, absent when several leaves match.
 * @param details - Classification evidence acquired before final revalidation.
 * @param recovery - The existing rename path and bounded recovery policy.
 * @returns Whether leaf-match handling and any conflict notification completed; provenance updates remain best-effort.
 * @remarks The caller holds the lock. Ambiguous content matches never acquire a guessed provenance revision.
 */
async function finishMatchingStorageSave(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    revision: string | undefined,
    details: ClassifiedStorageEvidence,
    recovery: StorageSaveRecovery
): Promise<boolean> {
    const { file, readFile, observedProvenance, isConflicted } = save;
    const { evidence } = details;
    const { preferredBasePath, retryIfStorageChanges, snapshotRetry } = recovery;
    if (retryIfStorageChanges && !(await currentStorageSnapshotMatches(ctx, readFile, observedProvenance, true)))
        return await retryCurrentStorage(ctx, file.path, preferredBasePath, snapshotRetry);
    await rememberMatchingLeaf(ctx, file.path, revision, readFile.stat.mtime, readFile.body, evidence);
    if (isConflicted) await queueConflictCheckFor(ctx, file.path);
    return true;
}

/**
 * Commit edited or unknown bytes with final recovery validation adjacent to the write.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param save - The immutable body and associated database observations.
 * @param classification - The recorded edit or unknown ancestry which requires a database write.
 * @param recovery - The existing rename path and bounded recovery policy.
 * @returns Whether the database effect and required conflict handling completed; provenance publication remains best-effort.
 * @remarks The caller holds the document lock. Final validation and the database write remain together. Unknown bytes stay independent, and the existing limit applies to fresh retries rather than all validation reads.
 */
async function storeClassifiedStorageEdit(
    ctx: FileHandlerContext,
    save: StorageSaveObservation,
    classification: Extract<StorageContentClassification, { kind: "edited" | "unknown" }>,
    recovery: StorageSaveRecovery
): Promise<boolean> {
    const { file, readFile, observedProvenance, isConflicted } = save;
    const { preferredBasePath, retryIfStorageChanges, snapshotRetry } = recovery;
    if (retryIfStorageChanges && !(await currentStorageSnapshotMatches(ctx, readFile, observedProvenance, true)))
        return await retryCurrentStorage(ctx, file.path, preferredBasePath, snapshotRetry);
    const storedRevision =
        classification.kind === "edited"
            ? await ctx.host.db().storeWithBaseRevision(readFile, classification.revision, true)
            : await ctx.host.db().storeIndependentRevision(readFile, true);
    if (storedRevision === false) return false;
    if (preferredBasePath && preferredBasePath !== file.path) await deleteProvenance(ctx, preferredBasePath);
    if (
        retryIfStorageChanges &&
        !(await finaliseStoredRevision(ctx, readFile, observedProvenance, storedRevision, true))
    ) {
        return await retryCurrentStorage(ctx, file.path, preferredBasePath, snapshotRetry);
    }
    if (!retryIfStorageChanges) await setProvenance(ctx, file.path, storedRevision, readFile.stat.mtime, readFile.body);
    if (isConflicted || classification.kind === "unknown") await queueConflictCheckFor(ctx, file.path);
    return true;
}
