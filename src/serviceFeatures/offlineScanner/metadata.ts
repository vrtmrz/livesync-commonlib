import type PouchDB from "pouchdb-core";
import { unique } from "octagonal-wheels/collection";
import { withLocks } from "octagonal-wheels/concurrency/lock.scoped";
import {
    LOG_LEVEL_INFO,
    type EntryDoc,
    type DocumentID,
    type FilePathWithPrefix,
    type MetaEntry,
    isMetaEntry,
    type AnyEntry,
} from "@lib/common/types";
import { isAnyNote } from "@lib/common/utils";
import { shouldBeIgnored } from "@lib/string_and_binary/path";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { IPathService } from "@lib/services/base/IService";
import type { LogFunction } from "@lib/services/lib/logUtils";
import { ICHeader, ICXHeader, PSCHeader } from "@lib/common/models/fileaccess.const";
import {
    MetadataDocumentNamespaces,
    MetadataDocumentIdentityStatuses,
    OfflineScanUnresolvedReasons,
    MetadataDocumentRepairResults,
    type MetadataDocumentNamespace,
    type MetadataDocumentIdentityInspection,
    type MetadataDocumentIdentityIssue,
    type MetadataDocumentRepairRequest,
    type MetadataDocumentRepairResult,
} from "./types";
import { convertCase, getPathFromEntry } from "./paths";
import { clearOfflineScannerLastSeen } from "./fileStatus";

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
    host: { services: { path: Pick<IPathService, "getPath" | "path2id"> } },
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
                !row ||
                row.error === "not_found" ||
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
    return await withLocks(lockKeys, callback);
}

function findRepairEntry(
    entries: readonly MetadataDocumentIdentityIssue[],
    actualDocumentId: DocumentID
): MetadataDocumentIdentityIssue | undefined {
    return entries.find(({ inspection }) => inspection.diagnostic.actualDocumentId === actualDocumentId);
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
