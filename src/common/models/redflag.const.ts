import type { FilePath } from "./db.type";

export const PREFIXMD_LOGFILE = "livesync_log_";
export const PREFIXMD_LOGFILE_UC = "LIVESYNC_LOG_";

export const FlagFilesOriginal = {
    SUSPEND_ALL: "redflag.md" as FilePath,
    REBUILD_ALL: "redflag2.md" as FilePath,
    FETCH_ALL: "redflag3.md" as FilePath,
} as const;

export const FlagFilesHumanReadable = {
    REBUILD_ALL: "flag_rebuild.md" as FilePath,
    FETCH_ALL: "flag_fetch.md" as FilePath,
} as const;

/**
 * @deprecated Use `FlagFilesOriginal.SUSPEND_ALL` instead.
 */
export const FLAGMD_REDFLAG = FlagFilesOriginal.SUSPEND_ALL;
/**
 * @deprecated Use `FlagFilesHumanReadable.REBUILD_ALL` instead.
 */
export const FLAGMD_REDFLAG2 = FlagFilesOriginal.REBUILD_ALL;
/**
 * @deprecated Use `FlagFilesHumanReadable.FETCH_ALL` instead.
 */
export const FLAGMD_REDFLAG2_HR = FlagFilesHumanReadable.REBUILD_ALL;
/**
 * @deprecated Use `FlagFilesOriginal.FETCH_ALL` instead.
 */
export const FLAGMD_REDFLAG3 = FlagFilesOriginal.FETCH_ALL;
/**
 * @deprecated Use `FlagFilesHumanReadable.FETCH_ALL` instead.
 */
export const FLAGMD_REDFLAG3_HR = FlagFilesHumanReadable.FETCH_ALL;
