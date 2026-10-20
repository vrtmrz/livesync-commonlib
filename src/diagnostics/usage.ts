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
    phase: "reading" | "accounting";
    idsProcessed: number;
    revisionsProcessed: number;
    processed: number;
    total: number;
    totalIsFinal: boolean;
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
    uniqueChunkSize: number;
    sharedChunkSize: number;
}

interface ChunkInfo {
    length: number;
    refCount: number;
}

const USAGE_ACCOUNTING_YIELD_EVERY = 64;

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
    const children: unknown = value ?? [];
    if (!Array.isArray(children) || !children.every((child) => typeof child === "string")) {
        throw new Error("invalid chunk references");
    }
    return new Set(children);
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
    const progress: DatabaseUsageProgress = {
        phase: "reading",
        idsProcessed: 0,
        revisionsProcessed: 0,
        processed: 0,
        total: 0,
        totalIsFinal: false,
    };
    let startUpdateSeq: string | number | undefined;
    let endUpdateSeq: string | number | undefined;
    let enumerationFailed = false;
    const reportProgress = () => {
        try {
            onProgress?.({ ...progress });
        } catch {
            // Progress observers do not participate in the analysis result.
        }
    };
    const isCancelled = () => signal?.aborted === true;
    let cancelled = isCancelled();
    let documentRevisionCount = 0;
    let referenceCount = 0;

    reportProgress();
    if (isCancelled()) cancelled = true;

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

    let enumerationFinished = false;
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
                for (const revisionInfo of revisionInfos) {
                    if (revisionInfo.status === "available" && typeof revisionInfo.rev === "string") {
                        progress.total++;
                    }
                }
                reportProgress();
                if (isCancelled()) {
                    cancelled = true;
                    break;
                }

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

                    let rawDocument: object | null | undefined;
                    try {
                        rawDocument = await source.get(id, { rev: revision });
                    } catch {
                        if (isCancelled()) {
                            cancelled = true;
                            break;
                        }
                        errors.push({ code: "revision_read_failed", id, revision });
                        progress.revisionsProcessed++;
                        progress.processed++;
                        reportProgress();
                        continue;
                    }
                    if (isCancelled()) {
                        cancelled = true;
                        break;
                    }
                    if (!rawDocument) {
                        errors.push({ code: "revision_not_found", id, revision });
                        progress.revisionsProcessed++;
                        progress.processed++;
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
                                uniqueChunkSize: 0,
                                sharedChunkSize: 0,
                            });
                            documentMap.set(documentId, revisions);
                            documentRevisionCount++;
                            referenceCount += chunks.size;
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
                    progress.revisionsProcessed++;
                    progress.processed++;
                    reportProgress();
                }

                if (isCancelled()) cancelled = true;
                if (cancelled) break;
            }
            if (!cancelled && !isCancelled()) enumerationFinished = true;
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

    if (isCancelled()) cancelled = true;
    if (enumerationFinished) {
        progress.totalIsFinal = true;
        reportProgress();
        if (isCancelled()) cancelled = true;
    }

    const readingWasCancelled = cancelled;
    progress.phase = "accounting";
    progress.processed = 0;
    progress.total = referenceCount + documentRevisionCount + chunkMap.size;
    progress.totalIsFinal = true;
    reportProgress();

    let accountingCancelled = !readingWasCancelled && isCancelled();
    const rows: DatabaseUsageRow[] = [];
    const accountingErrors: DatabaseUsageError[] = [];
    const recordAccountingWork = () => {
        progress.processed++;
        return progress.processed % USAGE_ACCOUNTING_YIELD_EVERY === 0;
    };
    const yieldAfterAccountingBatch = async (): Promise<boolean> => {
        reportProgress();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return readingWasCancelled || !isCancelled();
    };

    if (!readingWasCancelled && isCancelled()) accountingCancelled = true;

    if (!accountingCancelled) {
        // Keep the historical first-reference unique and later-reference shared accounting.
        for (const revisions of documentMap.values()) {
            for (const document of revisions) {
                for (const chunkId of document.chunks) {
                    const chunk = chunkMap.get(chunkId);
                    if (chunk) {
                        if (chunk.refCount === 0) {
                            document.uniqueChunks.add(chunkId);
                            document.uniqueChunkSize += chunk.length;
                        } else {
                            document.sharedChunks.add(chunkId);
                            document.sharedChunkSize += chunk.length;
                        }
                        chunk.refCount++;
                    }
                    if (recordAccountingWork() && !(await yieldAfterAccountingBatch())) {
                        accountingCancelled = true;
                        break;
                    }
                }
                if (accountingCancelled) break;
            }
            if (accountingCancelled) break;
        }
    }

    if (!accountingCancelled) {
        for (const revisions of documentMap.values()) {
            for (const document of revisions) {
                const revisionNumber = getRevisionNumber(document.revision);
                let revisionHash: string;
                try {
                    revisionHash = getRevisionHash(document.revision);
                } catch {
                    accountingErrors.push({
                        code: "revision_document_invalid",
                        id: document.id,
                        revision: document.revision,
                    });
                    if (recordAccountingWork() && !(await yieldAfterAccountingBatch())) {
                        accountingCancelled = true;
                        break;
                    }
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
                    uniqueChunkSize: document.uniqueChunkSize,
                    sharedChunkSize: document.sharedChunkSize,
                });
                if (recordAccountingWork() && !(await yieldAfterAccountingBatch())) {
                    accountingCancelled = true;
                    break;
                }
            }
            if (accountingCancelled) break;
        }
    }

    let orphanChunkCount = 0;
    let orphanChunkSize = 0;
    if (!accountingCancelled) {
        for (const chunk of chunkMap.values()) {
            if (chunk.refCount === 0) {
                orphanChunkCount++;
                orphanChunkSize += chunk.length;
            }
            if (recordAccountingWork() && !(await yieldAfterAccountingBatch())) {
                accountingCancelled = true;
                break;
            }
        }
    }

    if (accountingCancelled) {
        cancelled = true;
        rows.length = 0;
    } else {
        errors.push(...accountingErrors);
        rows.push({
            title: "__orphan",
            id: "__orphan",
            path: "__orphan",
            revision: "1-xxxxx",
            rev: "1",
            revHash: "xxxxx",
            uniqueChunkCount: orphanChunkCount,
            sharedChunkCount: 0,
            uniqueChunkSize: orphanChunkSize,
            sharedChunkSize: 0,
        });
    }

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
    reportProgress();
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
