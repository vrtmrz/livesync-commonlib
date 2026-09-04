import type PouchDB from "pouchdb-core";
import { unique } from "octagonal-wheels/collection";
import { withConcurrency } from "octagonal-wheels/iterable/map";
import {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type EntryDoc,
    type DocumentID,
    type FilePathWithPrefix,
    type FilePathWithPrefixLC,
    type MetaEntry,
    isMetaEntry,
    type UXFileInfoStub,
    type ObsidianLiveSyncSettings,
    type LOG_LEVEL,
    type AnyEntry,
} from "@lib/common/types";

import { compareMTime, isAnyNote } from "@lib/common/utils";
import { shouldBeIgnored, stripAllPrefixes } from "@lib/string_and_binary/path";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { ICHeader, ICXHeader, PSCHeader } from "@lib/common/models/fileaccess.const";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { VaultScanResults, type VaultScanResult } from "@lib/services/base/VaultScanResult.ts";

export { VaultScanResults };
export type { VaultScanResult };

/**
 * Outcome of processing one storage/database pair during an offline scan.
 *
 * A skipped pair is intentionally left unchanged by scanner policy. It is not
 * a scan failure, but it must not receive success side effects which would
 * claim that database content was reflected to storage.
 */
export const FilePairProcessResults = {
    COMPLETED: "completed",
    SKIPPED: "skipped",
    FAILED: "failed",
} as const;

export type FilePairProcessResult = (typeof FilePairProcessResults)[keyof typeof FilePairProcessResults];

export const MetadataDocumentNamespaces = {
    NORMAL: "normal",
    INTERNAL: "internal",
    CUSTOMISATION: "customisation",
    PLUGIN_STORAGE: "plugin-storage",
} as const;

export type MetadataDocumentNamespace = (typeof MetadataDocumentNamespaces)[keyof typeof MetadataDocumentNamespaces];

export const MetadataDocumentIdentityStatuses = {
    CONSISTENT: "consistent",
    EXCLUDED: "excluded",
    UNRESOLVED: "unresolved",
} as const;

export const OfflineScanUnresolvedReasons = {
    DOCUMENT_ID_MISMATCH: "document-id-mismatch",
    NAMESPACE_MISMATCH: "namespace-mismatch",
} as const;

export interface OfflineScanUnresolvedDiagnostic {
    reason: (typeof OfflineScanUnresolvedReasons)[keyof typeof OfflineScanUnresolvedReasons];
    actualDocumentId: DocumentID;
    declaredPath: FilePathWithPrefix;
    expectedDocumentId?: DocumentID;
    actualNamespace: MetadataDocumentNamespace;
    declaredPathNamespace: MetadataDocumentNamespace;
}

export type MetadataDocumentIdentityInspection =
    | {
          status: typeof MetadataDocumentIdentityStatuses.CONSISTENT;
          actualDocumentId: DocumentID;
          declaredPath: FilePathWithPrefix;
          expectedDocumentId: DocumentID;
      }
    | {
          status: typeof MetadataDocumentIdentityStatuses.EXCLUDED;
          actualDocumentId: DocumentID;
          declaredPath: FilePathWithPrefix;
          namespace: Exclude<MetadataDocumentNamespace, "normal">;
      }
    | {
          status: typeof MetadataDocumentIdentityStatuses.UNRESOLVED;
          diagnostic: OfflineScanUnresolvedDiagnostic;
      };

export interface MetadataDocumentIdentityIssue {
    inspection: Extract<
        MetadataDocumentIdentityInspection,
        { status: typeof MetadataDocumentIdentityStatuses.UNRESOLVED }
    >;
    sourceRevision: string | null;
    logicallyDeleted: boolean;
    conflictRevisions: string[];
    repairAvailable: boolean;
    targetAlreadyPresent: boolean;
    ordinaryPathAvailable: boolean;
}

export const MetadataDocumentRepairResults = {
    COMPLETED: "completed",
    STALE: "stale",
    BLOCKED: "blocked",
    FAILED: "failed",
} as const;

export interface MetadataDocumentRepairRequest {
    actualDocumentId: DocumentID;
    expectedDocumentId: DocumentID;
    sourceRevision: string;
}

