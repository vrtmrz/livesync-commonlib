import {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    isMetaEntry,
    type MetaEntry,
    type UXFileInfoStub,
    type ObsidianLiveSyncSettings,
    type FilePathWithPrefix,
    type FilePathWithPrefixLC,
    type LOG_LEVEL,
} from "@lib/common/types";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { shouldBeIgnored, stripAllPrefixes } from "@lib/string_and_binary/path";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { LogFunction } from "@lib/services/lib/logUtils";
import type { VaultScanOptions } from "@lib/services/base/VaultScanResult";
import { inspectMetadataDocumentIdentity } from "./metadata";
import { getPathFromEntry, convertCase } from "./paths";
import { FilePairProcessResults, MetadataDocumentIdentityStatuses, type FilePairProcessResult } from "./types";

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
    doc: MetaEntry,
    scanOptions?: VaultScanOptions
): Promise<FilePairProcessResult> {
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
                return (await host.serviceModules.fileHandler.storeFileToDB(file))
                    ? FilePairProcessResults.COMPLETED
                    : FilePairProcessResults.FAILED;
            } else {
                log(
                    `STORAGE -> DB : ${file.path} has been skipped due to file size exceeding the limit`,
                    LOG_LEVEL_NOTICE
                );
                return FilePairProcessResults.SKIPPED;
            }
        case TARGET_IS_NEW:
            if (!host.services.vault.isFileSizeTooLarge(doc.size)) {
                log("STORAGE <- DB :" + docPath);
                if (await host.serviceModules.fileHandler.dbToStorage(doc, stripAllPrefixes(docPath), false)) {
                    host.services.context.events.emitEvent("event-file-changed", {
                        file: file.path,
                        automated: true,
                    });
                    return FilePairProcessResults.COMPLETED;
                } else {
                    log(`STORAGE <- DB : Cloud not read ${file.path}, possibly deleted`, LOG_LEVEL_NOTICE);
                    return FilePairProcessResults.FAILED;
                }
            } else {
                log(
                    `STORAGE <- DB : ${file.path} has been skipped due to file size exceeding the limit`,
                    LOG_LEVEL_NOTICE
                );
                return FilePairProcessResults.SKIPPED;
            }
        case EVEN:
            if (
                host.services.vault.isFileSizeTooLarge(file.stat.size) ||
                host.services.vault.isFileSizeTooLarge(doc.size)
            ) {
                log(
                    `STORAGE ? DB : ${file.path} has been skipped due to file size exceeding the limit`,
                    LOG_LEVEL_NOTICE
                );
                return FilePairProcessResults.SKIPPED;
            }
            if (
                scanOptions?.strictContentCheck === false &&
                (await host.serviceModules.fileHandler.canSkipUnchangedFile?.(file, doc))
            ) {
                log(
                    `STORAGE ? DB : ${file.path} skipped using unchanged storage and revision metadata`,
                    LOG_LEVEL_DEBUG
                );
                return FilePairProcessResults.SKIPPED;
            }
            if (doc._rev && (await host.serviceModules.fileHandler.tryRecordUntrackedFileRevision(file, doc._rev))) {
                log("STORAGE == DB :" + file.path, LOG_LEVEL_DEBUG);
                return FilePairProcessResults.COMPLETED;
            }
            log("STORAGE ? DB :" + file.path + " Checking content", LOG_LEVEL_DEBUG);
            try {
                return (await host.serviceModules.fileHandler.storeFileToDB(file, false, false, {
                    revalidateStorage: true,
                }))
                    ? FilePairProcessResults.COMPLETED
                    : FilePairProcessResults.FAILED;
            } catch (error) {
                log(`STORAGE ? DB : Could not reconcile ${file.path}`, LOG_LEVEL_NOTICE);
                log(error, LOG_LEVEL_VERBOSE);
                return FilePairProcessResults.FAILED;
            }
        default:
            log("STORAGE ?? DB :" + file.path + " Something got weird");
            return FilePairProcessResults.FAILED;
    }
}

function createComparisonPathLookup(settings: ObsidianLiveSyncSettings, paths: readonly FilePathWithPrefix[]) {
    return Object.fromEntries(paths.map((path) => [convertCase(settings, path), path])) as Record<
        FilePathWithPrefixLC,
        FilePathWithPrefix
    >;
}

