import { withLocks } from "octagonal-wheels/concurrency/lock";
import type { FilePathWithPrefix } from "@lib/common/types";

import type { FileHandlerContext, DeferredConflictCheck } from "./context";

/**
 * Serialise related document identities and deliver deferred conflict hooks after unlocking.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param eventPaths - All storage paths whose document identities must be locked.
 * @param callback - Work performed under the deduplicated, sorted document locks.
 * @typeParam T - The callback result returned after locks are released and deferred hooks have run.
 * @returns The callback result, unless its error or a later conflict-hook error must propagate.
 * @remarks Document IDs are deduplicated and sorted. Conflict hooks run after every lock is released; a callback failure retains precedence over hook failure.
 */
export async function withFileEventPaths<T>(
    ctx: FileHandlerContext,
    eventPaths: readonly FilePathWithPrefix[],
    callback: (isSameDocument: boolean) => Promise<T>
): Promise<T> {
    const documentIds = await Promise.all(eventPaths.map((eventPath) => ctx.path.path2id(eventPath)));
    const uniqueIds = [...new Set(documentIds)].sort();
    const lockKeys = uniqueIds.map((documentId) => `processFileEvent-${documentId}`);
    const pending: DeferredConflictCheck[] = [];
    let result!: T;
    let failed = false;
    let failure: unknown;
    try {
        result = await withLocks(lockKeys, async () => {
            for (const id of uniqueIds) ctx.state.deferredConflictChecks.set(id, pending);
            try {
                return await callback(documentIds.length === 2 && documentIds[0] === documentIds[1]);
            } finally {
                for (const id of uniqueIds) ctx.state.deferredConflictChecks.delete(id);
            }
        });
    } catch (ex) {
        failed = true;
        failure = ex;
    }
    // A conflict hook may synchronously await another operation on this
    // document. Invoke hooks only after every document lock is released;
    // the callback failure remains authoritative if a hook also fails.
    for (const check of pending) {
        try {
            if (check.ifOpen) await ctx.conflict.queueCheckForIfOpen(check.path);
            else await ctx.conflict.queueCheckFor(check.path);
        } catch (ex) {
            if (!failed) {
                failed = true;
                failure = ex;
            }
            break;
        }
    }
    if (failed) throw failure;
    return result;
}

/**
 * Defer conflict hooks within a document lock or deliver them immediately outside it.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param path - The affected file or provenance path.
 * @param ifOpen - Whether to request only an already-open conflict review.
 * @returns Completion after queueing or immediate hook delivery; immediate lookup or hook failures propagate.
 * @remarks This helper neither sorts identities nor acquires a lock. It appends to an existing per-document deferred queue, or invokes the selected hook immediately when no queue is active.
 */
export async function queueConflictCheckFor(
    ctx: FileHandlerContext,
    path: FilePathWithPrefix,
    ifOpen = false
): Promise<void> {
    const documentId = await ctx.path.path2id(path);
    const pending = ctx.state.deferredConflictChecks.get(documentId);
    if (pending) {
        pending.push({ path, ifOpen });
        return;
    }
    if (ifOpen) await ctx.conflict.queueCheckForIfOpen(path);
    else await ctx.conflict.queueCheckFor(path);
}
