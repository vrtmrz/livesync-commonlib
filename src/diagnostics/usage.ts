export interface DatabaseUsageGetOptions {
    revs?: boolean;
    revs_info?: boolean;
    conflicts?: boolean;
    rev?: string;
}

export interface DatabaseUsageSource {
    info(): Promise<{ update_seq?: string | number }>;
    enumerateIds(): AsyncIterable<string>;
    get(id: string, options?: DatabaseUsageGetOptions): Promise<object | null | undefined>;
}

export interface DatabaseUsageProgress {
    idsProcessed: number;
    revisionsProcessed: number;
}

export type DatabaseUsageStatus = "complete" | "partial" | "failed" | "cancelled";

export type DatabaseUsageErrorCode =
    | "start_info_read_failed"
    | "start_update_seq_unavailable"
    | "end_info_read_failed"
    | "end_update_seq_unavailable"
    | "configuration_changed"
    | "id_enumeration_failed"
    | "revision_list_read_failed"
    | "revision_not_found"
    | "revision_read_failed"
    | "revision_document_invalid";

export interface DatabaseUsageError {
    code: DatabaseUsageErrorCode;
    id?: string;
    revision?: string;
}

export interface DatabaseUsageRow {
    title: string;
    id: string;
    path: string;
    revision: string;
    rev: string;
    revHash: string;
    uniqueChunkCount: number;
    sharedChunkCount: number;
    uniqueChunkSize: number;
    sharedChunkSize: number;
}

export interface DatabaseUsageResult {
    version: 1;
    kind: "usage";
    status: DatabaseUsageStatus;
    startUpdateSeq?: string | number;
    endUpdateSeq?: string | number;
    changedDuringRun?: boolean;
    rows: DatabaseUsageRow[];
    errors: DatabaseUsageError[];
}

interface RevisionInfo {
    rev?: unknown;
    status?: unknown;
}

interface UsageDocumentFields {
    _id?: unknown;
    _rev?: unknown;
    _deleted?: unknown;
    _revs_info?: unknown;
    type?: unknown;
    children?: unknown;
    path?: unknown;
    data?: unknown;
}

interface DocumentRevision {
    id: string;
    revision: string;
    path: string;
    chunks: Set<string>;
    uniqueChunks: Set<string>;
    sharedChunks: Set<string>;
}

interface ChunkInfo {
    length: number;
    refCount: number;
}

function asRecord(value: object): UsageDocumentFields {
    return value as UsageDocumentFields;
}

function getRevisionNumber(revision: string): string {
    const generation = revision.split("-")[0];
    return `${generation ? Number.parseInt(generation) : 0}`;
}

function getRevisionHash(revision: string): string {
    const hash = revision.split("-")[1];
    if (hash === undefined) throw new Error("invalid revision");
    return hash.substring(0, 6);
}

function getRevisionInfos(value: unknown): RevisionInfo[] {
    if (!Array.isArray(value)) return [];
    return value as RevisionInfo[];
}

function getChildren(value: unknown): Set<string> {
    return new Set((value || []) as string[]);
}

function getStringField(value: unknown): string {
    if (typeof value !== "string") throw new Error("invalid document field");
    return value;
}