/**
 * Collect selected storage stubs for later policy and content checks.
 * @param host - Borrowed Vault-selection and storage-listing capabilities.
 * @param settings - Comparison-key normalisation settings.
 * @param log - Collection diagnostics.
 * @returns Path and comparison-key lookups of selected storage observations.
 * @remarks Content acquisition remains with the later file-handler operations.
 */
export async function collectFilesOnStorage(
    host: NecessaryServices<"vault", "storageAccess">,
    settings: ObsidianLiveSyncSettings,
    log: LogFunction
) {
    log("Collecting local files on the storage", LOG_LEVEL_VERBOSE);
    const filesStorageSrc = await host.serviceModules.storageAccess.getFiles();

    const _filesStorage: UXFileInfoStub[] = [];

    for (const f of filesStorageSrc) {
        if (shouldBeIgnored(f.path)) continue;
        if (await host.services.vault.isTargetFile(f.path)) {
            _filesStorage.push(f);
        }
    }

    const storageFileNameMap = Object.fromEntries(_filesStorage.map((e) => [e.path, e]));

    const storageFileNames = Object.keys(storageFileNameMap) as FilePathWithPrefix[];

    const storageFileNameCI2CS = createComparisonPathLookup(settings, storageFileNames);
    return { storageFileNameMap, storageFileNames, storageFileNameCI2CS };
}

/**
 * Collect selected Metadata while quarantining unresolved document identities.
 * @param host - Borrowed database, Vault-selection, and path capabilities.
 * @param settings - Comparison-key normalisation settings.
 * @param log - Collection diagnostics.
 * @param showingNotice - Whether progress is reported as a visible notice.
 * @returns Metadata lookups and comparison keys which ordinary scans must quarantine.
 * @remarks Conflicts are retained for later policy checks. This collection does
 * not repair identities, write revisions, or fetch file bodies.
 */
export async function collectDatabaseFiles(
    host: NecessaryServices<"database" | "vault" | "path", never>,
    settings: ObsidianLiveSyncSettings,
    log: LogFunction,
    showingNotice: boolean
) {
    log("Collecting local files on the DB", LOG_LEVEL_VERBOSE);
    const _DBEntries: MetaEntry[] = [];
    const unresolvedFileNamesLC = new Set<FilePathWithPrefixLC>();
    const resolvableFileNamesLC = new Set<FilePathWithPrefixLC>();
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
        if (!isMetaEntry(doc)) {
            const documentId = (doc as unknown as { _id?: string })._id ?? "unknown";
            log(`Invalid Metadata entry: ${documentId}`, LOG_LEVEL_INFO);
            continue;
        }
        const identity = await inspectMetadataDocumentIdentity(host, doc);
        if (identity.status === MetadataDocumentIdentityStatuses.EXCLUDED) {
            continue;
        }
        if (identity.status === MetadataDocumentIdentityStatuses.UNRESOLVED) {
            const { diagnostic } = identity;
            const unresolvedKey = convertCase(settings, stripAllPrefixes(diagnostic.declaredPath));
            unresolvedFileNamesLC.add(unresolvedKey);
            log(
                `Metadata identity is unresolved and will be left unchanged: ${diagnostic.declaredPath} (${diagnostic.reason})`,
                LOG_LEVEL_INFO
            );
            continue;
        }
        const path = identity.declaredPath;

        if (
            host.services.vault.isValidPath(path) &&
            !shouldBeIgnored(path) &&
            (await host.services.vault.isTargetFile(path))
        ) {
            _DBEntries.push(doc);
            resolvableFileNamesLC.add(convertCase(settings, stripAllPrefixes(path)));
        }
    }

    const databaseFileNameMap = Object.fromEntries(_DBEntries.map((e) => [getPathFromEntry(host, e), e])) as Record<
        FilePathWithPrefix,
        MetaEntry
    >;
    const databaseFileNames = Object.keys(databaseFileNameMap) as FilePathWithPrefix[];
    const databaseFileNameCI2CS = createComparisonPathLookup(settings, databaseFileNames);

    // A stale enumerated document must not suppress the established path-based
    // resolution flow. Quarantine the storage path only when no consistent,
    // selected Metadata entry can represent that logical path.
    const quarantinedFileNamesLC = new Set(
        [...unresolvedFileNamesLC].filter((path) => !resolvableFileNamesLC.has(path))
    );
    return {
        databaseFileNameMap,
        databaseFileNames,
        databaseFileNameCI2CS,
        quarantinedFileNamesLC,
    };
}