export type MetadataDocumentRepairResult = {
    status: (typeof MetadataDocumentRepairResults)[keyof typeof MetadataDocumentRepairResults];
    actualDocumentId: DocumentID;
    expectedDocumentId: DocumentID;
    sourceRevision: string;
    targetCreated: boolean;
    message?: string;
};

/**
 * Classify the logical Metadata namespace before platform path filtering.
 *
 * Internal, customisation, and plug-in storage entries are owned by their
 * dedicated synchronisation paths. The ordinary file scanner handles only the
 * normal namespace.
 */
export function getMetadataDocumentNamespace(value: string): MetadataDocumentNamespace {
    if (value.startsWith(ICXHeader)) return MetadataDocumentNamespaces.CUSTOMISATION;
    if (value.startsWith(ICHeader)) return MetadataDocumentNamespaces.INTERNAL;
    if (value.startsWith(PSCHeader)) return MetadataDocumentNamespaces.PLUGIN_STORAGE;
    return MetadataDocumentNamespaces.NORMAL;
}

/**
 * Inspect whether a Metadata document identifier still represents its
 * declared path under the active path settings.
 *
 * This check deliberately runs before any scanner action. A mismatch can be
 * caused by an old path-obfuscation key, a case-sensitivity change, or a
 * historical rename. Selecting a repair without additional evidence would be
 * destructive, so callers must leave an unresolved document unchanged. A
 * separate consistent document for the same logical path may still proceed
 * through ordinary path-based handling.
 */
export async function inspectMetadataDocumentIdentity(
    host: NecessaryServices<"path", never>,
    doc: MetaEntry
): Promise<MetadataDocumentIdentityInspection> {
    const actualDocumentId = doc._id;
    const declaredPath = getPathFromEntry(host, doc);
    const actualNamespace = getMetadataDocumentNamespace(actualDocumentId);
    const declaredPathNamespace = getMetadataDocumentNamespace(declaredPath);

    if (
        actualNamespace !== MetadataDocumentNamespaces.NORMAL ||
        declaredPathNamespace !== MetadataDocumentNamespaces.NORMAL
    ) {
        if (actualNamespace === declaredPathNamespace) {
            return {
                status: MetadataDocumentIdentityStatuses.EXCLUDED,
                actualDocumentId,
                declaredPath,
                namespace: actualNamespace as Exclude<MetadataDocumentNamespace, "normal">,
            };
        }
        return {
            status: MetadataDocumentIdentityStatuses.UNRESOLVED,
            diagnostic: {
                reason: OfflineScanUnresolvedReasons.NAMESPACE_MISMATCH,
                actualDocumentId,
                declaredPath,
                actualNamespace,
                declaredPathNamespace,
            },
        };
    }

    const expectedDocumentId = await host.services.path.path2id(declaredPath);
    if (actualDocumentId !== expectedDocumentId) {
        return {
            status: MetadataDocumentIdentityStatuses.UNRESOLVED,
            diagnostic: {
                reason: OfflineScanUnresolvedReasons.DOCUMENT_ID_MISMATCH,
                actualDocumentId,
                declaredPath,
                expectedDocumentId,
                actualNamespace,
                declaredPathNamespace,
            },
        };
    }
    return {
        status: MetadataDocumentIdentityStatuses.CONSISTENT,
        actualDocumentId,
        declaredPath,
        expectedDocumentId,
    };
}

type MetadataIdentityObservation = {
    doc: MetaEntry;
    inspection: MetadataDocumentIdentityInspection;
};

type MetadataTargetRow = {
    key: string;
    error?: string;
    value?: { rev?: string; deleted?: boolean };
    doc?: AnyEntry | null;
};

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stableValue(item)])
    );
}

function logicalMetadataPayload(doc: MetaEntry): unknown {
    return stableValue({
        path: doc.path,
        ctime: doc.ctime,
        mtime: doc.mtime,
        size: doc.size,
        type: doc.type,
        children: [...doc.children],
        eden: doc.eden ?? {},
        deleted: Boolean(doc.deleted || doc._deleted),
    });
}

function isExactMetadataCopy(source: MetaEntry, target: MetaEntry): boolean {
    return JSON.stringify(logicalMetadataPayload(source)) === JSON.stringify(logicalMetadataPayload(target));
}