export async function analyseDatabaseUsage(options: {
    source: DatabaseUsageSource;
    signal?: AbortSignal;
    onProgress?: (progress: DatabaseUsageProgress) => void;
}): Promise<DatabaseUsageResult> {
    const { source, signal, onProgress } = options;
    const errors: DatabaseUsageError[] = [];
    const documentMap = new Map<string, DocumentRevision[]>();
    const chunkMap = new Map<string, ChunkInfo>();
    const progress: DatabaseUsageProgress = { idsProcessed: 0, revisionsProcessed: 0 };
    let startUpdateSeq: string | number | undefined;
    let endUpdateSeq: string | number | undefined;
    let enumerationFailed = false;
    const reportProgress = () => onProgress?.({ ...progress });
    const isCancelled = () => signal?.aborted === true;
    let cancelled = isCancelled();

    if (!cancelled) {
        try {
            const info = await source.info();
            startUpdateSeq = info.update_seq;
            if (startUpdateSeq === undefined) errors.push({ code: "start_update_seq_unavailable" });
        } catch {
            errors.push({ code: "start_info_read_failed" });
        }
        if (isCancelled()) cancelled = true;
    }

    try {
        if (!cancelled && !isCancelled()) {
            for await (const id of source.enumerateIds()) {
                if (isCancelled()) {
                    cancelled = true;
                    break;
                }

                let revisionInfos: RevisionInfo[] = [];
                let revisionList: object | null | undefined;
                let revisionListReadFailed = false;
                try {
                    revisionList = await source.get(id, { revs: true, revs_info: true, conflicts: true });
                } catch {
                    if (!isCancelled()) {
                        errors.push({ code: "revision_list_read_failed", id });
                        revisionListReadFailed = true;
                    }
                }
                if (isCancelled()) {
                    cancelled = true;
                    break;
                }
                if (revisionList) revisionInfos = getRevisionInfos(asRecord(revisionList)._revs_info);
                else if (!revisionListReadFailed) {
                    errors.push({ code: "revision_list_read_failed", id });
                }

                progress.idsProcessed++;
                reportProgress();

                for (const revisionInfo of revisionInfos) {
                    if (isCancelled()) {
                        cancelled = true;
                        break;
                    }
                    if (revisionInfo.status !== "available") continue;
                    const revision = typeof revisionInfo.rev === "string" ? revisionInfo.rev : undefined;
                    if (revision === undefined) {
                        errors.push({ code: "revision_document_invalid", id });
                        continue;
                    }

                    progress.revisionsProcessed++;
                    let rawDocument: object | null | undefined;
                    try {
                        rawDocument = await source.get(id, { rev: revision });
                    } catch {
                        if (isCancelled()) {
                            cancelled = true;
                            reportProgress();
                            break;
                        }
                        errors.push({ code: "revision_read_failed", id, revision });
                        reportProgress();
                        continue;
                    }
                    if (isCancelled()) {
                        cancelled = true;
                        reportProgress();
                        break;
                    }
                    if (!rawDocument) {
                        errors.push({ code: "revision_not_found", id, revision });
                        reportProgress();
                        continue;
                    }

                    try {
                        const document = asRecord(rawDocument);
                        if ("children" in document) {
                            const documentId = getStringField(document._id);
                            const documentRevision = getStringField(document._rev);
                            const path = getStringField(document.path);
                            const chunks = getChildren(document.children);
                            const revisions = documentMap.get(documentId) ?? [];
                            revisions.push({
                                id: documentId,
                                revision: documentRevision,
                                path,
                                chunks,
                                uniqueChunks: new Set(),
                                sharedChunks: new Set(),
                            });
                            documentMap.set(documentId, revisions);
                        } else if (document.type === "leaf") {
                            const chunkId = getStringField(document._id);
                            if (!chunkMap.has(chunkId) && !document._deleted) {
                                if (typeof document.data !== "string") throw new Error("invalid chunk data");
                                chunkMap.set(chunkId, { length: document.data.length, refCount: 0 });
                            }
                        }
                    } catch {
                        errors.push({ code: "revision_document_invalid", id, revision });
                    }
                    reportProgress();
                }

                if (isCancelled()) cancelled = true;
                if (cancelled) break;
            }
        } else if (isCancelled()) {
            cancelled = true;
        }
    } catch {
        if (isCancelled()) cancelled = true;
        else {
            enumerationFailed = true;
            errors.push({ code: "id_enumeration_failed" });
        }
    }

    // Keep the historical first-reference unique and later-reference shared accounting.
    for (const revisions of documentMap.values()) {
        for (const document of revisions) {
            for (const chunkId of document.chunks) {
                const chunk = chunkMap.get(chunkId);
                if (!chunk) continue;
                if (chunk.refCount === 0) document.uniqueChunks.add(chunkId);
                else document.sharedChunks.add(chunkId);
                chunk.refCount++;
            }
        }
    }

    const totalSize = (ids: Set<string>) => {
        let size = 0;
        for (const id of ids) size += chunkMap.get(id)?.length ?? 0;
        return size;
    };

    const rows: DatabaseUsageRow[] = [];
    for (const revisions of documentMap.values()) {
        for (const document of revisions) {
            const revisionNumber = getRevisionNumber(document.revision);
            let revisionHash: string;
            try {
                revisionHash = getRevisionHash(document.revision);
            } catch {
                errors.push({ code: "revision_document_invalid", id: document.id, revision: document.revision });
                continue;
            }
            rows.push({
                title: `${document.path} (${document.revision})`,
                id: document.id,
                path: document.path,
                revision: document.revision,
                rev: revisionNumber,
                revHash: revisionHash,
                uniqueChunkCount: document.uniqueChunks.size,
                sharedChunkCount: document.sharedChunks.size,
                uniqueChunkSize: totalSize(document.uniqueChunks),
                sharedChunkSize: totalSize(document.sharedChunks),
            });
        }
    }

    const orphanChunks = [...chunkMap.entries()].filter(([, chunk]) => chunk.refCount === 0);
    rows.push({
        title: "__orphan",
        id: "__orphan",
        path: "__orphan",
        revision: "1-xxxxx",
        rev: "1",
        revHash: "xxxxx",
        uniqueChunkCount: orphanChunks.length,
        sharedChunkCount: 0,
        uniqueChunkSize: orphanChunks.reduce((size, [, chunk]) => size + chunk.length, 0),
        sharedChunkSize: 0,
    });

    if (!cancelled && !isCancelled()) {
        try {
            const info = await source.info();
            endUpdateSeq = info.update_seq;
            if (endUpdateSeq === undefined) errors.push({ code: "end_update_seq_unavailable" });
        } catch {
            errors.push({ code: "end_info_read_failed" });
        }
    }

    if (isCancelled()) cancelled = true;
    const changedDuringRun =
        startUpdateSeq === undefined || endUpdateSeq === undefined ? undefined : startUpdateSeq !== endUpdateSeq;
    const snapshotUncertain = startUpdateSeq === undefined || endUpdateSeq === undefined;
    const hasDocumentRows = rows.length > 1;
    let status: DatabaseUsageStatus;
    if (cancelled) status = "cancelled";
    else if (changedDuringRun === true || snapshotUncertain) status = "partial";
    else if (enumerationFailed && !hasDocumentRows) status = "failed";
    else if (errors.length > 0) status = "partial";
    else status = "complete";

    return {
        version: 1,
        kind: "usage",
        status,
        ...(startUpdateSeq === undefined ? {} : { startUpdateSeq }),
        ...(endUpdateSeq === undefined ? {} : { endUpdateSeq }),
        ...(changedDuringRun === undefined ? {} : { changedDuringRun }),
        rows,
        errors,
    };
}
