// `$` prefix is no longer meaningful, will be removed in the future.
export interface Rebuilder {
    $performRebuildDB(
        method: "localOnly" | "remoteOnly" | "rebuildBothByThisDevice" | "localOnlyWithChunks"
    ): Promise<void>;
    $rebuildRemote(): Promise<void>;
    $rebuildEverything(): Promise<void>;
    $fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean): Promise<void>;

    scheduleRebuild(): Promise<void>;
    scheduleFetch(): Promise<void>;
}