/**
 * Enumerate Metadata from its actual local document IDs and report only the
 * entries which ordinary path-based inspection cannot address.
 *
 * Path-addressed file inspection cannot discover a document whose stored path
 * derives a different ID. The report therefore provides the evidence needed
 * by an existing host-owned repair inspector without adding a batch-repair
 * policy to the scanner.
 */
export async function inspectMetadataDocumentIdentities(
    host: NecessaryServices<"path" | "database" | "setting" | "vault", never>
): Promise<MetadataDocumentIdentityIssue[]> {
    const observations: MetadataIdentityObservation[] = [];
    for await (const doc of host.services.database.localDatabase.findAllNormalDocs({ conflicts: true }) || []) {
        if (!isMetaEntry(doc)) continue;
        const inspection = await inspectMetadataDocumentIdentity(host, doc);
        observations.push({ doc, inspection });
    }

    const expectedTargetIds = unique(
        observations.flatMap(({ inspection }) => {
            if (inspection.status !== MetadataDocumentIdentityStatuses.UNRESOLVED) return [];
            const { diagnostic } = inspection;
            if (
                diagnostic.reason !== OfflineScanUnresolvedReasons.DOCUMENT_ID_MISMATCH ||
                diagnostic.expectedDocumentId === undefined
            ) {
                return [];
            }
            return [diagnostic.expectedDocumentId];
        })
    );
    const targetRows = new Map<string, MetadataTargetRow>();
    if (expectedTargetIds.length > 0) {
        const result = await host.services.database.localDatabase.allDocsRaw({
            keys: expectedTargetIds,
            include_docs: true,
            conflicts: true,
        });
        for (const row of result.rows as MetadataTargetRow[]) targetRows.set(row.key, row);
    }

    const settings = host.services.setting.currentSettings();
    const observationsByDocumentId = new Map(observations.map((observation) => [observation.doc._id, observation]));
    const pathClaims = new Map<string, Set<DocumentID>>();
    const targetClaims = new Map<DocumentID, Set<DocumentID>>();
    for (const { doc, inspection } of observations) {
        const declaredPath =
            inspection.status === MetadataDocumentIdentityStatuses.UNRESOLVED
                ? inspection.diagnostic.declaredPath
                : inspection.declaredPath;
        const declaredNamespace = getMetadataDocumentNamespace(declaredPath);
        if (declaredNamespace === MetadataDocumentNamespaces.NORMAL) {
            const key = convertCase(settings, declaredPath);
            const claims = pathClaims.get(key) ?? new Set<DocumentID>();
            claims.add(doc._id);
            pathClaims.set(key, claims);
        }
        if (
            inspection.status === MetadataDocumentIdentityStatuses.UNRESOLVED &&
            inspection.diagnostic.reason === OfflineScanUnresolvedReasons.DOCUMENT_ID_MISMATCH &&
            inspection.diagnostic.expectedDocumentId !== undefined
        ) {
            const claims = targetClaims.get(inspection.diagnostic.expectedDocumentId) ?? new Set<DocumentID>();
            claims.add(doc._id);
            targetClaims.set(inspection.diagnostic.expectedDocumentId, claims);
        }
    }

    const entries: MetadataDocumentIdentityIssue[] = [];
    for (const { doc, inspection } of observations) {
        if (inspection.status !== MetadataDocumentIdentityStatuses.UNRESOLVED) continue;
        const { diagnostic } = inspection;
        let repairAvailable = false;
        let targetAlreadyPresent = false;
        let ordinaryPathAvailable = false;
        if (
            diagnostic.reason === OfflineScanUnresolvedReasons.DOCUMENT_ID_MISMATCH &&
            diagnostic.expectedDocumentId !== undefined
        ) {
            const expectedDocumentId = diagnostic.expectedDocumentId;
            const normalisedPath = convertCase(settings, diagnostic.declaredPath);
            const targetObservation = observationsByDocumentId.get(expectedDocumentId);
            const targetPath =
                targetObservation?.inspection.status === MetadataDocumentIdentityStatuses.CONSISTENT
                    ? targetObservation.inspection.declaredPath
                    : undefined;
            ordinaryPathAvailable =
                targetPath !== undefined &&
                convertCase(settings, targetPath) === normalisedPath &&
                host.services.vault.isValidPath(targetPath) &&
                !shouldBeIgnored(targetPath) &&
                (await host.services.vault.isTargetFile(targetPath));
            const row = targetRows.get(expectedDocumentId);
            const target = row?.doc;
            const targetMetadata = target && isMetaEntry(target) ? target : undefined;
            targetAlreadyPresent = Boolean(targetMetadata && isExactMetadataCopy(doc, targetMetadata));
            const targetIsAvailable =
                (!row || row.error === "not_found") ||
                (targetAlreadyPresent &&
                    !row?.value?.deleted &&
                    !targetMetadata?._deleted &&
                    !targetMetadata?.deleted &&
                    (targetMetadata?._conflicts?.length ?? 0) === 0);
            const samePathClaims = pathClaims.get(normalisedPath) ?? new Set<DocumentID>();
            const permittedExactPair =
                targetAlreadyPresent &&
                samePathClaims.size === 2 &&
                samePathClaims.has(doc._id) &&
                samePathClaims.has(expectedDocumentId);
            const pathIsUnambiguous = samePathClaims.size === 1 || permittedExactPair;
            const targetIsUnambiguous = (targetClaims.get(expectedDocumentId)?.size ?? 0) === 1;
            repairAvailable =
                Boolean(doc._rev) &&
                !doc.deleted &&
                !doc._deleted &&
                (doc._conflicts?.length ?? 0) === 0 &&
                host.services.vault.isValidPath(diagnostic.declaredPath) &&
                (await host.services.vault.isTargetFile(diagnostic.declaredPath)) &&
                pathIsUnambiguous &&
                targetIsUnambiguous &&
                targetIsAvailable;
        }
        entries.push({
            inspection,
            sourceRevision: doc._rev ?? null,
            logicallyDeleted: Boolean(doc.deleted || doc._deleted),
            conflictRevisions: [...(doc._conflicts ?? [])],
            repairAvailable,
            targetAlreadyPresent,
            ordinaryPathAvailable,
        });
    }
    return entries;
}