export async function updateToDatabase(
    host: NecessaryServices<"vault", "fileHandler">,
    log: LogFunction,
    logLevel: LOG_LEVEL,
    file: UXFileInfoStub
): Promise<FilePairProcessResult> {
    if (!host.services.vault.isFileSizeTooLarge(file.stat.size)) {
        const path = file.path;
        if (!(await host.serviceModules.fileHandler.storeFileToDB(file))) {
            return FilePairProcessResults.FAILED;
        }
        host.services.context.events.emitEvent("event-file-changed", { file: path, automated: true });
        return FilePairProcessResults.COMPLETED;
    } else {
        log(`UPDATE DATABASE: ${file.path} has been skipped due to file size exceeding the limit`, logLevel);
        return FilePairProcessResults.SKIPPED;
    }
}

export async function updateToStorage(
    host: NecessaryServices<"vault" | "path", "fileHandler">,
    log: LogFunction,
    logLevel: LOG_LEVEL,
    w: MetaEntry
): Promise<FilePairProcessResult> {
    // Exists in database but not in storage.
    const path = getPathFromEntry(host, w);
    if (w && !(w.deleted || w._deleted)) {
        if (!host.services.vault.isFileSizeTooLarge(w.size)) {
            // Prevent applying the conflicted state to the storage.
            if ((w._conflicts?.length ?? 0) > 0) {
                log(`UPDATE STORAGE: ${path} has conflicts. skipped (x)`, LOG_LEVEL_INFO);
                return FilePairProcessResults.SKIPPED;
            }
            const reflected = await host.serviceModules.fileHandler.dbToStorage(path, null, true);
            // Keep a failed reflection retryable. Treating it as success would let
            // the caller persist the database mtime as a locally observed file and
            // a later newer-wins scan could misclassify the missing file as deleted.
            if (!reflected) return FilePairProcessResults.FAILED;
            host.services.context.events.emitEvent("event-file-changed", {
                file: path,
                automated: true,
            });
            log(`Check or pull from db:${path} OK`);
            return FilePairProcessResults.COMPLETED;
        } else {
            log(`UPDATE STORAGE: ${path} has been skipped due to file size exceeding the limit`, logLevel);
            return FilePairProcessResults.SKIPPED;
        }
    } else if (w) {
        log(`Deletion history skipped: ${path}`, LOG_LEVEL_VERBOSE);
        return FilePairProcessResults.SKIPPED;
    } else {
        log(`entry not found: ${path}`);
        return FilePairProcessResults.FAILED;
    }
}

export async function syncStorageAndDatabase(
    host: NecessaryServices<"setting" | "vault" | "path", "storageAccess" | "fileHandler">,
    log: LogFunction,
    file: UXFileInfoStub,
    logLevel: LOG_LEVEL,
    doc: MetaEntry,
    scanOptions?: VaultScanOptions
): Promise<FilePairProcessResult> {
    // Prevent applying the conflicted state to the storage.
    if ((doc._conflicts?.length ?? 0) > 0) {
        log(`SYNC DATABASE AND STORAGE: ${file.path} has conflicts. skipped`, LOG_LEVEL_INFO);
        return FilePairProcessResults.SKIPPED;
    }
    if (!host.services.vault.isFileSizeTooLarge(file.stat.size) && !host.services.vault.isFileSizeTooLarge(doc.size)) {
        return await syncFileBetweenDBandStorage(host, log, file, doc, scanOptions);
    } else {
        log(
            `SYNC DATABASE AND STORAGE: ${getPathFromEntry(host, doc)} has been skipped due to file size exceeding the limit`,
            logLevel
        );
        return FilePairProcessResults.SKIPPED;
    }
}
