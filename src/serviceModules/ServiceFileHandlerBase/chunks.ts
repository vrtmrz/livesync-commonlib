import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import { shouldBeIgnored } from "@lib/string_and_binary/path";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";

import type { FileHandlerContext } from "./context";

/**
 * Repair missing chunks with at most ten acquired file operations at a time.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param showingNotice - Whether progress uses notice-level messages instead of informational messages.
 * @returns Completion after all selected tasks settle. Per-file save errors are logged and swallowed; listing, selection, acquisition, progress, or logger failures can still reject.
 * @remarks Each file uses the dynamic public save seam and its document lock. Up to ten permits are acquired; progress remains before the original guarded body, preserving its existing cleanup semantics.
 */
export async function createAllChunks(ctx: FileHandlerContext, showingNotice?: boolean): Promise<void> {
    ctx.host.log("Collecting local files on the storage", LOG_LEVEL_VERBOSE);
    const semaphore = Semaphore(10);

    let processed = 0;
    const filesStorageSrc = await ctx.host.storage().getFiles();
    /**
     * Advance the existing progress counter at its original permit boundary.
     * @returns Completion without a value.
     * @remarks A throwing progress logger retains its existing propagation and cleanup boundary.
     */
    const incProcessed = () => {
        processed++;
        if (processed % 25 == 0)
            ctx.host.log(
                `Creating missing chunks: ${processed} of ${total} files`,
                showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
                "chunkCreation"
            );
    };
    const total = filesStorageSrc.length;
    const procAllChunks = filesStorageSrc.map(async (file) => {
        if (!(await ctx.vault.isTargetFile(file))) {
            incProcessed();
            return true;
        }
        if (ctx.vault.isFileSizeTooLarge(file.stat.size)) {
            incProcessed();
            return true;
        }
        if (shouldBeIgnored(file.path)) {
            incProcessed();
            return true;
        }
        const release = await semaphore.acquire();
        incProcessed();
        try {
            await ctx.host.storeFileToDB(file, false, true);
        } catch (ex) {
            ctx.host.log(ex, LOG_LEVEL_VERBOSE);
        } finally {
            release();
        }
    });
    await Promise.all(procAllChunks);
    ctx.host.log(
        `Creating chunks Done: ${processed} of ${total} files`,
        showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
        "chunkCreation"
    );
}