function cloneEden(eden: MetaEntry["eden"]): MetaEntry["eden"] {
    return Object.fromEntries(
        Object.entries(eden ?? {}).map(([id, chunk]) => [id, { data: chunk.data, epoch: chunk.epoch }])
    ) as MetaEntry["eden"];
}

function createReaddressedMetadata(source: MetaEntry, expectedDocumentId: DocumentID): MetaEntry {
    return {
        _id: expectedDocumentId,
        path: source.path,
        ctime: source.ctime,
        mtime: source.mtime,
        size: source.size,
        type: source.type,
        children: [...source.children],
        eden: cloneEden(source.eden),
        ...(source.deleted === undefined ? {} : { deleted: source.deleted }),
    } as MetaEntry;
}

async function serializedByMetadataDocumentIds<T>(
    documentIds: readonly DocumentID[],
    callback: () => Promise<T>
): Promise<T> {
    const lockKeys = [...new Set(documentIds)].sort().map((documentId) => `processFileEvent-${documentId}`);
    const acquire = async (index: number): Promise<T> => {
        const key = lockKeys[index];
        if (key === undefined) return await callback();
        return await serialized(key, () => acquire(index + 1));
    };
    return await acquire(0);
}

function findRepairEntry(
    entries: readonly MetadataDocumentIdentityIssue[],
    actualDocumentId: DocumentID
): MetadataDocumentIdentityIssue | undefined {
    return entries.find(
        ({ inspection }) => inspection.diagnostic.actualDocumentId === actualDocumentId
    );
}

/**
 * Repair one previously inspected normal-file Metadata identity.
 *
 * The request identifies the exact source revision which the operator
 * approved. Every precondition is inspected again under the same ordered
 * document locks as file-event handling. The target is created and verified
 * before the source receives a hard tombstone. If interruption leaves that
 * exact target in place, the same single-entry action can safely be repeated.
 */
