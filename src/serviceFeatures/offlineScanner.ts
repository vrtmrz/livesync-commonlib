import { unique } from "octagonal-wheels/collection";
import { throttle } from "octagonal-wheels/function";
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

import { isAnyNote } from "@lib/common/utils";
import { stripAllPrefixes } from "@lib/string_and_binary/path";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { eventHub } from "@lib/hub/hub";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";

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
    if ("path" in file) {
        const w = await host.serviceModules.storageAccess.getFileStub(docPath);
        if (w) {
            file = w;
        } else {
            throw new Error(`Missing file:${docPath}`);
        }
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
                if (await host.serviceModules.fileHandler.dbToStorage(doc, stripAllPrefixes(docPath), true)) {
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
    showingNotice: boolean = false,
    ignoreSuspending: boolean = false
): Promise<boolean> {
    if (!canProceedScan(host, errorManager, log, showingNotice, ignoreSuspending)) {
        return false;
    }

    log("Opening the key-value database", LOG_LEVEL_VERBOSE);
    const isInitialized = (await host.services.keyValueDB.kvDB.get("initialized")) || false;

    const settings = host.services.setting.currentSettings();

    if (showingNotice) {
        log("Initializing", LOG_LEVEL_NOTICE, "syncAll");
    }
    if (isInitialized) {
        log("Restoring storage state", LOG_LEVEL_VERBOSE);
        await host.serviceModules.storageAccess.restoreState();
    }

    log("Initialize and checking database files");
    log("Checking deleted files");
    await collectDeletedFiles(host, log);

    const { storageFileNameMap, storageFileNames, storageFileNameCI2CS } = await collectFilesOnStorage(
        host,
        settings,
        log
    );
    const { databaseFileNameMap, databaseFileNames, databaseFileNameCI2CS } = await collectDatabaseFiles(
        host,
        settings,
        log,
        showingNotice
    );

    const allFiles = unique([
        ...Object.keys(databaseFileNameCI2CS),
        ...Object.keys(storageFileNameCI2CS),
    ]) as FilePathWithPrefixLC[];

    log(`Total files in the database: ${databaseFileNames.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    log(`Total files in the storage: ${storageFileNames.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    log(`Total files: ${allFiles.length}`, LOG_LEVEL_VERBOSE, "syncAll");

    const filesExistOnlyInStorage = allFiles.filter((e) => !databaseFileNameCI2CS[e]);
    const filesExistOnlyInDatabase = allFiles.filter((e) => !storageFileNameCI2CS[e]);
    const filesExistBoth = allFiles.filter((e) => databaseFileNameCI2CS[e] && storageFileNameCI2CS[e]);
    const fileMap = filesExistBoth.map((path) => {
        const file = storageFileNameMap[storageFileNameCI2CS[path]];
        const doc = databaseFileNameMap[databaseFileNameCI2CS[path]];
        return { file, doc };
    });
    log(`Files exist only in storage: ${filesExistOnlyInStorage.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    log(`Files exist only in database: ${filesExistOnlyInDatabase.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    log(`Files exist both in storage and database: ${filesExistBoth.length}`, LOG_LEVEL_VERBOSE, "syncAll");

    log("Synchronising...");
    const processStatus: Record<string, string> = {};
    const logLevel = showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
    const updateLog = throttle((key: string, msg: string) => {
        processStatus[key] = msg;
        const logMsg = Object.values(processStatus).join("\n");
        log(logMsg, logLevel, "syncAll");
    }, 25);

    const initProcess: Promise<void>[] = [];

    async function runAll<T>(procedureName: string, objects: T[], callback: (arg: T) => Promise<void>) {
        if (objects.length === 0) {
            log(`${procedureName}: Nothing to do`, LOG_LEVEL_VERBOSE);
            return;
        }
        log(`${procedureName} (Total: ${objects.length})`);
        if (!host.services.database.localDatabase.isReady) throw Error("Database is not ready!");
        let success = 0;
        let failed = 0;
        let total = 0;
        for await (const result of withConcurrency(
            objects,
            async (e) => {
                try {
                    await callback(e);
                    return true;
                } catch (ex) {
                    log(`Error while ${procedureName}`, LOG_LEVEL_NOTICE);
                    log(ex, LOG_LEVEL_VERBOSE);
                    return false;
                }
            },
            10
        )) {
            if (result) {
                success++;
            } else {
                failed++;
            }
            total++;
            const msg = `${procedureName}: DONE:${success}, FAILED:${failed}, LAST:${objects.length - total}`;
            updateLog(procedureName, msg);
        }
        const msg = `${procedureName} All done: DONE:${success}, FAILED:${failed}`;
        updateLog(procedureName, msg);
    }

    initProcess.push(
        runAll("UPDATE DATABASE", filesExistOnlyInStorage, async (e: FilePathWithPrefixLC) => {
            // Exists in storage but not in database.
            const file = storageFileNameMap[storageFileNameCI2CS[e]];
            await updateToDatabase(host, log, logLevel, file);
        })
    );

    initProcess.push(
        runAll("UPDATE STORAGE", filesExistOnlyInDatabase, async (e: FilePathWithPrefixLC) => {
            const w = databaseFileNameMap[databaseFileNameCI2CS[e]];
            // Exists in database but not in storage.
            await updateToStorage(host, log, logLevel, w);
        })
    );

    initProcess.push(
        runAll("SYNC DATABASE AND STORAGE", fileMap, async (e: { file: UXFileInfoStub; doc: MetaEntry }) => {
            const { file, doc } = e;
            await syncStorageAndDatabase(host, log, file, logLevel, doc);
        })
    );
    await Promise.all(initProcess);

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
