import type PouchDB from "pouchdb-core";
import { unique } from "octagonal-wheels/collection";
import { withConcurrency } from "octagonal-wheels/iterable/map";
import {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type EntryDoc,
    type FilePathWithPrefix,
    type FilePathWithPrefixLC,
    type MetaEntry,
    isMetaEntry,
    type UXFileInfoStub,
    type ObsidianLiveSyncSettings,
    type LOG_LEVEL,
} from "@lib/common/types";

import { compareMTime, isAnyNote } from "@lib/common/utils";
import { stripAllPrefixes } from "@lib/string_and_binary/path";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { eventHub } from "@lib/hub/hub";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { compatGlobal } from "../common/coreEnvFunctions";

/**
 * Collect deleted files that have expired according to retention policy.
 * @param host Services container
 * @param log Logging function
 * @returns Array of expired deletion history
 */
export async function collectDeletedFiles(
    host: NecessaryServices<"setting" | "database", never>,
    log: LogFunction
): Promise<void> {
    const limitDays = host.services.setting.currentSettings().automaticallyDeleteMetadataOfDeletedFiles;
    if (limitDays <= 0) return;
    log(`Checking expired file history`);
    const limit = Date.now() - 86400 * 1000 * limitDays;
    const notes: {
        path: FilePathWithPrefix;
        mtime: number;
        ttl: number;
        doc: PouchDB.Core.ExistingDocument<EntryDoc & PouchDB.Core.AllDocsMeta>;
    }[] = [];
    for await (const doc of host.services.database.localDatabase.findAllDocs({ conflicts: true })) {
        if (isAnyNote(doc)) {
            if (doc.deleted && doc.mtime - limit < 0) {
                notes.push({
                    path: doc.path,
                    mtime: doc.mtime,
                    ttl: (doc.mtime - limit) / 1000 / 86400,
                    doc: doc,
                });
            }
        }
    }
    if (notes.length === 0) {
        log("There are no old documents");
        log(`Checking expired file history done`);
        return;
    }
    for (const v of notes) {
        log(`Deletion history expired: ${v.path}`);
        const delDoc = v.doc;
        delDoc._deleted = true;
        await host.services.database.localDatabase.putRaw(delDoc);
    }
    log(`Checking expired file history done`);
}

/**
 * Get the file path from a meta entry.
 * This is a helper function to extract path from various document types.
 * @param doc Meta entry document
 * @returns Path string
 */
export function getPathFromEntry(host: NecessaryServices<"path", never>, doc: MetaEntry): FilePathWithPrefix {
    const path = host.services.path.getPath(doc);
    return path;
}

/**
 * Synchronise a single file between database and storage based on freshness comparison.
 * @param host Services container
 * @param log Logging function
 * @param file Storage file information
 * @param doc Database entry
 */
export async function syncFileBetweenDBandStorage(
    host: NecessaryServices<"setting" | "vault" | "path", "storageAccess" | "fileHandler">,
    log: LogFunction,
    file: UXFileInfoStub,
    doc: MetaEntry
): Promise<void> {
    const docPath = getPathFromEntry(host, doc);
    if (!doc) {
        throw new Error(`Missing doc:${docPath}`);
    }

    // const settings = host.services.setting.currentSettings();
    const compareResult = host.services.path.compareFileFreshness(file, doc);
    switch (compareResult) {
        case BASE_IS_NEW:
            if (!host.services.vault.isFileSizeTooLarge(file.stat.size)) {
                log("STORAGE -> DB :" + file.path);
                await host.serviceModules.fileHandler.storeFileToDB(file);
            } else {
                log(
                    `STORAGE -> DB : ${file.path} has been skipped due to file size exceeding the limit`,
                    LOG_LEVEL_NOTICE
                );
            }
            break;
        case TARGET_IS_NEW:
            if (!host.services.vault.isFileSizeTooLarge(doc.size)) {
                log("STORAGE <- DB :" + docPath);
                if (await host.serviceModules.fileHandler.dbToStorage(doc, stripAllPrefixes(docPath), false)) {
                    eventHub.emitEvent("event-file-changed", {
                        file: file.path,
                        automated: true,
                    });
                } else {
                    log(`STORAGE <- DB : Cloud not read ${file.path}, possibly deleted`, LOG_LEVEL_NOTICE);
                }
            } else {
                log(
                    `STORAGE <- DB : ${file.path} has been skipped due to file size exceeding the limit`,
                    LOG_LEVEL_NOTICE
                );
            }
            break;
        case EVEN:
            log("STORAGE == DB :" + file.path + "", LOG_LEVEL_DEBUG);
            break;
        default:
            log("STORAGE ?? DB :" + file.path + " Something got weird");
    }
}

