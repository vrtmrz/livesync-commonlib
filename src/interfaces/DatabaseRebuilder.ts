// `$` prefix is no longer meaningful, will be removed in the future.
export interface Rebuilder {
    $performRebuildDB(
        method: "localOnly" | "remoteOnly" | "rebuildBothByThisDevice" | "localOnlyWithChunks"
    ): Promise<void>;
    $rebuildRemote(): Promise<void>;
    $rebuildEverything(): Promise<void>;
    $fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean): Promise<void>;
    $fetchLocalDBFast(autoResume: boolean): Promise<void>;

    /**
     * Writes the Rebuild flag, suspends the current runtime, optionally prepares
     * persisted state, and requests a restart, in that order.
     *
     * The preparation callback runs only after the flag exists. If it fails,
     * the flag is removed, the current runtime is resumed, and the error is
     * rethrown. A false result means that the flag could not be written and no
     * restart was requested.
     */
    scheduleRebuild(prepareBeforeRestart?: () => Promise<void>): Promise<boolean>;
    /** See {@link scheduleRebuild}; this variant writes the Fetch flag. */
    scheduleFetch(prepareBeforeRestart?: () => Promise<void>): Promise<boolean>;
    /**
     * Declares the finish of the rebuild process and unlock remote, resume reflecting the changes.
     */
    finishRebuild(): Promise<void>;
}