export async function repairMetadataDocumentIdentity(
    host: NecessaryServices<"path" | "database" | "setting" | "vault" | "keyValueDB", never>,
    request: MetadataDocumentRepairRequest
): Promise<MetadataDocumentRepairResult> {
    const baseResult = {
        actualDocumentId: request.actualDocumentId,
        expectedDocumentId: request.expectedDocumentId,
        sourceRevision: request.sourceRevision,
        targetCreated: false,
    };

    return await serializedByMetadataDocumentIds(
        [request.actualDocumentId, request.expectedDocumentId],
        async (): Promise<MetadataDocumentRepairResult> => {
            let targetCreated = false;
            try {
                const entries = await inspectMetadataDocumentIdentities(host);
                const entry = findRepairEntry(entries, request.actualDocumentId);
                if (
                    !entry ||
                    entry.sourceRevision !== request.sourceRevision ||
                    entry.inspection.diagnostic.reason !== OfflineScanUnresolvedReasons.DOCUMENT_ID_MISMATCH ||
                    entry.inspection.diagnostic.expectedDocumentId !== request.expectedDocumentId
                ) {
                    return {
                        ...baseResult,
                        status: MetadataDocumentRepairResults.STALE,
                        message: "The inspected source revision or expected document ID has changed.",
                    };
                }

                if (!entry.repairAvailable) {
                    return {
                        ...baseResult,
                        status: MetadataDocumentRepairResults.BLOCKED,
                        message: "The source no longer satisfies the repair preconditions.",
                    };
                }

                const source = await host.services.database.localDatabase.getRaw<MetaEntry>(request.actualDocumentId, {
                    rev: request.sourceRevision,
                    conflicts: true,
                });
                if (!isMetaEntry(source) || source._rev !== request.sourceRevision) {
                    return {
                        ...baseResult,
                        status: MetadataDocumentRepairResults.STALE,
                        message: "The source revision changed during repair validation.",
                    };
                }

                await clearOfflineScannerLastSeen(host, entry.inspection.diagnostic.declaredPath);

                if (!entry.targetAlreadyPresent) {
                    await host.services.database.localDatabase.putRaw(
                        createReaddressedMetadata(source, request.expectedDocumentId)
                    );
                    targetCreated = true;
                }

                const target = await host.services.database.localDatabase.getRaw<MetaEntry>(
                    request.expectedDocumentId,
                    { conflicts: true }
                );
                if (
                    !isMetaEntry(target) ||
                    target.deleted ||
                    target._deleted ||
                    (target._conflicts?.length ?? 0) > 0 ||
                    !isExactMetadataCopy(source, target)
                ) {
                    return {
                        ...baseResult,
                        targetCreated,
                        status: MetadataDocumentRepairResults.FAILED,
                        message: "The repair target could not be verified as an exact local copy.",
                    };
                }

                await host.services.database.localDatabase.removeRaw(request.actualDocumentId, request.sourceRevision);
                return {
                    ...baseResult,
                    targetCreated,
                    status: MetadataDocumentRepairResults.COMPLETED,
                };
            } catch (error) {
                return {
                    ...baseResult,
                    targetCreated,
                    status: MetadataDocumentRepairResults.FAILED,
                    message: error instanceof Error ? error.message : `${error}`,
                };
            }
        }
    );
}

/**
 * Collect deleted files that have expired according to retention policy.
 * @param host Services container
 * @param log Logging function
 * @returns Array of expired deletion history
 */