export function canProceedScan(
    host: NecessaryServices<"keyValueDB" | "setting", never>,
    errorManager: UnresolvedErrorManager,
    log: LogFunction,
    showingNotice: boolean = false,
    ignoreSuspending: boolean = false
): boolean {
    // const isInitialized = (await host.services.keyValueDB.kvDB.get("initialized")) || false;

    const settings = host.services.setting.currentSettings();

    // Check if LiveSync is configured
    const ERR_NOT_CONFIGURED =
        "LiveSync is not configured yet. Synchronising between the storage and the local database is now prevented.";
    if (!settings.isConfigured) {
        errorManager.showError(ERR_NOT_CONFIGURED, showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
        return false;
    }
    errorManager.clearError(ERR_NOT_CONFIGURED);

    // Check if file watching is suspended
    const ERR_SUSPENDING =
        "Now suspending file watching. Synchronising between the storage and the local database is now prevented.";
    if (!ignoreSuspending && settings.suspendFileWatching) {
        errorManager.showError(ERR_SUSPENDING, showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
        return false;
    }
    errorManager.clearError(ERR_SUSPENDING);

    // Check if in remediation mode
    const MSG_IN_REMEDIATION = `Started in remediation Mode! (Max mtime for reflect events is set). Synchronising between the storage and the local database is now prevented.`;
    if (settings.maxMTimeForReflectEvents > 0) {
        errorManager.showError(MSG_IN_REMEDIATION, LOG_LEVEL_NOTICE);
        return false;
    }
    errorManager.clearError(MSG_IN_REMEDIATION);
    return true;
}

/**
 * Convert file path to lower case if the settings indicate that filename case should be handled insensitively.
 * @param settings
 * @param path
 * @returns
 */
export function convertCase<T extends FilePathWithPrefix>(
    settings: ObsidianLiveSyncSettings,
    path: T
): FilePathWithPrefixLC {
    if (settings.handleFilenameCaseSensitive) {
        return path as FilePathWithPrefixLC;
    }
    return (path as string).toLowerCase() as FilePathWithPrefixLC;
}

export async function collectFilesOnStorage(
    host: NecessaryServices<"vault", "storageAccess">,
    settings: ObsidianLiveSyncSettings,
    log: LogFunction
) {
    log("Collecting local files on the storage", LOG_LEVEL_VERBOSE);
    const filesStorageSrc = await host.serviceModules.storageAccess.getFiles();

    const _filesStorage: UXFileInfoStub[] = [];

    for (const f of filesStorageSrc) {
        if (await host.services.vault.isTargetFile(f.path)) {
            _filesStorage.push(f);
        }
    }

    const storageFileNameMap = Object.fromEntries(
        _filesStorage.map((e) => [e.path, e] as [FilePathWithPrefix, UXFileInfoStub])
    );

    const storageFileNames = Object.keys(storageFileNameMap) as FilePathWithPrefix[];

    const storageFileNameCapsPair = storageFileNames.map(
        (e) => [e, convertCase(settings, e)] as [FilePathWithPrefix, FilePathWithPrefixLC]
    );

    const storageFileNameCI2CS = Object.fromEntries(storageFileNameCapsPair.map((e) => [e[1], e[0]])) as Record<
        FilePathWithPrefixLC,
        FilePathWithPrefix
    >;
    return { storageFileNameMap, storageFileNames, storageFileNameCI2CS };
}

export async function collectDatabaseFiles(
    host: NecessaryServices<"database" | "vault" | "path", never>,
    settings: ObsidianLiveSyncSettings,
    log: LogFunction,
    showingNotice: boolean
) {
    log("Collecting local files on the DB", LOG_LEVEL_VERBOSE);
    const _DBEntries: MetaEntry[] = [];
    let count = 0;
    // Fetch all documents from the database (including conflicts to prevent overwriting).
    for await (const doc of host.services.database.localDatabase.findAllNormalDocs({ conflicts: true }) || []) {
        count++;
        if (count % 25 === 0)
            log(
                `Collecting local files on the DB: ${count}`,
                showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
                "syncAll"
            );
        const path = getPathFromEntry(host, doc);

        if (host.services.vault.isValidPath(path) && (await host.services.vault.isTargetFile(path))) {
            if (!isMetaEntry(doc)) {
                log(`Invalid entry: ${path}`, LOG_LEVEL_INFO);
                continue;
            }
            _DBEntries.push(doc);
        }
    }

    const databaseFileNameMap = Object.fromEntries(
        _DBEntries.map((e) => [getPathFromEntry(host, e), e] as [FilePathWithPrefix, MetaEntry])
    );
    const databaseFileNames = Object.keys(databaseFileNameMap) as FilePathWithPrefix[];
    const databaseFileNameCapsPair = databaseFileNames.map(
        (e) => [e, convertCase(settings, e)] as [FilePathWithPrefix, FilePathWithPrefixLC]
    );
    const databaseFileNameCI2CS = Object.fromEntries(databaseFileNameCapsPair.map((e) => [e[1], e[0]])) as Record<
        FilePathWithPrefix,
        FilePathWithPrefixLC
    >;
    return { databaseFileNameMap, databaseFileNames, databaseFileNameCI2CS };
}

export async function updateToDatabase(
    host: NecessaryServices<"vault", "fileHandler">,
    log: LogFunction,
    logLevel: LOG_LEVEL,
    file: UXFileInfoStub
): Promise<void> {
    if (!host.services.vault.isFileSizeTooLarge(file.stat.size)) {
        const path = file.path;
        await host.serviceModules.fileHandler.storeFileToDB(file);
        eventHub.emitEvent("event-file-changed", { file: path, automated: true });
    } else {
        log(`UPDATE DATABASE: ${file.path} has been skipped due to file size exceeding the limit`, logLevel);
    }
}

export async function updateToStorage(
    host: NecessaryServices<"vault" | "path", "fileHandler">,
    log: LogFunction,
    logLevel: LOG_LEVEL,
    w: MetaEntry
) {
    // Exists in database but not in storage.
    const path = getPathFromEntry(host, w);
    if (w && !(w.deleted || w._deleted)) {
        if (!host.services.vault.isFileSizeTooLarge(w.size)) {
            // Prevent applying the conflicted state to the storage.
            if ((w._conflicts?.length ?? 0) > 0) {
                log(`UPDATE STORAGE: ${path} has conflicts. skipped (x)`, LOG_LEVEL_INFO);
                return;
            }
            await host.serviceModules.fileHandler.dbToStorage(path, null, true);
            eventHub.emitEvent("event-file-changed", {
                file: path,
                automated: true,
            });
            log(`Check or pull from db:${path} OK`);
        } else {
            log(`UPDATE STORAGE: ${path} has been skipped due to file size exceeding the limit`, logLevel);
        }
    } else if (w) {
        log(`Deletion history skipped: ${path}`, LOG_LEVEL_VERBOSE);
    } else {
        log(`entry not found: ${path}`);
    }
}

export async function syncStorageAndDatabase(
    host: NecessaryServices<"setting" | "vault" | "path", "storageAccess" | "fileHandler">,
    log: LogFunction,
    file: UXFileInfoStub,
    logLevel: LOG_LEVEL,
    doc: MetaEntry
) {
    // Prevent applying the conflicted state to the storage.
    if ((doc._conflicts?.length ?? 0) > 0) {
        log(`SYNC DATABASE AND STORAGE: ${file.path} has conflicts. skipped`, LOG_LEVEL_INFO);
        return;
    }
    if (!host.services.vault.isFileSizeTooLarge(file.stat.size) && !host.services.vault.isFileSizeTooLarge(doc.size)) {
        await syncFileBetweenDBandStorage(host, log, file, doc);
    } else {
        log(
            `SYNC DATABASE AND STORAGE: ${getPathFromEntry(host, doc)} has been skipped due to file size exceeding the limit`,
            logLevel
        );
    }
}

export const FullScanModes = {
    // SAFE: "safe",
    DB_APPLY: "db-apply",
    NEWER_WINS: "newer-wins",
    // STORAGE_ONLY: "local-only",
} as const;

export const ExtraOnRemote = {
    /**
     * Delete database entries if they are missing on storage.
     */
    DELETE_LOCAL_MISSING: "delete-local-missing",
    /**
     * Apply changes from database to storage.
     */
    // APPEND_DB_ONLY: "append-db-only",
} as const;
export const ExtraOnLocal = {
    /**
     * Delete local files if they were deleted on database.
     */
    DELETE_DB_DELETED: "delete-db-deleted",
    /**
     * Delete local files if they are missing on database or were deleted on database.
     */
    DELETE_DB_MISSING: "delete-db-missing",
    /**
     * Merge local files to database
     */
    APPEND_STORAGE_ONLY: "append-storage-only",
} as const;

export interface FullScanOptions {
    mode: FullScanMode;
    extraOnLocal?: (typeof ExtraOnLocal)[keyof typeof ExtraOnLocal];
    extraOnRemote?: (typeof ExtraOnRemote)[keyof typeof ExtraOnRemote];
    omitEvents?: boolean;
    showingNotice?: boolean;
    ignoreSuspending?: boolean;
}

export type FullScanMode = (typeof FullScanModes)[keyof typeof FullScanModes];
type FilePair =
    | { file: UXFileInfoStub; doc: MetaEntry }
    | { file: undefined; doc: MetaEntry }
    | { file: UXFileInfoStub; doc: undefined };
type FilePairState = "storage-only" | "db-only" | "db-only-deleted" | "both" | "both-db-deleted";

type FilePairAction = "update-db" | "update-storage" | "sync-newer" | "delete-local" | "delete-db" | "skip";

function isDeletedEntry(entry: MetaEntry): boolean {
    return entry.deleted || entry._deleted || false;
}

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
 * Determine the action to be taken for a file pair based on its state and the selected scan options.
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
) {
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
        return true;
    }
    const state = getFilePairState(pair);
    let action = resolveFilePairAction(state, options);

    // If the file existed locally on a previous run and is now missing while DB-only,
    // treat it as an offline local deletion when local mtime is not older than DB mtime.
    if (options.mode === FullScanModes.NEWER_WINS && state === "db-only" && doc) {
        const lastSeenMTime = getFileMTimeFromMap(fileMapKey);
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
                await updateToDatabase(host, log, LOG_LEVEL_INFO, file);
                return true;
            case "update-storage":
                if (!doc) {
                    throw new Error(`Missing database entry for ${path}`);
                }
                await updateToStorage(host, log, LOG_LEVEL_INFO, doc);
                updateFileMTimeInMap(host, fileMapKey, doc.mtime);
                return true;
            case "sync-newer":
                if (!file || !doc) {
                    throw new Error(`Cannot compare freshness for ${path}`);
                }
                await syncStorageAndDatabase(host, log, file, LOG_LEVEL_INFO, doc);
                updateFileMTimeInMap(host, fileMapKey, Math.max(file.stat.mtime, doc.mtime));
                return true;
            case "delete-local":
                if (!file) {
                    log(`DELETE LOCAL: ${path} is already absent from storage`, LOG_LEVEL_VERBOSE);
                    return true;
                }
                log(`DELETE LOCAL: ${file.path}`, LOG_LEVEL_INFO);
                await host.serviceModules.storageAccess.delete(file.path, true);
                fileMaps.delete(fileMapKey);
                saveFileStatus(host);
                return true;
            case "delete-db":
                if (!doc) {
                    throw new Error(`Missing database entry for ${path}`);
                }
                log(`DELETE DATABASE: ${path}`, LOG_LEVEL_INFO);
                await host.serviceModules.fileHandler.deleteFileFromDB(stripAllPrefixes(path));
                fileMaps.delete(fileMapKey);
                saveFileStatus(host);
                return true;
            case "skip":
                log(`SKIP ${options.mode}: ${path} (${state})`, LOG_LEVEL_VERBOSE);
                return true;
        }
    } catch (ex) {
        log(`Error processing ${path} with action ${action}`, LOG_LEVEL_NOTICE);
        log(ex, LOG_LEVEL_VERBOSE);
        return false;
    }
}
/**
 * Synchronise all files between database and storage based on the selected mode and options.
 * @param host Core
 * @param log Logging function
 * @param errorManager Error manager
 * @param options Full scan options
 */
