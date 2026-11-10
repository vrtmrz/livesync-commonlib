import { Semaphore, withSemaphore, type SemaphoreObject } from "octagonal-wheels/concurrency/semaphore";
import { TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import type { FilePathWithPrefix, LoadedEntry, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";
import { isDocContentSame, readContent } from "@lib/common/utils";
import type { DeletionRecoveryResult } from "@lib/interfaces/FileHandler";
import type { FileReflectionProvenanceRecord } from "@lib/interfaces/FileReflectionProvenance";
import { isFilePath } from "@lib/string_and_binary/path";
import type { FileHandlerContext } from "./context";
import { withFileEventPaths } from "./locking";
import {
    contentEvidence,
    getProvenancePath,
    hasContentHash,
    readProvenanceSnapshot,
    sameProvenance,
} from "./provenance";
import { isCurrentFileSelected, isCurrentPathSelected } from "./selection";
import { isFolderInfo } from "./storage";

/** Recovery operations sharing one Vault's provenance service share this admission limit. */
const recoveryPermits = new WeakMap<object, SemaphoreObject>();

/** Observations retained for one bounded attempt, without durable retry state. */
interface RecoveryAttempt {
    readonly ctx: FileHandlerContext;
    readonly expected: MetaEntry;
    path: FilePathWithPrefix;
    file: DeletionRecoveryResult["file"];
    provenance: DeletionRecoveryResult["provenance"];
    phase: string;
    warning?: string;
    error?: unknown;
}

type RecoveryProgress = Partial<Omit<RecoveryAttempt, "ctx" | "expected">>;

/**
 * Record one stage transition and its observations on the shared attempt.
 * @param attempt - This operation's live record, also read by the outer failure boundary.
 * @param progress - Newly observed effects or diagnostics; fixed inputs cannot be replaced.
 * @remarks Keep the same record across awaited stages so a later exception cannot
 * erase already-observed removal or cleanup. This update performs no I/O.
 */
function progressAttempt(attempt: RecoveryAttempt, progress: RecoveryProgress): void {
    Object.assign(attempt, progress);
}

/**
 * Verify and recover one retained logical deletion without creating revision history.
 * @param ctx - Captured services, state, and dynamic host boundaries.
 * @param expected - The exact logical deletion selected by the ordinary scan.
 * @param cleanupOnly - Require current absence and clear bookkeeping without reading or deleting a file.
 * @returns Separate observed file, provenance, and completion outcomes, including verification failures.
 * @remarks A shared three-operation permit precedes the document lock and all I/O. The lock
 * excludes other handlers, while final observations conservatively detect external changes.
 */
export async function recoverDatabaseDeletion(
    ctx: FileHandlerContext,
    expected: MetaEntry,
    cleanupOnly = false
): Promise<DeletionRecoveryResult> {
    const attempt: RecoveryAttempt = {
        ctx,
        expected,
        path: expected.path,
        file: "unknown",
        provenance: "unchanged",
        phase: "admission",
    };
    // Without key discovery, a later scan could not reliably find interrupted cleanup.
    if (!ctx.provenance?.listPaths) return outcome(attempt, "deferred", "capability-unavailable");
    let semaphore = recoveryPermits.get(ctx.provenance);
    if (!semaphore) {
        semaphore = Semaphore(3);
        recoveryPermits.set(ctx.provenance, semaphore);
    }
    try {
        return await withSemaphore(semaphore, () => {
            progressAttempt(attempt, { path: ctx.host.getPath(expected) });
            return withFileEventPaths(ctx, [attempt.path], () => recoverUnderLock(attempt, cleanupOnly));
        });
    } catch (error) {
        return { ...outcome(attempt, "failed", `${attempt.phase}-failed`), error };
    }
}

/**
 * Capture current selection, deletion, storage, and strict provenance under the document lock.
 * @param attempt - This attempt's expected revision and observed effects.
 * @param cleanupOnly - Whether only an absent target may be processed.
 * @returns A conservative deferral, a verification failure, or the final storage/cleanup result.
 * @remarks No fallback classifier, preservation branch, provenance publication, or retry is used.
 */
async function recoverUnderLock(attempt: RecoveryAttempt, cleanupOnly: boolean): Promise<DeletionRecoveryResult> {
    const { ctx, expected, path } = attempt;
    progressAttempt(attempt, { phase: "eligibility" });
    // Admit only retained ordinary deletions addressed to this exact path.
    if (!validDeletion(expected) || !isFilePath(path) || (await ctx.path.path2id(path)) !== expected._id) {
        return outcome(attempt, "deferred", "invalid-deletion");
    }
    // Selection and the winning revision may have changed while this attempt waited for admission.
    if (!(await isCurrentPathSelected(ctx, path))) return outcome(attempt, "deferred", "not-selected");
    if (!(await sameCurrentDeletion(attempt))) return outcome(attempt, "deferred", "database-changed");
    const stub = await ctx.host.storage().getStub(path);
    progressAttempt(attempt, {
        file: stub === null ? "absent" : "present",
        provenance: stub === null ? "pending" : "unchanged",
    });
    // A replacement folder or internal entry does not inherit permission to delete the original file.
    if (isFolderInfo(stub)) return outcome(attempt, "deferred", "storage-identity-changed");
    if (stub !== null && (stub.isInternal || stub.path !== path)) {
        return outcome(attempt, "deferred", "storage-identity-changed");
    }
    // An absent-file retry must preserve any file recreated since the previous attempt.
    if (cleanupOnly && stub !== null) return outcome(attempt, "deferred", "file-present");
    if (
        stub &&
        (!(await isCurrentFileSelected(ctx, stub)) || ctx.path.compareFileFreshness(stub, expected) !== TARGET_IS_NEW)
    ) {
        return outcome(attempt, "deferred", "file-not-eligible");
    }
    // Absence permits bookkeeping cleanup, never a second physical deletion.
    progressAttempt(attempt, { phase: "provenance-read" });
    const record = await readProvenanceSnapshot(ctx, path, true);
    if (!stub) return await clearAbsentProvenance(attempt, record);
    // Unknown content has no safe base; keep it instead of manufacturing revision history.
    if (!record?.revision) return outcome(attempt, "deferred", "provenance-missing");
    // A size mismatch already disproves unchanged content and avoids a body read.
    if (hasContentHash(record) && record.contentSize !== stub.stat.size) {
        return outcome(attempt, "deferred", "content-size-mismatch");
    }
    return await verifyPresentFile(attempt, { ...stub, stat: { ...stub.stat } }, record);
}

/**
 * Compare recorded evidence using one captured current body and one final body recheck.
 * @param attempt - The locked recovery attempt.
 * @param stub - The fresh selected file observation.
 * @param record - Strictly read provenance for that observation.
 * @returns A failure/deferral, or the observed effect of guarded removal and cleanup.
 * @remarks Legacy evidence reads only its exact base through the normal Chunk delivery policy.
 * An unavailable base is failed verification because the compatibility boundary may hide I/O errors.
 */
async function verifyPresentFile(
    attempt: RecoveryAttempt,
    stub: UXFileInfoStub,
    record: FileReflectionProvenanceRecord
): Promise<DeletionRecoveryResult> {
    const { ctx, path } = attempt;
    let base: LoadedEntry | false | undefined;
    // Legacy records need their exact base; the normal Fetcher retains control of remote Chunk access.
    if (!hasContentHash(record)) {
        progressAttempt(attempt, { phase: "base-read" });
        base = await ctx.host.db().fetchEntry(path, record.revision, true, true, false);
        if (!base) return outcome(attempt, "failed", "base-unavailable");
        if (base._rev !== record.revision || base.deleted || base._deleted || ctx.host.getPath(base) !== path) {
            return outcome(attempt, "deferred", "base-not-usable");
        }
    }
    progressAttempt(attempt, { phase: "body-read" });
    const observed = await ctx.host.readFileFromStub(stub);
    const file: UXFileInfo = { ...observed, stat: { ...observed.stat } };
    if (!sameFileObservation(stub, file)) return outcome(attempt, "deferred", "storage-changed");
    // A recorded content hash proves the saved bytes without relying on revision retention.
    if (hasContentHash(record)) {
        progressAttempt(attempt, { phase: "content-hash" });
        const evidence = await contentEvidence(ctx, file.body);
        if (!evidence.contentHash) return outcome(attempt, "failed", "content-hash-unavailable");
        if (evidence.contentSize !== record.contentSize || evidence.contentHash !== record.contentHash) {
            return outcome(attempt, "deferred", "content-hash-mismatch");
        }
    } else if (!base || !(await isDocContentSame(readContent(base), file.body))) {
        return outcome(attempt, "deferred", "base-content-mismatch");
    }
    base = undefined;
    // The first read proves only a snapshot; recheck bytes and identity before removing anything.
    progressAttempt(attempt, { phase: "final-verification" });
    const latest = await ctx.host.storage().getStub(path);
    if (!latest || isFolderInfo(latest) || !sameFileObservation(latest, file)) {
        progressAttempt(attempt, { file: latest === null ? "absent" : "present", provenance: "unchanged" });
        return outcome(attempt, "deferred", "storage-changed");
    }
    const readFinal = await ctx.host.readFileFromStub(latest);
    const final = { ...readFinal, stat: { ...readFinal.stat } };
    if (!sameFileObservation(final, file) || !(await isDocContentSame(final.body, file.body))) {
        return outcome(attempt, "deferred", "storage-changed");
    }
    // A new base, database winner, conflict, or selection invalidates the earlier content proof.
    if (!sameProvenance(await readProvenanceSnapshot(ctx, path, true), record)) {
        return outcome(attempt, "deferred", "provenance-changed");
    }
    if (!(await sameCurrentDeletion(attempt))) return outcome(attempt, "deferred", "database-changed");
    if (!(await isCurrentFileSelected(ctx, final))) return outcome(attempt, "deferred", "not-selected");
    if (ctx.path.compareFileFreshness(final, attempt.expected) !== TARGET_IS_NEW) {
        return outcome(attempt, "deferred", "file-not-eligible");
    }
    // Keep the final path/type/stat observation adjacent to the destructive boundary.
    const target = await ctx.host.storage().getStub(path);
    if (!target || isFolderInfo(target) || !sameFileObservation(target, file)) {
        progressAttempt(attempt, { file: target === null ? "absent" : "present", provenance: "unchanged" });
        return outcome(attempt, "deferred", "storage-changed");
    }
    return await removeAndConfirm(attempt, record);
}

/**
 * Remove once and establish its actual effect through a fresh storage lookup, including on error.
 * @param attempt - The fully verified operation under its document lock.
 * @param record - The provenance which must still match before cleanup.
 * @returns Observed removal failure, unknown effect, or absent-file cleanup result.
 * @remarks A thrown adapter/parent-cleanup error does not undo a confirmed removal. No physical retry occurs.
 */
async function removeAndConfirm(
    attempt: RecoveryAttempt,
    record: FileReflectionProvenanceRecord
): Promise<DeletionRecoveryResult> {
    const { ctx, path } = attempt;
    // An adapter can throw after removal; preserve evidence until a fresh lookup establishes its effect.
    progressAttempt(attempt, { phase: "remove", file: "unknown", provenance: "pending" });
    try {
        await ctx.host.storage().deleteVaultItem(path);
    } catch (error) {
        progressAttempt(attempt, { error, warning: "storage-post-removal-error" });
    }
    progressAttempt(attempt, { phase: "removal-verification" });
    const current = await ctx.host.storage().getStub(path);
    // The adapter outcome does not prove absence; retain evidence while the target remains.
    if (current !== null) {
        progressAttempt(attempt, { file: "present", provenance: "unchanged", warning: undefined });
        return outcome(attempt, "failed", attempt.error ? "removal-failed" : "removal-no-effect");
    }
    progressAttempt(attempt, { file: "absent", provenance: "pending" });
    return await clearAbsentProvenance(attempt, record);
}

/**
 * Clear only the unchanged provenance of an absent, still-deleted, conflict-free target.
 * @param attempt - An operation which has observed absence under its document lock.
 * @param record - The fresh raw record captured for this attempt, never an enumerated key snapshot.
 * @returns Complete cleanup, conservative deferral, or a propagated failure reported by the outer boundary.
 * @remarks Strict reads and deletion preserve partial outcomes; no body or physical deletion is requested.
 */
async function clearAbsentProvenance(
    attempt: RecoveryAttempt,
    record: FileReflectionProvenanceRecord | undefined
): Promise<DeletionRecoveryResult> {
    const { ctx, path } = attempt;
    // Cleanup belongs to this exact deletion and provenance, including after a restart.
    progressAttempt(attempt, { phase: "provenance-cleanup" });
    if (!(await isCurrentPathSelected(ctx, path))) return outcome(attempt, "deferred", "not-selected");
    if (!(await sameCurrentDeletion(attempt))) return outcome(attempt, "deferred", "database-changed");
    const latest = await readProvenanceSnapshot(ctx, path, true);
    if (!sameProvenance(latest, record)) return outcome(attempt, "deferred", "provenance-changed");
    const target = await ctx.host.storage().getStub(path);
    // A recreated file must retain its own provenance even after an earlier removal succeeded.
    if (target !== null) {
        progressAttempt(attempt, { file: "present", provenance: "unchanged" });
        return outcome(attempt, "deferred", "file-recreated");
    }
    if (latest) await ctx.provenance!.delete(getProvenancePath(ctx, path));
    progressAttempt(attempt, { file: "absent", provenance: "cleared" });
    return outcome(attempt, "applied", "deletion-confirmed");
}

/**
 * Revalidate the exact winning logical deletion and separately query current conflicts.
 * @param attempt - The locked expected revision and target identity.
 * @returns Whether that deletion is still current, selected by identity, and conflict-free.
 * @remarks Revision identity compares database Metadata, not filesystem times.
 * Freshness rounding belongs to the path service. Matching revisions alone cannot
 * rule out a concurrently replicated conflict leaf.
 */
async function sameCurrentDeletion({ ctx, expected, path }: RecoveryAttempt): Promise<boolean> {
    const current = await ctx.host.db().fetchEntryMeta(path, undefined, true);
    // A restoration, tombstone, or malformed result is not this retained logical deletion.
    if (!current || !validDeletion(current)) return false;

    // Database revisions are immutable. Rechecking their mtime/size adds no identity evidence.
    if (current._id !== expected._id || current._rev !== expected._rev) return false;

    // Lookup can reconstruct the path; compare the host-resolved identity, not its stored spelling.
    if (ctx.host.getPath(current) !== path) return false;
    // Path settings can change during an awaited stage, so retain the current ID mapping check.
    if ((await ctx.path.path2id(path)) !== current._id) return false;

    // A new conflict leaf need not change the winning revision returned above.
    return (await ctx.host.db().getConflictedRevs(path)).length === 0;
}

/**
 * Reject tombstones, internal records, malformed Metadata, and already-conflicted observations.
 * @param entry - Metadata presented by the scanner or current database lookup.
 * @returns Whether the observation is a retained ordinary logical deletion.
 * @remarks This pure check certifies neither currentness nor content equality.
 */
function validDeletion(entry: MetaEntry): boolean {
    return (
        !!entry._id &&
        !!entry._rev &&
        entry.deleted === true &&
        !entry._deleted &&
        ["notes", "plain", "newnote"].includes(entry.type) &&
        Array.isArray(entry.children) &&
        Number.isFinite(entry.mtime) &&
        Number.isFinite(entry.ctime) &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        !entry._conflicts?.length
    );
}

/**
 * Compare raw path and file statistics without treating equal statistics as content evidence.
 * @param left - Fresh file observation.
 * @param right - Previously captured file observation.
 * @returns Whether both observations retain the same ordinary-file identity and raw statistics.
 * @remarks These are raw observations through the same host, not a freshness
 * comparison. Rounding could hide an intervening stat change. Callers also compare
 * exact body bytes before permitting removal.
 */
function sameFileObservation(left: UXFileInfoStub, right: UXFileInfoStub): boolean {
    return (
        !left.isInternal &&
        !left.isFolder &&
        left.path === right.path &&
        left.stat.type === "file" &&
        left.stat.mtime === right.stat.mtime &&
        left.stat.ctime === right.stat.ctime &&
        left.stat.size === right.stat.size
    );
}

/**
 * Project the current observed effects without inferring completion from a resolved storage call.
 * @param attempt - The current operation observations and diagnostic phase.
 * @param status - Overall completion, conservative deferral, or verification/removal failure.
 * @param reason - Stable diagnostic reason for the caller's aggregate report.
 * @returns The structured result; no I/O or bookkeeping mutation occurs.
 * @throws If the observed effects and requested status contradict the result contract.
 */
function outcome(
    attempt: RecoveryAttempt,
    status: DeletionRecoveryResult["status"],
    reason: string
): DeletionRecoveryResult {
    const diagnostics = {
        reason,
        phase: attempt.phase,
        ...(attempt.warning ? { warning: attempt.warning } : {}),
        ...(attempt.error ? { error: attempt.error } : {}),
    };
    const { file, provenance } = attempt;
    // Completion requires observed absence and cleanup; failures retain the actual effects.
    if (file === "absent" && provenance === "cleared" && status !== "deferred") {
        return { ...diagnostics, status, file, provenance };
    }
    if (provenance === "unchanged" && status !== "applied") {
        return { ...diagnostics, status, file, provenance };
    }
    if (provenance === "pending" && status !== "applied") {
        if (file === "absent") return { ...diagnostics, status, file, provenance };
        if (file === "unknown" && status === "failed") return { ...diagnostics, status, file, provenance };
    }
    throw new Error("Inconsistent deletion recovery outcome");
}