export async function collectDeletedFiles(
    host: NecessaryServices<"setting" | "database" | "path", never>,
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
                if (isMetaEntry(doc)) {
                    const identity = await inspectMetadataDocumentIdentity(host, doc);
                    if (identity.status === MetadataDocumentIdentityStatuses.UNRESOLVED) {
                        log(
                            `Expired deletion history has an unresolved Metadata identity and will be left unchanged: ${identity.diagnostic.declaredPath} (${identity.diagnostic.reason})`,
                            LOG_LEVEL_INFO
                        );
                        continue;
                    }
                }
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
                await host.serviceModules.fileHandler.storeFileToDB(file);
                return FilePairProcessResults.COMPLETED;
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
            log("STORAGE == DB :" + file.path + "", LOG_LEVEL_DEBUG);
            return FilePairProcessResults.COMPLETED;
        default:
            log("STORAGE ?? DB :" + file.path + " Something got weird");
            return FilePairProcessResults.FAILED;
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
        if (shouldBeIgnored(f.path)) continue;
        if (await host.services.vault.isTargetFile(f.path)) {
            _filesStorage.push(f);
        }
    }

    const storageFileNameMap = Object.fromEntries(_filesStorage.map((e) => [e.path, e]));

    const storageFileNames = Object.keys(storageFileNameMap) as FilePathWithPrefix[];

    const storageFileNameCapsPair = storageFileNames.map((e) => [e, convertCase(settings, e)]);

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
    const databaseFileNameCapsPair = databaseFileNames.map((e) => [e, convertCase(settings, e)] as const);
    const databaseFileNameCI2CS = Object.fromEntries(databaseFileNameCapsPair.map((e) => [e[1], e[0]])) as Record<
        FilePathWithPrefixLC,
        FilePathWithPrefix
    >;

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
        await host.serviceModules.fileHandler.storeFileToDB(file);
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
    doc: MetaEntry
): Promise<FilePairProcessResult> {
    // Prevent applying the conflicted state to the storage.
    if ((doc._conflicts?.length ?? 0) > 0) {
        log(`SYNC DATABASE AND STORAGE: ${file.path} has conflicts. skipped`, LOG_LEVEL_INFO);
        return FilePairProcessResults.SKIPPED;
    }
    if (!host.services.vault.isFileSizeTooLarge(file.stat.size) && !host.services.vault.isFileSizeTooLarge(doc.size)) {
        return await syncFileBetweenDBandStorage(host, log, file, doc);
    } else {
        log(
            `SYNC DATABASE AND STORAGE: ${getPathFromEntry(host, doc)} has been skipped due to file size exceeding the limit`,
            logLevel
        );
        return FilePairProcessResults.SKIPPED;
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
    /**
     * Allow a completed scan containing individual file-pair failures to
     * satisfy ordinary application readiness. Scan preconditions remain
     * strict, and failed pairs remain retryable.
     */
    continueOnFileFailure?: boolean;
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
): Promise<FilePairProcessResult> {
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
                const syncResult = await syncStorageAndDatabase(host, log, file, LOG_LEVEL_INFO, doc);
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
 * Synchronise all files between database and storage based on the selected mode and options.
 * @param host Core
 * @param log Logging function
 * @param errorManager Error manager
 * @param options Full scan options
 * @returns The scan result for all file pairs
 */
export async function synchroniseAllFilesBetweenDBandStorage(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options: FullScanOptions
): Promise<VaultScanResult> {
    const settings = host.services.setting.currentSettings();
    const showingNotice = options.showingNotice ?? false;
    await loadFileStatus(host);
    const { storageFileNameMap, storageFileNameCI2CS } = await collectFilesOnStorage(host, settings, log);
    const { databaseFileNameMap, databaseFileNameCI2CS, quarantinedFileNamesLC } =
        await collectDatabaseFiles(host, settings, log, showingNotice);

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

    log(`Total files to synchronise: ${pairs.length}`, LOG_LEVEL_VERBOSE, "syncAll");
    let completedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    for await (const { path, result } of withConcurrency(
        pairs,
        async (e) => {
            const path = e.file?.path ?? getPathFromEntry(host, e.doc);
            try {
                return { path, result: await processFilePair(host, log, e, options) };
            } catch (ex) {
                log(`Error while synchronising files`, LOG_LEVEL_NOTICE);
                log(ex, LOG_LEVEL_VERBOSE);
                return { path, result: FilePairProcessResults.FAILED };
            }
        },
        10
    )) {
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
    saveFileStatus(host, true);
    if (failedCount === 0) return VaultScanResults.COMPLETED;
    return options.continueOnFileFailure === true
        ? VaultScanResults.COMPLETED_WITH_FILE_FAILURES
        : VaultScanResults.FAILED;
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
const FILE_STATUS_MAP_KEY = "fileStatusMap";
const FILE_STATUS_MAP_LOCK = "offlineScanner-fileStatusMap";
// Load file modification times from the key-value database into the in-memory map.
async function loadFileStatus(host: NecessaryServices<"keyValueDB", never>) {
    await serialized(FILE_STATUS_MAP_LOCK, async () => {
        const kvDB = host.services.keyValueDB.kvDB as
            | { get?: <T = unknown>(key: string) => Promise<T | undefined> }
            | undefined;
        if (!kvDB?.get) {
            fileMaps = new Map();
            return;
        }
        const mapItems = (await kvDB.get<Record<string, number>>(FILE_STATUS_MAP_KEY)) || {};
        fileMaps = new Map(Object.entries(mapItems));
    });
}
// Save the current state of file modification times from the in-memory map to the key-value database.
async function _saveFileStatus(host: NecessaryServices<"keyValueDB", never>) {
    await serialized(FILE_STATUS_MAP_LOCK, async () => {
        const kvDB = host.services.keyValueDB.kvDB as
            | { set?: (key: string, value: unknown) => Promise<unknown> }
            | undefined;
        if (!kvDB?.set) {
            return;
        }
        await kvDB.set(FILE_STATUS_MAP_KEY, Object.fromEntries(fileMaps));
    });
}

/**
 * Remove one path from the Offline Scanner's durable last-seen state.
 *
 * Identity repair calls this before publishing a correctly addressed target.
 * Otherwise an old record of local presence could make the next NEWER_WINS
 * scan interpret that database-only target as a later local deletion.
 */
export async function clearOfflineScannerLastSeen(
    host: NecessaryServices<"setting" | "keyValueDB", never>,
    path: FilePathWithPrefix
): Promise<void> {
    const key = convertCase(host.services.setting.currentSettings(), path);
    if (saveFileStatusTimeout !== null) {
        compatGlobal.clearTimeout(saveFileStatusTimeout);
        saveFileStatusTimeout = null;
    }
    await serialized(FILE_STATUS_MAP_LOCK, async () => {
        fileMaps.delete(key);
        const kvDB = host.services.keyValueDB.kvDB as
            | {
                  get?: <T = unknown>(key: string) => Promise<T | undefined>;
                  set?: (key: string, value: unknown) => Promise<unknown>;
              }
            | undefined;
        if (!kvDB?.set) return;
        const persisted = kvDB.get
            ? (await kvDB.get<Record<string, number>>(FILE_STATUS_MAP_KEY)) || {}
            : Object.fromEntries(fileMaps);
        const next = { ...persisted, ...Object.fromEntries(fileMaps) };
        delete next[key];
        await kvDB.set(FILE_STATUS_MAP_KEY, next);
    });
}

let saveFileStatusTimeout: number | null = null;
// Schedule saving file status with throttling to prevent excessive writes and CPU usage.
function saveFileStatus(host: NecessaryServices<"keyValueDB", never>, immediate = false) {
    if (immediate) {
        if (saveFileStatusTimeout !== null) compatGlobal.clearTimeout(saveFileStatusTimeout);
        saveFileStatusTimeout = compatGlobal.setTimeout(() => {
            saveFileStatusTimeout = null;
            void _saveFileStatus(host);
        }, 0);
        return;
    }

    if (saveFileStatusTimeout === null) {
        saveFileStatusTimeout = compatGlobal.setTimeout(() => {
            saveFileStatusTimeout = null;
            void _saveFileStatus(host);
        }, 1000);
    }
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
 * @param showingNoticeOrOptions Full-scan options, or the legacy notice flag
 * @param ignoreSuspending Legacy suspension flag used with the notice flag
 * @returns The scan outcome, including accepted individual file failures
 */
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options?: Partial<FullScanOptions>
): Promise<VaultScanResult>;
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNotice?: boolean,
    ignoreSuspending?: boolean
): Promise<VaultScanResult>;
export async function performFullScan(
    host: NecessaryServices<
        "setting" | "vault" | "path" | "fileProcessing" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNoticeOrOptions: Partial<FullScanOptions> | boolean = false,
    ignoreSuspending: boolean = false
): Promise<VaultScanResult> {
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

    log("Initialize and checking database files");
    log("Checking deleted files");
    await collectDeletedFiles(host, log);
    const scanResult = await synchroniseAllFilesBetweenDBandStorage(host, log, errorManager, options);

    log("Initialized, NOW TRACKING!");
    if (!isInitialized) {
        await host.services.keyValueDB.kvDB.set("initialized", true);
    }
    if (showingNotice) {
        log("Initialize done!", LOG_LEVEL_NOTICE, "syncAll");
    }
    return scanResult;
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
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle, host.services.context.events);

    // Handler for vault scanning
    const handleScanVault = async (
        showingNotice?: boolean,
        ignoreSuspending: boolean = false,
        continueOnFileFailure: boolean = false
    ): Promise<VaultScanResult> => {
        return await performFullScan(host, log, errorManager, {
            showingNotice,
            ignoreSuspending,
            continueOnFileFailure,
        });
    };
    // Bind handlers to lifecycle events
    host.services.vault.scanVault.addHandler(handleScanVault);
}