export async function synchroniseAllFilesBetweenDBandStorage(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options: FullScanOptions
) {
    const settings = host.services.setting.currentSettings();
    const showingNotice = options.showingNotice ?? false;
    await loadFileStatus(host);
    const { storageFileNameMap, storageFileNameCI2CS } = await collectFilesOnStorage(host, settings, log);
    const { databaseFileNameMap, databaseFileNameCI2CS } = await collectDatabaseFiles(
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
        const fileName = fileNameLC in storageFileNameCI2CS ? storageFileNameCI2CS[fileNameLC] : undefined;
        const file = fileName ? storageFileNameMap[fileName] : undefined;
        const databaseName = fileNameLC in databaseFileNameCI2CS ? databaseFileNameCI2CS[fileNameLC] : undefined;
        const doc = databaseName ? databaseFileNameMap[databaseName] : undefined;
        const pair: FilePair = { file, doc } as FilePair;
        pairs.push(pair);
    }

    log(`Total files to synchronise: ${pairs.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    let successCount = 0;
    let processedCount = 0;
    for await (const result of withConcurrency(
        pairs,
        async (e) => {
            try {
                return await processFilePair(host, log, e, options);
            } catch (ex) {
                log(`Error while synchronising files`, LOG_LEVEL_NOTICE);
                log(ex, LOG_LEVEL_VERBOSE);
                return false;
            }
        },
        10
    )) {
        processedCount++;
        if (result) {
            successCount++;
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
        `Synchronisation completed: ${successCount}/${processedCount} files processed successfully`,
        showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
        "syncAll"
    );
    return successCount === processedCount;
}

export function normaliseFullScanOptions(
    showingNoticeOrOptions: Partial<FullScanOptions> | boolean | undefined,
    ignoreSuspending: boolean = false
): FullScanOptions {
    if (typeof showingNoticeOrOptions === "object") {
        return {
            mode: FullScanModes.NEWER_WINS,
            ...showingNoticeOrOptions,
        };
    }
    return {
        mode: FullScanModes.NEWER_WINS,
        showingNotice: showingNoticeOrOptions ?? false,
        ignoreSuspending,
    };
}
// In-memory map to track file modification times for offline scanning.
let fileMaps = new Map<string, number>();
// Load file modification times from the key-value database into the in-memory map.
async function loadFileStatus(host: NecessaryServices<"keyValueDB", never>) {
    const kvDB = host.services.keyValueDB.kvDB as
        | { get?: <T = unknown>(key: string) => Promise<T | undefined> }
        | undefined;
    if (!kvDB?.get) {
        fileMaps = new Map();
        return;
    }
    const mapItems = (await kvDB.get<Record<string, number>>("fileStatusMap")) || {};
    fileMaps = new Map(Object.entries(mapItems));
}
// Save the current state of file modification times from the in-memory map to the key-value database.
async function _saveFileStatus(host: NecessaryServices<"keyValueDB", never>) {
    const kvDB = host.services.keyValueDB.kvDB as
        | { set?: (key: string, value: unknown) => Promise<unknown> }
        | undefined;
    if (!kvDB?.set) {
        return;
    }
    await kvDB.set("fileStatusMap", Object.fromEntries(fileMaps));
}

let saveFileStatusTimeout: number | null = null;
// Schedule saving file status with debouncing to prevent excessive writes during rapid changes.
function saveFileStatus(host: NecessaryServices<"keyValueDB", never>) {
    if (saveFileStatusTimeout !== null) {
        compatGlobal.clearTimeout(saveFileStatusTimeout);
    }
    saveFileStatusTimeout = compatGlobal.setTimeout(() => {
        void _saveFileStatus(host).then(() => {
            saveFileStatusTimeout = null;
        });
    }, 1000);
}
function updateFileMTimeInMap(host: NecessaryServices<"keyValueDB", never>, key: string, mtime: number) {
    fileMaps.set(key, mtime);
    saveFileStatus(host);
}
function getFileMTimeFromMap(key: string): number | undefined {
    return fileMaps.get(key);
}

/**
 * Perform a full scan and synchronisation between database and storage.
 * @param host Services container
 * @param log Logging function
 * @param errorManager Error manager
 * @param showingNotice Whether to show notices during scanning
 * @param ignoreSuspending Whether to ignore suspension settings
 * @returns True if scan completed successfully
 */
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options?: Partial<FullScanOptions>
): Promise<boolean>;
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNotice?: boolean,
    ignoreSuspending?: boolean
): Promise<boolean>;
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNoticeOrOptions: Partial<FullScanOptions> | boolean = false,
    ignoreSuspending: boolean = false
): Promise<boolean> {
    const options = normaliseFullScanOptions(showingNoticeOrOptions, ignoreSuspending);
    const showingNotice = options.showingNotice ?? false;
    const shouldIgnoreSuspending = options.ignoreSuspending ?? false;

    if (!canProceedScan(host, errorManager, log, showingNotice, shouldIgnoreSuspending)) {
        return false;
    }
    log("Opening the key-value database", LOG_LEVEL_VERBOSE);
    const isInitialized = (await host.services.keyValueDB.kvDB.get("initialized")) || false;

    if (showingNotice) {
        log("Initializing", LOG_LEVEL_NOTICE, "syncAll");
    }
    if (isInitialized) {
        log("Restoring storage state", LOG_LEVEL_VERBOSE);
        await host.serviceModules.storageAccess.restoreState();
    }
    await loadFileStatus(host);

    log("Initialize and checking database files");
    log("Checking deleted files");
    await collectDeletedFiles(host, log);
    await synchroniseAllFilesBetweenDBandStorage(host, log, errorManager, options);

    log("Initialized, NOW TRACKING!");
    if (!isInitialized) {
        await host.services.keyValueDB.kvDB.set("initialized", true);
    }
    if (showingNotice) {
        log("Initialize done!", LOG_LEVEL_NOTICE, "syncAll");
    }
    return true;
}

/**
 * Associate the initialiser file feature with the app lifecycle events.
 * This function binds initialization handlers to the appropriate lifecycle events.
 * @param host Services container with required dependencies
 */
export function useOfflineScanner(
    host: NecessaryServices<
        | "API"
        | "appLifecycle"
        | "setting"
        | "vault"
        | "path"
        | "database"
        | "databaseEvents"
        | "fileProcessing"
        | "keyValueDB"
        | "replicator",
        "storageAccess" | "fileHandler"
    >
) {
    const log = createInstanceLogFunction("SF:OfflineScanner", host.services.API);
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle);

    // Handler for vault scanning
    const handleScanVault = async (showingNotice?: boolean, ignoreSuspending: boolean = false): Promise<boolean> => {
        return await performFullScan(host, log, errorManager, showingNotice, ignoreSuspending);
    };
    // Bind handlers to lifecycle events
    host.services.vault.scanVault.addHandler(handleScanVault);
}
