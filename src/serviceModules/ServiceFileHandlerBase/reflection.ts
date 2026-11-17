import { ContentReadError } from "@lib/common/LSError.ts";
import {
    FILE_REFLECTION_COMPLETED,
    FILE_REFLECTION_POLICY,
    FILE_REFLECTION_CANCELLED,
    isReflectionCancelled,
    type FileReflectionResult,
    type ReflectionOperationContext,
} from "@lib/interfaces/FileHandler";
import { withFileEventPaths, queueConflictCheckFor } from "./locking";
import { infoToStub, isFolderInfo, getParentPath } from "./storage";
import {
    deleteProvenance,
    contentEvidence,
    currentStorageSnapshotMatches,
    sameProvenance,
    readProvenanceSnapshot,
    setProvenance,
} from "./provenance";
import { preserveUnsyncedStorageAsConflict, recheckIncomingStorage } from "./protection";

import type { LoadedEntry, ObsidianLiveSyncSettings } from "@lib/common/types";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import type { FilePath, FilePathWithPrefix, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";
import { createBlob, isDocContentSame, readContent } from "@lib/common/utils";

import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";
import { EVEN } from "@lib/common/models/shared.const.symbols";
import { tryGetFilePath } from "@lib/common/utils.doc";
import { getPathNormalizationVersion, normalisePathForIdentity } from "@lib/common/pathNormalization";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import type { FileHandlerContext, StorageSnapshot } from "./context";

/** An incomplete attempt without a failed I/O boundary; its owner retains the target. */
export class IncompleteFileReflectionError extends Error {}

/**
 * Reflect one selected live revision under the storage document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @returns The selected live leaf reflection result, or false if the selected revision is no longer live or its content is unreadable.
 * @remarks Core operations run under the caller's document lock. Storage protection and database advancement are revalidated at their established await boundaries.
 */
export async function dbToStorageWithSpecificRev(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix | null,
    rev: string,
    force?: boolean
): Promise<boolean> {
    if (info == null) {
        ctx.host.log(`Cannot select database revision ${rev} without a file path`, LOG_LEVEL_VERBOSE);
        return false;
    }
    let operationReturned = false;
    try {
        return await withFileEventPaths(ctx, [getStoragePathFromUXFileInfo(info)], async () => {
            const result = await dbToStorageWithSpecificRevCore(ctx, info, rev, force);
            operationReturned = true;
            return result;
        });
    } catch (error) {
        if (
            !operationReturned &&
            (error instanceof ContentReadError || error instanceof IncompleteFileReflectionError)
        ) {
            ctx.host.log(error, LOG_LEVEL_VERBOSE);
            return false;
        }
        throw error;
    }
}

/**
 * Validate a selected live leaf before reflecting its captured metadata.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @param rev - The exact selected database revision.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @returns The selected live leaf reflection result, or false if the selected revision is no longer live.
 * @remarks Core operations run under the caller's document lock. Storage protection and database advancement are revalidated at their established await boundaries.
 */
async function dbToStorageWithSpecificRevCore(
    ctx: FileHandlerContext,
    info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix,
    rev: string,
    force?: boolean
): Promise<boolean> {
    const file = await infoToStub(ctx, info);
    const databaseTarget = file ?? info;
    const [docEntry, currentEntry, conflictedRevisions] = await Promise.all([
        ctx.host.db().readEntryMeta(databaseTarget, rev, true),
        ctx.host.db().readEntryMeta(databaseTarget, undefined, true),
        ctx.host.db().readConflictedRevs(databaseTarget),
    ]);
    if (!docEntry) {
        ctx.host.log(`File ${tryGetFilePath(info)} is not exist on the database`, LOG_LEVEL_VERBOSE);
        return false;
    }
    const liveRevisions = new Set([
        ...(currentEntry && currentEntry._rev ? [currentEntry._rev] : []),
        ...conflictedRevisions,
    ]);
    if (!liveRevisions.has(rev)) {
        ctx.host.log(
            `Could not apply ${tryGetFilePath(info)} revision ${rev}; the selected revision is no longer live`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }
    return !isReflectionCancelled(await applyDatabaseEntryToStorage(ctx, docEntry, file, force, true));
}

/**
 * Fetch and reflect the current database revision under its document lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param entryInfo - Current metadata or a path from which metadata is loaded.
 * @param info - The supplied file observation or path.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @returns True after reflection or a safe conflict/absence skip; false on unreadable or unsafe observations.
 * @remarks Core operations run under the caller's document lock. Storage protection and database advancement are revalidated at their established await boundaries.
 */
export async function dbToStorage(
    ctx: FileHandlerContext,
    entryInfo: MetaEntry | FilePathWithPrefix,
    info: UXFileInfoStub | UXFileInfo | FilePath | null,
    force?: boolean
): Promise<boolean> {
    const path = typeof entryInfo === "string" ? entryInfo : ctx.host.getPath(entryInfo);
    let operationReturned = false;
    try {
        const result = await withFileEventPaths(ctx, [path], async () => {
            const outcome = await dbToStorageCore(ctx, entryInfo, info, force);
            operationReturned = true;
            return outcome;
        });
        return !isReflectionCancelled(result);
    } catch (error) {
        // Only adapt the operation's failure. A post-unlock hook can fail after
        // successful reflection and must never turn that work into a retry.
        if (
            !operationReturned &&
            (error instanceof ContentReadError || error instanceof IncompleteFileReflectionError)
        ) {
            ctx.host.log(error, LOG_LEVEL_VERBOSE);
            return false;
        }
        throw error;
    }
}

/** Run one reflection using the target owner's immutable operation premises. */
export async function reflectDatabaseEntry(
    ctx: FileHandlerContext,
    entryInfo: MetaEntry | FilePathWithPrefix,
    info: UXFileInfoStub | UXFileInfo | FilePath | null,
    force?: boolean,
    operation?: ReflectionOperationContext
): Promise<FileReflectionResult> {
    const path = typeof entryInfo === "string" ? entryInfo : ctx.host.getPath(entryInfo);
    return await withFileEventPaths(ctx, [path], () => dbToStorageCore(ctx, entryInfo, info, force, operation));
}

/**
 * Fetch current metadata and apply its storage reflection without reacquiring the lock.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param entryInfo - Current metadata or a path from which metadata is loaded.
 * @param info - The supplied file observation or path.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @returns The ordinary completion, policy hand-off, or owner cancellation outcome; failed reads reject.
 * @remarks Core operations run under the caller's document lock. Storage protection and database advancement are revalidated at their established await boundaries.
 */
export async function dbToStorageCore(
    ctx: FileHandlerContext,
    entryInfo: MetaEntry | FilePathWithPrefix,
    info: UXFileInfoStub | UXFileInfo | FilePath | null,
    force?: boolean,
    operation?: ReflectionOperationContext
): Promise<FileReflectionResult> {
    if (operation?.checkpoint?.() === false) {
        return FILE_REFLECTION_CANCELLED;
    }
    const file = await infoToStub(ctx, info);
    const pathFromEntryInfo = typeof entryInfo === "string" ? entryInfo : ctx.host.getPath(entryInfo);
    const docEntry = await ctx.host.db().readEntryMeta(pathFromEntryInfo, undefined, true);
    if (!docEntry) {
        ctx.host.log(`File ${pathFromEntryInfo} is not exist on the database`, LOG_LEVEL_VERBOSE);
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    return await applyDatabaseEntryToStorage(ctx, docEntry, file, force, false, 0, operation);
}

/**
 * Reflect database content while protecting current storage and its provenance.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param docEntry - The captured database metadata to reflect.
 * @param file - The supplied storage observation; its body is reused when present.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @param allowExistingConflicts - Whether the caller explicitly selected an existing live conflict leaf.
 * @param incomingRetry - The number of database-advancement rereads already consumed.
 * @returns The completed or policy outcome; incomplete content or unsafe observations reject.
 * @remarks Core operations run under the caller's document lock. Storage protection and database advancement are revalidated at their established await boundaries.
 */
export async function applyDatabaseEntryToStorage(
    ctx: FileHandlerContext,
    docEntry: MetaEntry,
    file: UXFileInfoStub | UXFileInfo | null,
    force?: boolean,
    allowExistingConflicts: boolean = false,
    incomingRetry = 0,
    operation?: ReflectionOperationContext
): Promise<FileReflectionResult> {
    const mode = file == null ? "create" : "modify";
    const path = ctx.host.getPath(docEntry);
    const settings = ctx.setting.currentSettings();
    const revs = await ctx.host.db().readConflictedRevs(path);
    if (revs.length > 0 && !allowExistingConflicts) {
        // Some conflicts are exist.
        if (settings.writeDocumentsIfConflicted) {
            // If configured to write the document even if conflicted, then it should be written.
            // NO OP
        } else {
            // If not, then it should be checked. and will be processed later (i.e., after the conflict is resolved).
            await queueConflictCheckFor(ctx, path, true);
            return FILE_REFLECTION_POLICY;
        }
    }
    let existDoc = await ctx.host.storage().getStub(path);
    if (isFolderInfo(existDoc)) {
        ctx.host.log(`Folder ${path} is already exist on the storage as a folder`, LOG_LEVEL_VERBOSE);
        return FILE_REFLECTION_POLICY;
    }
    const existOnDB = !(docEntry._deleted || docEntry.deleted || false);
    if (!existOnDB && !existDoc) {
        ctx.host.log(`File ${path} seems to be deleted, but already not on storage`, LOG_LEVEL_VERBOSE);
        await deleteProvenance(ctx, path);
        return FILE_REFLECTION_COMPLETED;
    }
    if (!existOnDB && existDoc) {
        return await applyIncomingDeletion(
            ctx,
            docEntry,
            existDoc,
            path,
            settings,
            force,
            allowExistingConflicts,
            incomingRetry,
            operation
        );
    }
    if (existDoc && existDoc.path !== path) {
        const current = await reconcileStoragePath(ctx, existDoc, path, settings);
        if (current === false) {
            throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
        }
        existDoc = current;
    }
    const docRead = await ctx.host.db().readEntryFromMeta(docEntry);
    if (!docRead) {
        ctx.host.log(`File ${path} is not exist on the database`, LOG_LEVEL_VERBOSE);
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    const docData = readContent(docRead);
    const reflectedContent = createBlob(docData);
    if (!settings.processSizeMismatchedFiles) {
        // Check the file is not corrupted
        // (Zero is a special case, may be created by some APIs and it might be acceptable).
        if (docRead.size != 0 && docRead.size !== reflectedContent.size) {
            ctx.host.log(
                `File ${path} seems to be corrupted! Writing prevented. (${docRead.size} != ${reflectedContent.size})`,
                LOG_LEVEL_NOTICE
            );
            throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
        }
    }
    const reflectedEvidence = await contentEvidence(ctx, reflectedContent);
    const write: IncomingStorageWrite = {
        docEntry,
        docRead,
        docData,
        reflectedContent,
        reflectedEvidence,
        existDoc,
        path,
        settings,
        mode,
        force,
        allowExistingConflicts,
        incomingRetry,
        operation,
    };
    const preparation = await prepareIncomingStorageWrite(ctx, write);
    if (preparation.kind === "complete") return preparation.result;
    return await commitIncomingStorageWrite(ctx, write, preparation.snapshot);
}

/**
 * Reconcile database churn before reflection with the existing two-recheck limit.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param incomingEntry - The database metadata about to be reflected.
 * @param path - The affected file or provenance path.
 * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
 * @param allowExistingConflicts - Whether the caller explicitly selected an existing live conflict leaf.
 * @param incomingRetry - The number of database-advancement rereads already consumed.
 * @returns Undefined to continue the selected incoming entry; otherwise the refusal or completed advanced-revision reconciliation result.
 * @remarks The caller retains the document lock. Force/explicit-conflict selection and an unchanged current revision return undefined; at most two fresh advanced-revision attempts are started.
 */
async function reconcileAdvancedIncomingRevision(
    ctx: FileHandlerContext,
    incomingEntry: MetaEntry,
    path: FilePathWithPrefix,
    force: boolean | undefined,
    allowExistingConflicts: boolean,
    incomingRetry: number,
    operation?: ReflectionOperationContext
): Promise<FileReflectionResult | undefined> {
    if (force || allowExistingConflicts) return undefined;
    // Protection above may await storage work, so the incoming metadata can
    // be stale even though it was current when this reflection began.
    const current = await ctx.host.db().readEntryMeta(path, undefined, true);
    if (!current) {
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    if (current._rev === incomingEntry._rev) return undefined;
    if (incomingRetry >= 2) {
        ctx.host.log(`Database kept changing while reflecting ${path}`, LOG_LEVEL_NOTICE);
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    const storage = await ctx.host.storage().getStub(path);
    if (isFolderInfo(storage)) {
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    return await applyDatabaseEntryToStorage(
        ctx,
        current,
        storage,
        force,
        allowExistingConflicts,
        incomingRetry + 1,
        operation
    );
}

/** Captured inputs retained through one incoming-reflection attempt. */
interface IncomingStorageWrite {
    /** Selected metadata and decoded content from the same incoming revision. */
    readonly docEntry: MetaEntry;
    /** Decoded revision properties used for file timestamps and equivalence. */
    readonly docRead: LoadedEntry;
    /** Decoded incoming bytes passed to storage and preservation. */
    readonly docData: ReturnType<typeof readContent>;
    /** Immutable incoming bytes used for size and provenance evidence. */
    readonly reflectedContent: Blob;
    /** Evidence computed before any incoming write. */
    readonly reflectedEvidence: Pick<FileReflectionProvenanceRecord, "contentHash" | "contentSize">;
    /** Current non-folder storage observation. */
    readonly existDoc: UXFileInfoStub | null;
    /** Incoming host path, captured through the virtual path seam. */
    readonly path: FilePathWithPrefix;
    /** Settings snapshot acquired at the original reflection entry point. */
    readonly settings: ObsidianLiveSyncSettings;
    /** Host event raised after the write. */
    readonly mode: "create" | "modify";
    /** Existing force policy. */
    readonly force: boolean | undefined;
    /** Explicit selection of a live conflict leaf. */
    readonly allowExistingConflicts: boolean;
    /** Existing database-advancement reread count. */
    readonly incomingRetry: number;
    readonly operation?: ReflectionOperationContext;
}
/** Candidate overwrite plan; the write stage must revalidate any returned snapshot. */
type IncomingStoragePreparation =
    | { kind: "complete"; result: FileReflectionResult }
    | { kind: "write"; snapshot: StorageSnapshot | undefined };
/**
 * Protect storage and apply one incoming database deletion.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param docEntry - Metadata whose deletion is being reflected.
 * @param existDoc - The storage file which still exists.
 * @param path - Captured incoming storage path.
 * @param settings - The original reflection settings snapshot.
 * @param force - Existing force policy.
 * @param allowExistingConflicts - Whether the incoming revision was explicitly selected.
 * @param incomingRetry - Database-advancement rereads already consumed.
 * @returns Whether deletion completed or preservation safely prevented it.
 * @remarks The caller holds the document lock. Every final storage/provenance recheck remains adjacent to deletion in this stage.
 */
async function applyIncomingDeletion(
    ctx: FileHandlerContext,
    docEntry: MetaEntry,
    existDoc: UXFileInfoStub,
    path: FilePathWithPrefix,
    settings: ObsidianLiveSyncSettings,
    force: boolean | undefined,
    allowExistingConflicts: boolean,
    incomingRetry: number,
    operation?: ReflectionOperationContext
): Promise<FileReflectionResult> {
    let safeDeletionSnapshot: StorageSnapshot | undefined;
    if (!force && !settings.writeDocumentsIfConflicted) {
        let protection = await preserveUnsyncedStorageAsConflict(ctx, path, existDoc, docEntry, undefined);
        if (protection.preserved) {
            return FILE_REFLECTION_POLICY;
        }
        if (
            !protection.snapshot ||
            !(await currentStorageSnapshotMatches(ctx, protection.snapshot.file, protection.snapshot.revision))
        ) {
            protection = await recheckIncomingStorage(ctx, path, docEntry, undefined, allowExistingConflicts);
            if (protection.preserved) {
                return FILE_REFLECTION_POLICY;
            }
            if (
                !protection.snapshot ||
                !(await currentStorageSnapshotMatches(ctx, protection.snapshot.file, protection.snapshot.revision))
            ) {
                throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
            }
        }
        safeDeletionSnapshot = protection.snapshot;
    }
    let latest = await reconcileAdvancedIncomingRevision(
        ctx,
        docEntry,
        path,
        force,
        allowExistingConflicts,
        incomingRetry,
        operation
    );
    if (latest !== undefined) return latest;
    if (
        safeDeletionSnapshot &&
        !(await currentStorageSnapshotMatches(ctx, safeDeletionSnapshot.file, safeDeletionSnapshot.revision))
    ) {
        const protection = await recheckIncomingStorage(ctx, path, docEntry, undefined, allowExistingConflicts);
        if (protection.preserved) {
            return FILE_REFLECTION_POLICY;
        }
        if (
            !protection.snapshot ||
            !(await currentStorageSnapshotMatches(ctx, protection.snapshot.file, protection.snapshot.revision))
        ) {
            throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
        }
        safeDeletionSnapshot = protection.snapshot;
        latest = await reconcileAdvancedIncomingRevision(
            ctx,
            docEntry,
            path,
            force,
            allowExistingConflicts,
            incomingRetry,
            operation
        );
        if (latest !== undefined) return latest;
        if (!(await currentStorageSnapshotMatches(ctx, safeDeletionSnapshot.file, safeDeletionSnapshot.revision))) {
            throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
        }
    }
    if (operation?.checkpoint?.() === false) {
        return FILE_REFLECTION_CANCELLED;
    }
    await ctx.host.storage().deleteVaultItem(path);
    await deleteProvenance(ctx, path);
    return FILE_REFLECTION_COMPLETED;
}

/**
 * Apply a permitted filename case change without crossing a distinct identity or parent directory.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param existDoc - The current file using another path spelling.
 * @param path - The incoming target spelling.
 * @param settings - The original reflection settings snapshot.
 * @returns The original or renamed file, or false after a path safety refusal.
 * @remarks The caller holds the document lock. Renaming and clearing the old provenance retain their existing order.
 */
async function reconcileStoragePath(
    ctx: FileHandlerContext,
    existDoc: UXFileInfoStub,
    path: FilePathWithPrefix,
    settings: ObsidianLiveSyncSettings
): Promise<UXFileInfoStub | false> {
    const [existingDocumentId, targetDocumentId] = await Promise.all([
        ctx.path.path2id(existDoc.path),
        ctx.path.path2id(path),
    ]);
    if (existingDocumentId !== targetDocumentId) {
        ctx.host.log(
            `Refusing to overwrite ${existDoc.path} while applying the distinct path ${path}`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }
    const pathNormalizationVersion = getPathNormalizationVersion(settings);
    const sameNormalisedPath =
        pathNormalizationVersion === 1 &&
        normalisePathForIdentity(existDoc.path, pathNormalizationVersion) ===
            normalisePathForIdentity(path, pathNormalizationVersion);
    if (!sameNormalisedPath) {
        const existingParent = getParentPath(existDoc.path);
        const targetParent = getParentPath(path);
        const sameNormalisedParent =
            pathNormalizationVersion === 1 &&
            normalisePathForIdentity(existingParent, pathNormalizationVersion) ===
                normalisePathForIdentity(targetParent, pathNormalizationVersion);
        if (existingParent !== targetParent && !sameNormalisedParent) {
            ctx.host.log(
                `Refusing to apply a filename case change across differently cased parent directories: ${existDoc.path} -> ${path}`,
                LOG_LEVEL_NOTICE
            );
            return false;
        }
        const renamedFile = await ctx.host.storage().renameFile(existDoc, path);
        if (!renamedFile) {
            ctx.host.log(`Could not apply the stored filename case: ${existDoc.path} -> ${path}`, LOG_LEVEL_NOTICE);
            return false;
        }
        await deleteProvenance(ctx, existDoc.path);
        existDoc = renamedFile;
    }
    return existDoc;
}

/**
 * Recognise unchanged storage or prepare an overwrite-protection candidate.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param write - The captured inputs for this reflection attempt.
 * @returns Completion for a safe skip, or a candidate requiring final revalidation before writing.
 * @remarks The caller holds the document lock. A returned snapshot is never a certificate that storage may now be overwritten.
 */
async function prepareIncomingStorageWrite(
    ctx: FileHandlerContext,
    write: IncomingStorageWrite
): Promise<IncomingStoragePreparation> {
    const { existDoc, force, allowExistingConflicts, docRead } = write;
    if (allowExistingConflicts && existDoc && !force && (await acceptMatchingSelectedContent(ctx, write, existDoc))) {
        return { kind: "complete", result: FILE_REFLECTION_COMPLETED };
    }
    if (existDoc && !force) return await prepareExistingStorageWrite(ctx, write, existDoc);
    ctx.host.log(`File ${docRead.path} ${existDoc ? "(new) " : ""} ${force ? " (forced)" : ""}`, LOG_LEVEL_VERBOSE);
    return { kind: "write", snapshot: undefined };
}

/**
 * Revalidate a candidate, write incoming bytes, and publish matching provenance.
 * @param ctx - Captured services, per-instance state, and dynamic public host seams.
 * @param write - The captured inputs and settings for this reflection attempt.
 * @param safeSnapshot - The overwrite-protection candidate, which remains subject to final revalidation.
 * @returns Completion or policy hand-off after preservation or advanced-revision reconciliation; incomplete work rejects.
 * @remarks The caller holds the document lock. The last recheck and write remain in this stage; physical writes retain the original touched/event/best-effort-provenance order.
 */
async function commitIncomingStorageWrite(
    ctx: FileHandlerContext,
    write: IncomingStorageWrite,
    safeSnapshot: StorageSnapshot | undefined
): Promise<FileReflectionResult> {
    const {
        docEntry,
        docRead,
        docData,
        reflectedContent,
        reflectedEvidence,
        path,
        mode,
        force,
        allowExistingConflicts,
        incomingRetry,
        operation,
    } = write;
    await ctx.host.storage().ensureDir(path);
    if (safeSnapshot && !(await currentStorageSnapshotMatches(ctx, safeSnapshot.file, safeSnapshot.revision))) {
        const protection = await recheckIncomingStorage(ctx, path, docEntry, docData, allowExistingConflicts);
        if (protection.preserved) {
            return FILE_REFLECTION_POLICY;
        }
        if (
            !protection.snapshot ||
            !(await currentStorageSnapshotMatches(ctx, protection.snapshot.file, protection.snapshot.revision))
        ) {
            throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
        }
        safeSnapshot = protection.snapshot;
    }
    const latest = await reconcileAdvancedIncomingRevision(
        ctx,
        docEntry,
        path,
        force,
        allowExistingConflicts,
        incomingRetry,
        operation
    );
    if (latest !== undefined) return latest;
    if (safeSnapshot && !(await currentStorageSnapshotMatches(ctx, safeSnapshot.file, safeSnapshot.revision))) {
        throw new IncompleteFileReflectionError("Reflection could not establish a safe current result");
    }
    if (operation?.checkpoint?.() === false) {
        return FILE_REFLECTION_CANCELLED;
    }
    const ret = await ctx.host.storage().writeFileAuto(path, docData, { ctime: docRead.ctime, mtime: docRead.mtime });
    await ctx.host.storage().touched(path);
    ctx.host.storage().triggerFileEvent(mode, path);
    if (ret && ctx.provenance) {
        const storedStat = await ctx.host.storage().stat(path);
        // A host may update provenance outside the handler's document lock.
        // Preserve that newer branch identity. A plain user edit leaves the
        // record unchanged, so the written revision remains its correct base.
        if (safeSnapshot && !sameProvenance(await readProvenanceSnapshot(ctx, path), safeSnapshot.revision)) {
            return FILE_REFLECTION_COMPLETED;
        }
        await setProvenance(ctx, path, docEntry._rev, storedStat?.mtime, reflectedContent, reflectedEvidence);
    }
    if (!ret) {
        throw new IncompleteFileReflectionError("Storage rejected the reflected write");
    }
    return FILE_REFLECTION_COMPLETED;
}

/**
 * Recognise an explicitly selected conflict leaf whose bytes already match storage.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param write - The captured incoming revision, content, and original settings snapshot.
 * @param current - The current non-folder storage observation.
 * @returns Whether matching content was certified and equivalent timestamps were recorded.
 * @remarks The caller holds the document lock. The comparison and its provenance effect stay together without an intervening stage.
 */
async function acceptMatchingSelectedContent(
    ctx: FileHandlerContext,
    write: IncomingStorageWrite,
    current: UXFileInfoStub
): Promise<boolean> {
    const { docEntry, docRead, docData, reflectedContent, reflectedEvidence, path } = write;
    const existDoc = current;
    const readFile = await ctx.host.readFileFromStub(existDoc);
    if (await isDocContentSame(docData, readFile.body)) {
        await setProvenance(ctx, path, docEntry._rev, existDoc.stat.mtime, reflectedContent, reflectedEvidence);
        ctx.path.markChangesAreSame(docRead, docRead.mtime, existDoc.stat.mtime);
        return true;
    }
    return false;
}

/**
 * Compare an existing file before deciding whether incoming overwrite protection is needed.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param write - The captured incoming revision, content, and original settings snapshot.
 * @param current - The current non-folder storage observation.
 * @returns Completion for unchanged bytes, or the preparation produced by preservation.
 * @remarks Freshness, optional content reading, timestamp equivalence, and unchanged provenance retain their existing order.
 */
async function prepareExistingStorageWrite(
    ctx: FileHandlerContext,
    write: IncomingStorageWrite,
    current: UXFileInfoStub
): Promise<IncomingStoragePreparation> {
    const { docEntry, docRead, docData, reflectedContent, reflectedEvidence, path } = write;
    const existDoc = current;
    let shouldApplied = false;
    const freshness = ctx.path.compareFileFreshness(existDoc, docEntry);
    if (freshness !== EVEN) {
        shouldApplied = true;
    }
    if (!shouldApplied) {
        const readFile = await ctx.host.readFileFromStub(existDoc);
        if (await isDocContentSame(docData, readFile.body)) {
            // The content is same. So, we do not need to update the file.
            shouldApplied = false;
            // Timestamp is different but the content is same. therefore, two timestamps should be handled as same.
            // So, mark the changes are same.
            ctx.path.markChangesAreSame(docRead, docRead.mtime, existDoc.stat.mtime);
        } else {
            shouldApplied = true;
        }
    }
    if (!shouldApplied) {
        await setProvenance(ctx, path, docEntry._rev, existDoc.stat.mtime, reflectedContent, reflectedEvidence);
        ctx.host.log(`File ${docRead.path} is not changed`, LOG_LEVEL_VERBOSE);
        return { kind: "complete", result: FILE_REFLECTION_COMPLETED };
    }

    return await prepareIncomingStorageProtection(ctx, write, current);
}

/**
 * Preserve potentially unsaved bytes or return a candidate for later overwrite validation.
 * @param ctx - Captured services, instance state, and dynamic public seams.
 * @param write - The captured incoming revision, content, and original settings snapshot.
 * @param current - The current non-folder storage observation.
 * @returns A preservation completion, a refusal, or a snapshot candidate for the final commit stage.
 * @remarks This stage is effectful: preservation may write branches and provenance. A returned candidate never authorises a write without the commit-stage rechecks.
 */
async function prepareIncomingStorageProtection(
    ctx: FileHandlerContext,
    write: IncomingStorageWrite,
    current: UXFileInfoStub
): Promise<IncomingStoragePreparation> {
    const { docEntry, docData, path, settings, force, allowExistingConflicts } = write;
    const existDoc = current;
    if (force || settings.writeDocumentsIfConflicted) return { kind: "write", snapshot: undefined };

    let protection = await preserveUnsyncedStorageAsConflict(ctx, path, existDoc, docEntry, docData);
    if (protection.preserved) {
        return { kind: "complete", result: FILE_REFLECTION_POLICY };
    }
    if (!protection.snapshot) {
        protection = await recheckIncomingStorage(ctx, path, docEntry, docData, allowExistingConflicts);
        if (protection.preserved) {
            return { kind: "complete", result: FILE_REFLECTION_POLICY };
        }
        if (!protection.snapshot) {
            throw new IncompleteFileReflectionError("Storage changed during overwrite protection");
        }
    }
    return { kind: "write", snapshot: protection.snapshot };
}
