import { unique } from "octagonal-wheels/collection";
import { withConcurrency } from "octagonal-wheels/iterable/map";
import { withLock } from "octagonal-wheels/concurrency/lock.scoped";
import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type MetaEntry,
    type FilePathWithPrefixLC,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { compareMTime } from "@lib/common/utils";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { stripAllPrefixes } from "@lib/string_and_binary/path";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { LogFunction } from "@lib/services/lib/logUtils";
import type { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { VaultScanResults, type VaultScanResult } from "@lib/services/base/VaultScanResult";
import { getPathFromEntry, convertCase } from "./paths";
import {
    fileStatus,
    loadFileStatus,
    flushFileStatus,
    saveFileStatus,
    updateFileMTimeInMap,
    getFileMTimeFromMap,
} from "./fileStatus";
import {
    collectFilesOnStorage,
    collectDatabaseFiles,
    updateToDatabase,
    updateToStorage,
    syncStorageAndDatabase,
} from "./files";
import {
    FullScanModes,
    ExtraOnLocal,
    ExtraOnRemote,
    FilePairProcessResults,
    type FullScanOptions,
    type FilePair,
    type FilePairState,
    type FilePairAction,
    type FilePairProcessResult,
} from "./types";

function isDeletedEntry(entry: MetaEntry): boolean {
    return entry.deleted || entry._deleted || false;
}

/**
 * Classify the storage and retained-Metadata observations of one pair.
 * @param pair - Selected observations from the shared scan collection.
 * @returns Their policy state without performing I/O or proving content equality.
 * @throws If neither side exists, violating the pair contract.
 */
export function getFilePairState(pair: FilePair): FilePairState {
    const { file, doc } = pair;
    if (file && doc) {
        return isDeletedEntry(doc) ? "both-db-deleted" : "both";
    }
    if (file) {
        return "storage-only";
    }
    if (doc) {
        return isDeletedEntry(doc) ? "db-only-deleted" : "db-only";
    }
    throw new Error("Corrupted file pair");
}

function shouldDeleteLocalWhenRemoteMissing(options: FullScanOptions): boolean {
    return (
        options.extraOnRemote === ExtraOnRemote.DELETE_LOCAL_MISSING ||
        options.extraOnLocal === ExtraOnLocal.DELETE_DB_MISSING
    );
}

function shouldDeleteLocalWhenRemoteDeleted(options: FullScanOptions): boolean {
    return (
        options.extraOnRemote === ExtraOnRemote.DELETE_LOCAL_MISSING ||
        options.extraOnLocal === ExtraOnLocal.DELETE_DB_DELETED ||
        options.extraOnLocal === ExtraOnLocal.DELETE_DB_MISSING
    );
}

/**
 * Select the existing action matrix without performing the action.
 * @param state - Classified storage/database presence and deletion state.
 * @param options - Scan mode and explicit extra-file policies.
 * @returns The ordinary action for this policy combination.
 * @remarks Guarded deletion recovery is selected separately by the scan plan;
 * this matrix retains its established explicit extra-file policies.
 */
export function resolveFilePairAction(state: FilePairState, options: FullScanOptions): FilePairAction {
    switch (options.mode) {
        case FullScanModes.DB_APPLY:
            switch (state) {
                case "both":
                case "db-only":
                    return "update-storage";
                case "storage-only":
                    return shouldDeleteLocalWhenRemoteMissing(options) ? "delete-local" : "skip";
                case "both-db-deleted":
                    return shouldDeleteLocalWhenRemoteDeleted(options) ? "delete-local" : "skip";
                case "db-only-deleted":
                    return "skip";
            }
            break;
        case FullScanModes.NEWER_WINS:
            switch (state) {
                case "both":
                    return "sync-newer";
                case "storage-only":
                    return shouldDeleteLocalWhenRemoteMissing(options) ? "delete-local" : "update-db";
                case "db-only":
                    return "update-storage";
                case "both-db-deleted":
                    if (shouldDeleteLocalWhenRemoteDeleted(options)) {
                        return "delete-local";
                    }
                    return options.extraOnLocal === ExtraOnLocal.APPEND_STORAGE_ONLY ? "update-db" : "skip";
                case "db-only-deleted":
                    return "skip";
            }
            break;
    }
    return "skip";
}

/**
 * Process a single file pair based on the determined action from the file pair state and scan options.
 */
async function processFilePair(
    host: NecessaryServices<"setting" | "vault" | "path" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    pair: FilePair,
    options: FullScanOptions
): Promise<FilePairProcessResult> {
    const fileMaps = fileStatus(host).map;
    const { file, doc } = pair;
    const canonicalPath = doc ? getPathFromEntry(host, doc) : file?.path;
    if (!canonicalPath) {
        throw new Error("Corrupted file pair");
    }
    const path = canonicalPath;
    const fileMapKey = convertCase(host.services.setting.currentSettings(), canonicalPath);

    if (file) {
        updateFileMTimeInMap(host, fileMapKey, file.stat.mtime);
    }

    if (doc && (doc._conflicts?.length ?? 0) > 0) {
        log(`SKIP ${options.mode}: ${path} has conflicts`, LOG_LEVEL_INFO);
        return FilePairProcessResults.SKIPPED;
    }
    const state = getFilePairState(pair);
    let action = resolveFilePairAction(state, options);

    // If the file existed locally on a previous run and is now missing while DB-only,
    // treat it as an offline local deletion when local mtime is not older than DB mtime.
    if (options.mode === FullScanModes.NEWER_WINS && state === "db-only" && doc) {
        const lastSeenMTime = getFileMTimeFromMap(host, fileMapKey);
        if (lastSeenMTime !== undefined) {
            const recency = compareMTime(lastSeenMTime, doc.mtime);
            if (recency === BASE_IS_NEW || recency === EVEN) {
                action = "delete-db";
                log(`NEWER_WINS: Treating missing local file as deletion (${path})`, LOG_LEVEL_VERBOSE);
            }
        }
    }

    try {
        switch (action) {
            case "update-db":
                if (!file) {
                    throw new Error(`Missing storage file for ${path}`);
                }
                return await updateToDatabase(host, log, LOG_LEVEL_INFO, file);
            case "update-storage":
                if (!doc) {
                    throw new Error(`Missing database entry for ${path}`);
                }
                const updateStorageResult = await updateToStorage(host, log, LOG_LEVEL_INFO, doc);
                if (updateStorageResult === FilePairProcessResults.COMPLETED) {
                    updateFileMTimeInMap(host, fileMapKey, doc.mtime);
                }
                return updateStorageResult;
            case "sync-newer":
                if (!file || !doc) {
                    throw new Error(`Cannot compare freshness for ${path}`);
                }
                const syncResult = await syncStorageAndDatabase(host, log, file, LOG_LEVEL_INFO, doc, options);
                if (syncResult === FilePairProcessResults.COMPLETED) {
                    updateFileMTimeInMap(host, fileMapKey, Math.max(file.stat.mtime, doc.mtime));
                }
                return syncResult;
            case "delete-local":
                if (!file) {
                    log(`DELETE LOCAL: ${path} is already absent from storage`, LOG_LEVEL_VERBOSE);
                    return FilePairProcessResults.COMPLETED;
                }
                log(`DELETE LOCAL: ${file.path}`, LOG_LEVEL_INFO);
                await host.serviceModules.storageAccess.delete(file.path, true);
                fileMaps.delete(fileMapKey);
                saveFileStatus(host);
                return FilePairProcessResults.COMPLETED;
            case "delete-db": {
                if (!doc) {
                    throw new Error(`Missing database entry for ${path}`);
                }
                log(`DELETE DATABASE: ${path}`, LOG_LEVEL_INFO);
                // deleteFileFromDB returns false when nothing was deleted, but the return
                // value was ignored and the fileStatusMap last-seen entry was wiped
                // regardless. The next scan then classified the doc as database-only with
                // no last-seen record -> update-storage -> the deleted file was resurrected
                // from the database. Only clear the last-seen record when the database
                // delete actually succeeded.
                const dbDeleted = await host.serviceModules.fileHandler.deleteFileFromDB(stripAllPrefixes(path));
                if (dbDeleted) {
                    fileMaps.delete(fileMapKey);
                    saveFileStatus(host);
                    return FilePairProcessResults.COMPLETED;
                } else {
                    log(
                        `DELETE DATABASE did not delete ${path}; keeping last-seen record to avoid resurrecting the file`,
                        LOG_LEVEL_NOTICE
                    );
                    return FilePairProcessResults.FAILED;
                }
            }
            case "skip":
                log(`SKIP ${options.mode}: ${path} (${state})`, LOG_LEVEL_VERBOSE);
                return FilePairProcessResults.SKIPPED;
        }
    } catch (ex) {
        log(`Error processing ${path} with action ${action}`, LOG_LEVEL_NOTICE);
        log(ex, LOG_LEVEL_VERBOSE);
        return FilePairProcessResults.FAILED;
    }
}
/**
 * Run one scan at a time for each backing-store owner.
 * @param host - Borrowed scan services and file-operation capabilities.
 * @param log - Operation-local diagnostics and progress reporting.
 * @param errorManager - Existing scan error-reporting boundary.
 * @param options - Freshness, explicit-policy, suspension, and failure handling options.
 * @returns The aggregate result after required bookkeeping has been attempted.
 * @remarks File processing retains ten scanner slots; deletion recovery shares
 * its separate three-file admission limit. The scan reuses one collection.
 * Enabled recovery awaits the final map write; other policies retain their
 * existing scheduled-save contract.
 * @throws If preparation or collection fails before a per-file result can be reported.
 */
export async function synchroniseAllFilesBetweenDBandStorage(
    host: NecessaryServices<"setting" | "vault" | "path" | "database" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options: FullScanOptions
): Promise<VaultScanResult> {
    return await withLock(fileStatus(host).scanLock, () => synchroniseFilePairs(host, log, errorManager, options));
}

/**
 * Join one storage listing and one Metadata collection by comparison identity.
 * @returns Selected pairs with unresolved identities quarantined.
 * @remarks A quarantined path must not become a storage-only database write.
 */
async function collectScanPairs(
    host: NecessaryServices<"setting" | "vault" | "path" | "database", "storageAccess">,
    settings: ObsidianLiveSyncSettings,
    log: LogFunction,
    showingNotice: boolean
): Promise<FilePair[]> {
    const { storageFileNameMap, storageFileNameCI2CS } = await collectFilesOnStorage(host, settings, log);
    const { databaseFileNameMap, databaseFileNameCI2CS, quarantinedFileNamesLC } = await collectDatabaseFiles(
        host,
        settings,
        log,
        showingNotice
    );

    const pairs: FilePair[] = [];
    for (const fileNameLC of unique([
        ...Object.keys(storageFileNameCI2CS),
        ...Object.keys(databaseFileNameCI2CS),
    ] as FilePathWithPrefixLC[])) {
        if (quarantinedFileNamesLC.has(fileNameLC)) {
            continue;
        }
        const fileName = fileNameLC in storageFileNameCI2CS ? storageFileNameCI2CS[fileNameLC] : undefined;
        const file = fileName ? storageFileNameMap[fileName] : undefined;
        const databaseName = fileNameLC in databaseFileNameCI2CS ? databaseFileNameCI2CS[fileNameLC] : undefined;
        const doc = databaseName ? databaseFileNameMap[databaseName] : undefined;
        const pair: FilePair = { file, doc } as FilePair;
        pairs.push(pair);
    }

    return pairs;
}

/**
 * Select recovery work from existing pairs without reading file bodies.
 * @returns Present-file attempts, cleanup-only attempts, and enumeration failures.
 * @remarks Only an ordinary opt-in scan participates. Absent candidates cause
 * one keys-only query; surviving provenance or last-seen state rediscovers cleanup.
 */
async function planDeletionRecovery(
    host: NecessaryServices<"setting" | "path" | "keyValueDB", "fileHandler">,
    pairs: FilePair[],
    options: FullScanOptions,
    log: LogFunction
) {
    const handler = host.serviceModules.fileHandler;
    const settings = host.services.setting.currentSettings();
    // Explicit Fetch/Inspector policies and hosts without recovery support retain their existing behaviour.
    const enabled =
        options.mode === FullScanModes.NEWER_WINS &&
        !options.extraOnLocal &&
        !options.extraOnRemote &&
        handler.supportsDeletionRecovery?.() === true;
    const recoveries = new Set<FilePair>();
    const cleanup = new Set<FilePair>();
    let maintenanceFailures = 0;
    if (!enabled) return { enabled, recoveries, cleanup, maintenanceFailures };
    const absent: FilePair[] = [];
    for (const pair of pairs) {
        const { file, doc } = pair;
        // Tombstones and conflicts have no retained, unambiguous deletion to recover.
        if (!doc?.deleted || doc._deleted || doc._conflicts?.length) continue;
        if (!file) {
            absent.push(pair);
        } else if (host.services.path.compareFileFreshness(file, doc) === TARGET_IS_NEW) {
            recoveries.add(pair);
        }
    }
    // Only absent candidates need key discovery; existing evidence can identify interrupted cleanup without body reads.
    if (absent.length) {
        try {
            const keys = new Set((await handler.listDeletionRecoveryPaths!()).map((p) => convertCase(settings, p)));
            const fileMaps = fileStatus(host).map;
            for (const pair of absent) {
                const key = convertCase(settings, getPathFromEntry(host, pair.doc!));
                // Either surviving record is enough to rediscover cleanup after partial persistence.
                if (keys.has(key) || fileMaps.has(key)) cleanup.add(pair);
            }
        } catch (error) {
            maintenanceFailures++;
            log("Deletion recovery could not enumerate provenance; bookkeeping remains incomplete.", LOG_LEVEL_NOTICE);
            log(error, LOG_LEVEL_VERBOSE);
        }
    }
    return { enabled, recoveries, cleanup, maintenanceFailures };
}

/**
 * Finish interrupted cleanup before reconciling the remaining collected pairs.
 * @returns The existing aggregate scan result, including bookkeeping failures.
 * @remarks Observed absence and provenance completion are separate effects.
 * Recovery changes are coalesced into the final ordered last-seen write.
 */
async function synchroniseFilePairs(
    host: NecessaryServices<"setting" | "vault" | "path" | "database" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options: FullScanOptions
): Promise<VaultScanResult> {
    const settings = host.services.setting.currentSettings();
    const showingNotice = options.showingNotice ?? false;
    await loadFileStatus(host);
    const fileMaps = fileStatus(host).map;
    const pairs = await collectScanPairs(host, settings, log, showingNotice);

    log(`Total files to synchronise: ${pairs.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    let completedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const handler = host.serviceModules.fileHandler;
    const plan = await planDeletionRecovery(host, pairs, options, log);
    const { enabled, recoveries, cleanup } = plan;
    let maintenanceFailures = plan.maintenanceFailures;
    let recoveryApplied = 0;
    let recoveryDeferred = 0;
    let recoveryPending = 0;
    // Finish previously interrupted cleanup before admitting new physical removals.
    const phases = [cleanup, pairs.filter((pair) => !cleanup.has(pair))];
    const processPair = async (e: FilePair): Promise<FilePairProcessResult> => {
        if (!recoveries.has(e) && !cleanup.has(e)) return await processFilePair(host, log, e, options);
        // The plan may outlive a settings change, so recheck suspension before each attempt.
        if (!options.ignoreSuspending && host.services.setting.currentSettings().suspendFileWatching) {
            return FilePairProcessResults.SKIPPED;
        }
        const key = convertCase(settings, getPathFromEntry(host, e.doc!));
        // Keep the observed file retryable even when verification rejects or throws.
        if (e.file) fileMaps.set(key, e.file.stat.mtime);
        const result = await handler.recoverDatabaseDeletion!(e.doc!, cleanup.has(e));
        // Physical absence clears last-seen state independently of incomplete provenance cleanup.
        if (result.file === "absent") {
            fileMaps.delete(key);
        } else if (e.file) {
            fileMaps.set(key, e.file.stat.mtime);
        }
        if (result.file === "absent" && !cleanup.has(e)) recoveryApplied++;
        if (result.status === "deferred") recoveryDeferred++;
        if (result.provenance === "pending") recoveryPending++;
        if (result.warning || result.status !== "applied") {
            const detail = result.warning ? `${result.reason}; ${result.warning}` : result.reason;
            log(`Deletion recovery ${result.status}: ${e.doc!.path} (${detail})`, LOG_LEVEL_VERBOSE);
            if (result.error) log(result.error, LOG_LEVEL_VERBOSE);
        }
        if (result.status === "failed") return FilePairProcessResults.FAILED;
        return result.status === "deferred" ? FilePairProcessResults.SKIPPED : FilePairProcessResults.COMPLETED;
    };
    // Both phases reuse the existing ten scanner slots; the handler owns the shared three-file cap.
    async function* processPhases() {
        for (const phase of phases) {
            yield* withConcurrency(
                phase,
                async (e) => {
                    const path = e.file?.path ?? getPathFromEntry(host, e.doc!);
                    try {
                        return { path, result: await processPair(e) };
                    } catch (error) {
                        log(`Error while synchronising files`, LOG_LEVEL_NOTICE);
                        log(error, LOG_LEVEL_VERBOSE);
                        return { path, result: FilePairProcessResults.FAILED };
                    }
                },
                10
            );
        }
    }
    for await (const { path, result } of processPhases()) {
        processedCount++;
        switch (result) {
            case FilePairProcessResults.COMPLETED:
                completedCount++;
                break;
            case FilePairProcessResults.SKIPPED:
                skippedCount++;
                break;
            case FilePairProcessResults.FAILED:
                failedCount++;
                log(
                    `Offline scan failed to synchronise ${path} between storage and the local database; this path remains eligible for a later scan.`,
                    LOG_LEVEL_VERBOSE
                );
                break;
        }
        if (processedCount % 25 === 0) {
            log(
                `Processing: ${processedCount}/${pairs.length}`,
                showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
                "syncAll"
            );
        }
    }
    log(
        `Synchronisation completed: ${processedCount} files processed (${completedCount} completed, ${skippedCount} skipped, ${failedCount} failed)`,
        showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
        "syncAll"
    );
    if (enabled) {
        log(
            `Deletion recovery: ${recoveryApplied} applied, ${recoveryDeferred} deferred, ${recoveryPending} cleanup pending`,
            showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO
        );
        // Commit the combined map once after both phases; a failed write leaves the scan incomplete.
        try {
            await flushFileStatus(host);
        } catch (error) {
            maintenanceFailures++;
            log("Deletion recovery bookkeeping could not be persisted; the scan remains incomplete.", LOG_LEVEL_NOTICE);
            log(error, LOG_LEVEL_VERBOSE);
        }
    } else {
        saveFileStatus(host, true);
    }
    if (failedCount === 0 && maintenanceFailures === 0) return VaultScanResults.COMPLETED;
    return options.continueOnFileFailure === true
        ? VaultScanResults.COMPLETED_WITH_FILE_FAILURES
        : VaultScanResults.FAILED;
}
