import {
    DOCID_SYNC_PARAMETERS,
    EntryTypes,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    SYNCINFO_ID,
    VERSIONING_DOCID,
    type AnyEntry,
    type EntryDoc,
    type LoadedEntry,
    type MetaEntry,
} from "../common/types.ts";
import type {
    DatabaseIntegrityOptions,
    DatabaseIntegrityResult,
    DatabaseIntegrityLog,
    DiagnosticContent,
    DiagnosticCoverage,
    DiagnosticDatabaseSource,
    DiagnosticDocumentReadResult,
    DiagnosticError,
    DiagnosticObservation,
    DiagnosticPathEquivalenceGroup,
    DiagnosticReason,
    DiagnosticSourceName,
} from "./types.ts";
import { isChunk } from "../common/typeUtils.ts";
import { readAsBlob } from "../common/utils.ts";
import {
    inspectMetadataDocumentIdentity,
    MetadataDocumentIdentityStatuses,
} from "../serviceFeatures/offlineScanner.ts";
import { DiagnosticReadError } from "./types.ts";

type CurrentMetadata = MetaEntry & {
    _rev: string;
    _deleted?: boolean;
    _conflicts?: string[];
};

interface InternalObservation {
    report: DiagnosticObservation;
    source: DiagnosticDatabaseSource;
    document: CurrentMetadata;
}

interface SourceRun {
    name: DiagnosticSourceName;
    source: DiagnosticDatabaseSource;
    coverage: DiagnosticCoverage;
    errors: DiagnosticError[];
    observations: InternalObservation[];
    metadataScanComplete: boolean;
    enumerationComplete: boolean;
    endInfoAvailable: boolean;
    startSeq?: string | number;
    endSeq?: string | number;
}

interface IntegrityGroup {
    key: string;
    observations: InternalObservation[];
    suspect: boolean;
}

interface ContentReadOutcome {
    content: DiagnosticContent;
    chunksRead: number;
    unavailableChunks: { id: string; status: "missing" | "unreadable" }[];
}

const EXCLUDED_IDS = new Set<string>([
    DOCID_SYNC_PARAMETERS,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    SYNCINFO_ID,
    VERSIONING_DOCID,
]);

const INITIAL_COVERAGE: DiagnosticCoverage = {
    status: "not-checked",
    documents: 0,
    metadata: 0,
    excluded: 0,
    conflictBranches: 0,
    contentReads: 0,
    changedDuringRun: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isRecordedSize(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function isCurrentMetadata(value: unknown): value is CurrentMetadata {
    return isRecord(value) && (value.type === EntryTypes.NOTE_BINARY || value.type === EntryTypes.NOTE_PLAIN);
}

function isValidCurrentMetadata(value: CurrentMetadata): boolean {
    return (
        typeof value._id === "string" &&
        typeof value._rev === "string" &&
        typeof value.path === "string" &&
        Array.isArray(value.children) &&
        value.children.every((child) => typeof child === "string")
    );
}

function isMissingRead(error: unknown): boolean {
    if (error instanceof DiagnosticReadError) return error.missing;
    if (!isRecord(error)) return false;
    return error.status === 404 || error.name === "not_found" || error.error === "not_found";
}

function reasonFromReadError(error: unknown, fallback: DiagnosticReason): DiagnosticReason {
    return error instanceof DiagnosticReadError ? error.reason : fallback;
}

function hasUpdateSequence(value: string | number | undefined): value is string | number {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function appendError(
    errors: DiagnosticError[],
    source: DiagnosticError["source"],
    reason: DiagnosticReason,
    details: Pick<DiagnosticError, "id" | "revision" | "path" | "chunkId"> = {}
): void {
    errors.push({ source, reason, ...details });
}

function concurrencyLimit(options: DatabaseIntegrityOptions): number {
    return Number.isFinite(options.concurrency) ? Math.max(1, Math.min(16, Math.floor(options.concurrency!))) : 4;
}

class InspectionPhase {
    processed = 0;
    total?: number;
    private readonly started = performance.now();
    private lastLog = this.started;
    private activeReads = 0;
    private peakActiveReads = 0;
    private readOperations = 0;
    private readDurationMs = 0;

    constructor(
        private readonly options: DatabaseIntegrityOptions,
        private readonly phase: DatabaseIntegrityLog["phase"],
        private readonly source?: DiagnosticSourceName
    ) {
        this.log("started");
    }

    async read<T>(read: () => Promise<T>, documents = 1): Promise<T> {
        const started = performance.now();
        this.readOperations += documents;
        this.peakActiveReads = Math.max(this.peakActiveReads, ++this.activeReads);
        try {
            return await read();
        } finally {
            this.activeReads--;
            this.readDurationMs += performance.now() - started;
        }
    }

    update(): void {
        if (this.total !== undefined) this.total = Math.max(this.total, this.processed);
        if (this.phase !== "grouping") {
            try {
                this.options.onProgress?.({
                    phase: this.phase,
                    source: this.source,
                    processed: this.processed,
                    total: this.total,
                    elapsedMs: Math.round(performance.now() - this.started),
                });
            } catch {
                // Progress reporting is advisory and must not interrupt inspection.
            }
        }
        if (performance.now() - this.lastLog >= 5000) this.log("progress");
    }

    log(event: DatabaseIntegrityLog["event"]): void {
        this.lastLog = performance.now();
        try {
            this.options.onLog?.({
                phase: this.phase,
                source: this.source,
                event,
                processed: this.processed,
                total: this.total,
                elapsedMs: Math.round(this.lastLog - this.started),
                concurrency: concurrencyLimit(this.options),
                activeReads: this.activeReads,
                peakActiveReads: this.peakActiveReads,
                readOperations: this.readOperations,
                readDurationMs: Math.round(this.readDurationMs),
            });
        } catch {
            // Logging is advisory and must not interrupt inspection.
        }
    }
}

/** Bound both in-flight work and retained results, and drain reads before closing a source. */
async function inspectBatches<T, R>(
    items: AsyncIterable<T> | Iterable<T>,
    options: DatabaseIntegrityOptions,
    inspect: (item: T) => Promise<R>,
    merge: (result: R) => void
): Promise<boolean> {
    const pending: Promise<R>[] = [];
    const drain = async () => {
        const results = await Promise.allSettled(pending.splice(0));
        let failure: PromiseRejectedResult | undefined;
        for (const result of results) {
            if (result.status === "fulfilled") merge(result.value);
            else failure ??= result;
        }
        if (failure) throw failure.reason;
    };
    try {
        for await (const item of items) {
            if (cancelled(options)) return false;
            const task = inspect(item);
            // Enumeration can await I/O before the batch drains.
            void task.catch(() => {});
            pending.push(task);
            if (pending.length >= concurrencyLimit(options)) await drain();
            if (cancelled(options)) return false;
        }
        return !cancelled(options);
    } finally {
        await drain();
    }
}

const DOCUMENT_BATCH_SIZE = 64;

async function* documentBatches(ids: AsyncIterable<string>, options: DatabaseIntegrityOptions) {
    let pending: string[] = [];
    let failure: { error: unknown } | undefined;
    try {
        for await (const id of ids) {
            if (cancelled(options)) return;
            pending.push(id);
            if (pending.length === DOCUMENT_BATCH_SIZE) {
                yield pending;
                pending = [];
            }
        }
    } catch (error) {
        failure = { error };
    }
    if (pending.length && !cancelled(options)) yield pending;
    if (failure) throw failure.error;
}

async function readMany(
    source: DiagnosticDatabaseSource,
    ids: string[],
    phase: InspectionPhase,
    options?: { conflicts?: boolean }
): Promise<Map<string, DiagnosticDocumentReadResult>> {
    if (!ids.length) return new Map();
    try {
        const results = await phase.read(() => source.getMany!(ids, options), ids.length);
        const byId = new Map(results.map((result) => [result.id, result]));
        return new Map(
            ids.map((id) => [id, byId.get(id) ?? { id, error: new DiagnosticReadError("document-unreadable") }])
        );
    } catch (error) {
        return new Map(ids.map((id) => [id, { id, error }]));
    }
}

function readResult(result: DiagnosticDocumentReadResult): EntryDoc {
    if ("error" in result) throw result.error;
    return result.document;
}

function mergeSourceWork(target: SourceRun, work: SourceRun): void {
    target.errors.push(...work.errors);
    target.observations.push(...work.observations);
    for (const key of ["documents", "metadata", "excluded", "conflictBranches", "contentReads"] as const) {
        target.coverage[key] += work.coverage[key];
    }
}

function cancelled(options: DatabaseIntegrityOptions): boolean {
    return options.signal?.aborted === true;
}

function isConfigurationCurrent(options: DatabaseIntegrityOptions): boolean {
    try {
        return options.isConfigurationCurrent();
    } catch {
        return false;
    }
}

function isSkippedDocumentId(id: string): boolean {
    return isChunk(id) || id.startsWith("_local/") || id.startsWith("_design/") || EXCLUDED_IDS.has(id);
}

function makeSourceRun(name: DiagnosticSourceName, source: DiagnosticDatabaseSource): SourceRun {
    return {
        name,
        source,
        coverage: { ...INITIAL_COVERAGE, status: "partial" },
        errors: [],
        observations: [],
        metadataScanComplete: false,
        enumerationComplete: false,
        endInfoAvailable: true,
    };
}

async function classifyObservation(
    options: DatabaseIntegrityOptions,
    run: SourceRun,
    document: CurrentMetadata,
    branch: "winner" | "conflict",
    conflictCount: number,
    reference: string
): Promise<InternalObservation | undefined> {
    if (!isValidCurrentMetadata(document)) {
        appendError(run.errors, run.name, "invalid-metadata", {
            id: typeof document._id === "string" ? document._id : undefined,
            revision: typeof document._rev === "string" ? document._rev : undefined,
        });
        return undefined;
    }

    try {
        const identity = await inspectMetadataDocumentIdentity({ services: { path: options.path } }, document);
        if (identity.status === MetadataDocumentIdentityStatuses.EXCLUDED) {
            run.coverage.excluded++;
            return undefined;
        }

        const rawPath = document.path as string;
        const recordedSize = isRecordedSize(document.size) ? document.size : undefined;
        const mismatch =
            identity.status === MetadataDocumentIdentityStatuses.UNRESOLVED ? identity.diagnostic.reason : undefined;
        const report: DiagnosticObservation = {
            reference,
            source: run.name,
            id: document._id,
            ...(typeof document._rev === "string" ? { revision: document._rev } : {}),
            path: rawPath,
            ...(identity.status === MetadataDocumentIdentityStatuses.CONSISTENT
                ? { expectedId: identity.expectedDocumentId }
                : identity.status === MetadataDocumentIdentityStatuses.UNRESOLVED &&
                    identity.diagnostic.expectedDocumentId
                  ? { expectedId: identity.diagnostic.expectedDocumentId }
                  : {}),
            identity:
                identity.status === MetadataDocumentIdentityStatuses.CONSISTENT
                    ? "consistent"
                    : mismatch === "namespace-mismatch"
                      ? "namespace-mismatch"
                      : "document-id-mismatch",
            logicallyDeleted: Boolean(document.deleted || document._deleted),
            branch,
            conflictCount,
            pathIsNFC: rawPath === rawPath.normalize("NFC"),
            caseEquivalentPaths: false,
            nfcEquivalentPaths: false,
            metadata: {
                type: document.type,
                ...(recordedSize !== undefined ? { recordedSize } : {}),
                chunkReferences: document.children.length,
                uniqueChunkReferences: new Set(document.children).size,
                embeddedChunkReferences: document.children.reduce(
                    (count, child) => count + (getEdenChunk(document, child) !== undefined ? 1 : 0),
                    0
                ),
            },
            content: {
                status: "not-checked",
                chunksRead: 0,
                unavailableChunks: [],
            },
            otherSourceGroup: "not-checked",
            vault: { reference: `vault:${reference}`, status: "not-checked" },
            comparisons: [],
        };
        const observation = { report, source: run.source, document };
        run.observations.push(observation);
        if (branch === "winner") run.coverage.metadata++;
        else run.coverage.conflictBranches++;
        return observation;
    } catch {
        appendError(run.errors, run.name, "invalid-metadata", {
            id: document._id,
            revision: document._rev,
            path: document.path,
        });
        return undefined;
    }
}

async function inspectMetadataDocument(
    options: DatabaseIntegrityOptions,
    run: SourceRun,
    id: string,
    phase: InspectionPhase,
    prefetched?: DiagnosticDocumentReadResult
): Promise<void> {
    if (cancelled(options)) return;
    run.coverage.documents++;
    if (isSkippedDocumentId(id)) {
        run.coverage.excluded++;
        return;
    }
    let winnerValue: EntryDoc;
    try {
        winnerValue =
            prefetched === undefined
                ? await phase.read(() => run.source.get(id, { conflicts: true }))
                : readResult(prefetched);
    } catch (error) {
        if (cancelled(options)) return;
        appendError(run.errors, run.name, reasonFromReadError(error, "document-unreadable"), { id });
        return;
    }
    if (cancelled(options)) return;
    if (!isRecord(winnerValue) || winnerValue._id !== id) {
        appendError(run.errors, run.name, "invalid-metadata", { id });
        return;
    }

    if (!isCurrentMetadata(winnerValue)) {
        // Legacy notes and non-Metadata documents are deliberately outside this report.
        run.coverage.excluded++;
        return;
    }

    const winner = winnerValue;
    if (!isValidCurrentMetadata(winner)) {
        appendError(run.errors, run.name, "invalid-metadata", {
            id,
            revision: typeof winner._rev === "string" ? winner._rev : undefined,
        });
        return;
    }

    const conflictRevisions = Array.isArray(winner._conflicts)
        ? winner._conflicts.filter((revision): revision is string => typeof revision === "string")
        : [];
    await classifyObservation(options, run, winner, "winner", conflictRevisions.length, "pending");
    if (cancelled(options)) return;

    for (const revision of conflictRevisions) {
        if (cancelled(options)) return;
        let branchValue: EntryDoc;
        try {
            branchValue = await phase.read(() => run.source.get(id, { rev: revision, conflicts: true }));
        } catch (error) {
            if (cancelled(options)) return;
            appendError(run.errors, run.name, reasonFromReadError(error, "revision-unavailable"), {
                id,
                revision,
            });
            continue;
        }
        if (cancelled(options)) return;
        if (!isRecord(branchValue) || branchValue._id !== id || branchValue._rev !== revision) {
            appendError(run.errors, run.name, "revision-unavailable", { id, revision });
            continue;
        }
        if (!isCurrentMetadata(branchValue)) {
            // A legacy or non-Metadata branch is outside the current-file inspection scope.
            run.coverage.excluded++;
            continue;
        }
        await classifyObservation(options, run, branchValue, "conflict", conflictRevisions.length, "pending");
    }
}

async function scanSource(
    options: DatabaseIntegrityOptions,
    run: SourceRun,
    nextReference: (source: DiagnosticSourceName) => string
): Promise<void> {
    if (cancelled(options)) return;
    const phase = new InspectionPhase(options, "metadata", run.name);
    try {
        const info = await run.source.info();
        run.startSeq = info.update_seq;
        if (Number.isSafeInteger(info.doc_count) && info.doc_count! >= 0) phase.total = info.doc_count;
        if (!hasUpdateSequence(run.startSeq)) appendError(run.errors, run.name, "source-unavailable");
    } catch {
        appendError(run.errors, run.name, "source-unavailable");
    }
    phase.update();
    let enumerationComplete = false;
    const merge = (work: SourceRun) => {
        for (const observation of work.observations) {
            observation.report.reference = nextReference(run.name);
            observation.report.vault.reference = `vault:${observation.report.reference}`;
        }
        mergeSourceWork(run, work);
    };
    const inspect = async (id: string, prefetched?: DiagnosticDocumentReadResult) => {
        const work = makeSourceRun(run.name, run.source);
        if (typeof id !== "string") appendError(work.errors, run.name, "source-unavailable");
        else await inspectMetadataDocument(options, work, id, phase, prefetched);
        if (!cancelled(options)) {
            phase.processed++;
            phase.update();
        }
        return work;
    };
    try {
        if (!cancelled(options)) {
            if (run.source.getMany) {
                for await (const ids of documentBatches(run.source.enumerateIds(), options)) {
                    if (cancelled(options)) break;
                    const targets = ids.filter((id) => typeof id === "string" && !isSkippedDocumentId(id));
                    const prefetched = await readMany(run.source, targets, phase, { conflicts: true });
                    if (cancelled(options)) break;
                    await inspectBatches(ids, options, (id) => inspect(id, prefetched.get(id)), merge);
                }
                enumerationComplete = !cancelled(options);
            } else {
                enumerationComplete = await inspectBatches(run.source.enumerateIds(), options, inspect, merge);
            }
        }
    } catch {
        if (!cancelled(options)) appendError(run.errors, run.name, "source-unavailable");
    }
    if (!cancelled(options)) {
        run.metadataScanComplete = enumerationComplete && run.errors.length === 0;
        run.enumerationComplete = enumerationComplete;
        if (enumerationComplete) phase.total = phase.processed;
    }
    phase.update();
    phase.log(cancelled(options) ? "cancelled" : run.metadataScanComplete ? "completed" : "partial");
}

function groupObservations(runs: SourceRun[]): IntegrityGroup[] {
    const observations = runs.flatMap((run) => run.observations);
    const parents = observations.map((_, index) => index);
    const find = (index: number): number => {
        if (parents[index] !== index) parents[index] = find(parents[index]);
        return parents[index];
    };
    const union = (left: number, right: number) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
    };
    const byExpectedId = new Map<string, number>();
    const byRawPath = new Map<string, number>();

    observations.forEach((observation, index) => {
        const { expectedId, path } = observation.report;
        if (expectedId !== undefined) {
            const previous = byExpectedId.get(expectedId);
            if (previous === undefined) byExpectedId.set(expectedId, index);
            else union(index, previous);
        }
        const previousPath = byRawPath.get(path);
        if (previousPath === undefined) byRawPath.set(path, index);
        else union(index, previousPath);
    });

    const groupsByRoot = new Map<number, IntegrityGroup>();
    observations.forEach((observation, index) => {
        const root = find(index);
        const group = groupsByRoot.get(root) ?? { key: `group:${root}`, observations: [], suspect: false };
        group.observations.push(observation);
        groupsByRoot.set(root, group);
    });
    return [...groupsByRoot.values()];
}

function markPathEquivalences(observations: InternalObservation[]): DiagnosticPathEquivalenceGroup[] {
    const pathsByCaseFold = new Map<string, InternalObservation[]>();
    const pathsByNfc = new Map<string, InternalObservation[]>();
    for (const observation of observations) {
        const path = observation.report.path;
        const caseFold = path.toLowerCase();
        const casePaths = pathsByCaseFold.get(caseFold) ?? [];
        casePaths.push(observation);
        pathsByCaseFold.set(caseFold, casePaths);

        const nfc = path.normalize("NFC");
        const nfcPaths = pathsByNfc.get(nfc) ?? [];
        nfcPaths.push(observation);
        pathsByNfc.set(nfc, nfcPaths);
    }

    const equivalenceGroups: DiagnosticPathEquivalenceGroup[] = [];
    for (const [kind, groups] of [
        ["case", pathsByCaseFold],
        ["nfc", pathsByNfc],
    ] as const) {
        let groupNumber = 0;
        for (const members of groups.values()) {
            const hasDifferentSpellings = new Set(members.map((observation) => observation.report.path)).size > 1;
            if (kind === "case") {
                for (const observation of members) observation.report.caseEquivalentPaths = hasDifferentSpellings;
            } else {
                for (const observation of members) observation.report.nfcEquivalentPaths = hasDifferentSpellings;
            }
            if (!hasDifferentSpellings) continue;

            const reference = `${kind}:${++groupNumber}`;
            if (kind === "case") {
                for (const observation of members) observation.report.caseEquivalentGroup = reference;
            } else {
                for (const observation of members) observation.report.nfcEquivalentGroup = reference;
            }
            equivalenceGroups.push({
                reference,
                kind,
                members: members.map((observation) => observation.report.reference),
            });
        }
    }
    return equivalenceGroups;
}

function markSuspectGroups(groups: IntegrityGroup[], runs: SourceRun[]): void {
    const crossSourceComparisonAvailable =
        runs.some((run) => run.name === "local" && run.metadataScanComplete) &&
        runs.some((run) => run.name === "remote" && run.metadataScanComplete);

    for (const group of groups) {
        const observations = group.observations;
        group.suspect =
            observations.some((observation) => observation.report.identity !== "consistent") ||
            observations.some((observation) => observation.report.conflictCount > 0);

        const claimsBySourceAndPath = new Map<string, Set<string>>();
        for (const observation of observations) {
            const key = `${observation.report.source}\u0000${observation.report.path}`;
            const ids = claimsBySourceAndPath.get(key) ?? new Set<string>();
            ids.add(observation.report.id);
            claimsBySourceAndPath.set(key, ids);
        }
        if ([...claimsBySourceAndPath.values()].some((ids) => ids.size > 1)) group.suspect = true;

        for (const observation of observations) {
            const otherSource = observation.report.source === "local" ? "remote" : "local";
            const otherRun = runs.find((run) => run.name === otherSource);
            observation.report.otherSourceGroup = observations.some((other) => other.report.source === otherSource)
                ? "present"
                : otherRun?.metadataScanComplete
                  ? "missing"
                  : "not-checked";
        }

        if (!crossSourceComparisonAvailable) continue;
        const localWinners = observations.filter(
            (observation) => observation.report.source === "local" && observation.report.branch === "winner"
        );
        const remoteWinners = observations.filter(
            (observation) => observation.report.source === "remote" && observation.report.branch === "winner"
        );
        if (localWinners.length === 0 || remoteWinners.length === 0) {
            group.suspect = true;
            continue;
        }
        const state = (observation: InternalObservation) =>
            `${observation.report.revision ?? ""}\u0000${observation.report.logicallyDeleted}`;
        if (
            localWinners.some((local) => !remoteWinners.some((remote) => state(local) === state(remote))) ||
            remoteWinners.some((remote) => !localWinners.some((local) => state(remote) === state(local)))
        ) {
            group.suspect = true;
        }
    }
}

function isValidChunk(value: unknown, id: string): value is { _id: string; type: "leaf"; data: string } {
    return isRecord(value) && value._id === id && value.type === EntryTypes.CHUNK && typeof value.data === "string";
}

function getEdenChunk(document: CurrentMetadata, id: string): string | undefined {
    const eden: unknown = document.eden;
    if (!isRecord(eden)) return undefined;
    const chunk = eden[id];
    if (!isRecord(chunk) || typeof chunk.data !== "string") return undefined;
    return chunk.data;
}

async function readObservationContent(
    options: DatabaseIntegrityOptions,
    observation: InternalObservation,
    run: SourceRun,
    phase: InspectionPhase
): Promise<ContentReadOutcome> {
    run.coverage.contentReads++;
    const unavailableChunks: ContentReadOutcome["unavailableChunks"] = [];
    const data: string[] = [];
    let chunksRead = 0;

    if (observation.document.type !== EntryTypes.NOTE_BINARY && observation.document.type !== EntryTypes.NOTE_PLAIN) {
        appendError(run.errors, run.name, "unsupported-content", {
            id: observation.report.id,
            revision: observation.report.revision,
            path: observation.report.path,
        });
        return {
            content: { status: "unreadable", reason: "unsupported-content" },
            chunksRead,
            unavailableChunks,
        };
    }

    for (let offset = 0; offset < observation.document.children.length; offset += DOCUMENT_BATCH_SIZE) {
        if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
        const children = observation.document.children.slice(offset, offset + DOCUMENT_BATCH_SIZE);
        const prefetched = observation.source.getMany
            ? await readMany(
                  observation.source,
                  [...new Set(children.filter((child) => getEdenChunk(observation.document, child) === undefined))],
                  phase
              )
            : undefined;
        for (const child of children) {
            if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
            const eden = getEdenChunk(observation.document, child);
            if (eden !== undefined) {
                data.push(eden);
                chunksRead++;
                continue;
            }
            try {
                const chunk = prefetched
                    ? readResult(prefetched.get(child)!)
                    : await phase.read(() => observation.source.get(child));
                if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
                if (!isValidChunk(chunk, child) || (chunk as { _deleted?: boolean })._deleted === true) {
                    unavailableChunks.push({ id: child, status: "unreadable" });
                    appendError(run.errors, run.name, "chunk-unreadable", {
                        id: observation.report.id,
                        revision: observation.report.revision,
                        path: observation.report.path,
                        chunkId: child,
                    });
                    continue;
                }
                data.push(chunk.data);
                chunksRead++;
            } catch (error) {
                if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
                if (isMissingRead(error)) {
                    const eden = getEdenChunk(observation.document, child);
                    if (eden !== undefined) {
                        data.push(eden);
                        chunksRead++;
                        continue;
                    }
                    unavailableChunks.push({ id: child, status: "missing" });
                    appendError(run.errors, run.name, reasonFromReadError(error, "chunk-missing"), {
                        id: observation.report.id,
                        revision: observation.report.revision,
                        path: observation.report.path,
                        chunkId: child,
                    });
                    continue;
                }
                unavailableChunks.push({ id: child, status: "unreadable" });
                appendError(run.errors, run.name, reasonFromReadError(error, "chunk-unreadable"), {
                    id: observation.report.id,
                    revision: observation.report.revision,
                    path: observation.report.path,
                    chunkId: child,
                });
            }
        }
    }

    if (unavailableChunks.length > 0) {
        const hasUnreadable = unavailableChunks.some((chunk) => chunk.status === "unreadable");
        return {
            content: {
                status: hasUnreadable ? "unreadable" : "missing",
                reason: hasUnreadable ? "chunk-unreadable" : "chunk-missing",
            },
            chunksRead,
            unavailableChunks,
        };
    }

    try {
        const loaded: LoadedEntry = {
            ...(observation.document as AnyEntry),
            data,
            datatype: observation.document.type,
        };
        const blob = readAsBlob(loaded);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
        return {
            content: { status: "available", bytes },
            chunksRead,
            unavailableChunks,
        };
    } catch {
        if (cancelled(options)) return { content: { status: "not-checked" }, chunksRead, unavailableChunks };
        appendError(run.errors, run.name, "unsupported-content", {
            id: observation.report.id,
            revision: observation.report.revision,
            path: observation.report.path,
        });
        return {
            content: { status: "unreadable", reason: "unsupported-content" },
            chunksRead,
            unavailableChunks,
        };
    }
}

function relation(
    left: DiagnosticContent,
    right: DiagnosticContent
): "equal" | "different" | "unavailable" | "not-checked" {
    if (left.status === "not-checked" || right.status === "not-checked") return "not-checked";
    if (left.status !== "available" || right.status !== "available") return "unavailable";
    if (left.bytes.length !== right.bytes.length) return "different";
    for (let index = 0; index < left.bytes.length; index++) {
        if (left.bytes[index] !== right.bytes[index]) return "different";
    }
    return "equal";
}

async function readVaultContent(
    options: DatabaseIntegrityOptions,
    path: string,
    errors: DiagnosticError[],
    phase: InspectionPhase
): Promise<DiagnosticContent> {
    if (cancelled(options)) return { status: "not-checked" };
    try {
        const content = await phase.read(() => options.readStorage(path));
        if (cancelled(options)) return { status: "not-checked" };
        if (content.status === "unreadable" || content.reason) {
            appendError(errors, "storage", content.reason ?? "content-unreadable", { path });
        }
        return content;
    } catch (error) {
        if (cancelled(options)) return { status: "not-checked" };
        const reason = error instanceof DiagnosticReadError ? error.reason : "content-unreadable";
        appendError(errors, "storage", reason, { path });
        return { status: "unreadable", reason };
    }
}

async function inspectGroupContent(
    options: DatabaseIntegrityOptions,
    group: IntegrityGroup,
    runsByName: Map<DiagnosticSourceName, SourceRun>,
    errors: DiagnosticError[],
    phase: InspectionPhase
): Promise<void> {
    if (!group.suspect) return;
    const byRawPath = new Map<string, InternalObservation>();
    for (const observation of group.observations) {
        if (!byRawPath.has(observation.report.path)) byRawPath.set(observation.report.path, observation);
    }

    const vaultReferences = new Map<string, string>();
    for (const [path, representative] of byRawPath) {
        vaultReferences.set(path, `vault:${representative.report.reference}`);
    }
    for (const observation of group.observations) {
        observation.report.comparisons = [
            ...group.observations
                .filter((other) => other !== observation)
                .map((other) => ({ against: other.report.reference, relation: "not-checked" as const })),
            ...[...vaultReferences.values()].map((against) => ({ against, relation: "not-checked" as const })),
        ];
    }

    const contentByObservation = new Map<InternalObservation, DiagnosticContent>();
    const contentByReference = new Map<string, DiagnosticContent>();
    for (const observation of group.observations) {
        if (cancelled(options)) return;
        const run = runsByName.get(observation.report.source);
        if (!run) continue;
        const outcome = await readObservationContent(options, observation, run, phase);
        const decodedSize = outcome.content.status === "available" ? outcome.content.bytes.length : undefined;
        const recordedSize = observation.report.metadata?.recordedSize;
        observation.report.content = {
            status: outcome.content.status,
            ...(outcome.content.reason ? { reason: outcome.content.reason } : {}),
            chunksRead: outcome.chunksRead,
            unavailableChunks: outcome.unavailableChunks,
            ...(decodedSize !== undefined
                ? {
                      size: decodedSize,
                      ...(recordedSize !== undefined ? { recordedSizeDifference: decodedSize - recordedSize } : {}),
                  }
                : {}),
        };
        contentByObservation.set(observation, outcome.content);
        contentByReference.set(observation.report.reference, outcome.content);
        if (cancelled(options)) return;
    }

    const vaultByPath = new Map<string, DiagnosticContent>();
    for (const [path] of byRawPath) {
        if (cancelled(options)) return;
        const vaultContent = await readVaultContent(options, path, errors, phase);
        vaultByPath.set(path, vaultContent);
        const vaultReference = vaultReferences.get(path);
        if (vaultReference) contentByReference.set(vaultReference, vaultContent);
        for (const observation of group.observations) {
            if (observation.report.path !== path) continue;
            const observationContent = contentByObservation.get(observation);
            observation.report.vault = {
                reference: vaultReference ?? `vault:${observation.report.reference}`,
                status: vaultContent.status,
                ...(vaultContent.reason ? { reason: vaultContent.reason } : {}),
                ...(vaultContent.status === "available"
                    ? {
                          size: vaultContent.bytes.length,
                          ...(observationContent?.status === "available"
                              ? { contentSizeDifference: vaultContent.bytes.length - observationContent.bytes.length }
                              : {}),
                          ...(isFiniteNumber(vaultContent.mtime) && isFiniteNumber(observation.document.mtime)
                              ? { mtimeDifferenceMs: vaultContent.mtime - observation.document.mtime }
                              : {}),
                      }
                    : {}),
            };
        }
        if (cancelled(options)) return;
    }

    for (const observation of group.observations) {
        const ownContent = contentByObservation.get(observation) ?? { status: "not-checked" as const };
        for (const comparison of observation.report.comparisons) {
            const comparedContent = contentByReference.get(comparison.against) ?? { status: "not-checked" as const };
            comparison.relation = relation(ownContent, comparedContent);
        }
    }
}

function determineStatus(
    wasCancelled: boolean,
    errors: DiagnosticError[],
    runs: SourceRun[],
    configurationChanged: boolean
): DatabaseIntegrityResult["status"] {
    if (wasCancelled) return "cancelled";
    if (configurationChanged || errors.length > 0) {
        const anyCompletedSource = runs.some((run) => run.metadataScanComplete);
        const allUnavailable = runs.length > 0 && runs.every((run) => run.coverage.status === "failed");
        return allUnavailable && !anyCompletedSource ? "failed" : "partial";
    }
    if (runs.length === 0 || runs.some((run) => run.coverage.status !== "complete")) return "partial";
    return "complete";
}

/**
 * Inspect current normal-file Metadata and content evidence without changing a source.
 */
export async function analyseDatabaseIntegrity(options: DatabaseIntegrityOptions): Promise<DatabaseIntegrityResult> {
    const errors: DiagnosticError[] = [];
    const runs: SourceRun[] = [];
    const referenceNumbers: Record<DiagnosticSourceName, number> = { local: 0, remote: 0 };
    const nextReference = (source: DiagnosticSourceName) => `${source}:${++referenceNumbers[source]}`;
    let wasCancelled = cancelled(options);
    let configurationChanged = false;
    let pathEquivalenceGroups: DiagnosticPathEquivalenceGroup[] = [];
    let ownedRemote: (DiagnosticDatabaseSource & { close(): Promise<void> }) | undefined;

    if (!wasCancelled && !isConfigurationCurrent(options)) {
        configurationChanged = true;
        appendError(errors, "configuration", "configuration-changed");
    }

    try {
        if (!wasCancelled && !configurationChanged) {
            const localRun = makeSourceRun("local", options.local);
            runs.push(localRun);
            await scanSource(options, localRun, nextReference);
            if (!cancelled(options) && options.includeRemote !== false) {
                if (!options.remote) {
                    const remoteRun = { ...makeSourceRun("remote", options.local), source: options.local };
                    remoteRun.coverage.status = "failed";
                    remoteRun.endInfoAvailable = false;
                    appendError(errors, "remote", options.remoteUnavailableReason ?? "source-unavailable");
                    runs.push(remoteRun);
                } else {
                    try {
                        ownedRemote = await options.remote();
                        if (cancelled(options)) {
                            wasCancelled = true;
                        } else {
                            const remoteRun = makeSourceRun("remote", ownedRemote);
                            runs.push(remoteRun);
                            await scanSource(options, remoteRun, nextReference);
                        }
                    } catch {
                        if (cancelled(options)) {
                            wasCancelled = true;
                        } else {
                            const remoteRun = { ...makeSourceRun("remote", options.local), source: options.local };
                            remoteRun.coverage.status = "failed";
                            remoteRun.endInfoAvailable = false;
                            appendError(errors, "remote", options.remoteUnavailableReason ?? "source-unavailable");
                            runs.push(remoteRun);
                        }
                    }
                }
            }

            if (cancelled(options)) wasCancelled = true;
            if (!wasCancelled) {
                const grouping = new InspectionPhase(options, "grouping");
                const groups = groupObservations(runs);
                pathEquivalenceGroups = markPathEquivalences(runs.flatMap((run) => run.observations));
                markSuspectGroups(groups, runs);
                grouping.processed = groups.length;
                grouping.total = groups.length;
                grouping.log("completed");
                const suspects = groups.filter((group) => group.suspect);
                const content = new InspectionPhase(options, "content");
                content.total = suspects.length;
                content.update();
                await inspectBatches(
                    suspects,
                    options,
                    async (group) => {
                        const work = runs.map((run) => makeSourceRun(run.name, run.source));
                        const groupErrors: DiagnosticError[] = [];
                        await inspectGroupContent(
                            options,
                            group,
                            new Map(work.map((run) => [run.name, run])),
                            groupErrors,
                            content
                        );
                        if (!cancelled(options)) {
                            content.processed++;
                            content.update();
                        }
                        return { work, groupErrors };
                    },
                    ({ work, groupErrors }) => {
                        for (let index = 0; index < runs.length; index++) mergeSourceWork(runs[index], work[index]);
                        errors.push(...groupErrors);
                    }
                );
                if (cancelled(options)) wasCancelled = true;
                content.log(wasCancelled ? "cancelled" : "completed");
            }
        }

        if (!wasCancelled && !cancelled(options)) {
            for (const run of runs) {
                if (!run.endInfoAvailable) continue;
                if (cancelled(options)) {
                    wasCancelled = true;
                    break;
                }
                try {
                    const info = await run.source.info();
                    run.endSeq = info.update_seq;
                    if (!hasUpdateSequence(run.endSeq)) {
                        appendError(run.errors, run.name, "source-unavailable");
                    } else if (hasUpdateSequence(run.startSeq) && run.startSeq !== run.endSeq) {
                        run.coverage.changedDuringRun = true;
                        appendError(run.errors, run.name, "source-changed");
                    }
                } catch {
                    appendError(run.errors, run.name, "source-unavailable");
                }
            }
        }
    } finally {
        if (ownedRemote) {
            try {
                await ownedRemote.close();
            } catch {
                appendError(errors, "remote", "source-unavailable");
            }
        }
    }

    if (cancelled(options)) wasCancelled = true;
    if (!wasCancelled && !configurationChanged && !isConfigurationCurrent(options)) {
        configurationChanged = true;
        appendError(errors, "configuration", "configuration-changed");
    }

    for (const run of runs) {
        if (run.coverage.status === "failed") continue;
        const runHasErrors = run.errors.length > 0 || errors.some((error) => error.source === run.name);
        run.coverage.status = wasCancelled
            ? run.coverage.documents > 0 || run.coverage.metadata > 0
                ? "partial"
                : "not-checked"
            : runHasErrors
              ? run.coverage.metadata > 0 || run.enumerationComplete
                  ? "partial"
                  : "failed"
              : run.metadataScanComplete
                ? "complete"
                : "partial";
        errors.push(...run.errors);
    }

    const coverage = {
        local: { ...INITIAL_COVERAGE },
        remote: { ...INITIAL_COVERAGE },
    };
    for (const run of runs) coverage[run.name] = { ...run.coverage };
    const allObservations = runs.flatMap((run) => run.observations.map((observation) => observation.report));
    const status = determineStatus(wasCancelled, errors, runs, configurationChanged);

    return {
        schemaVersion: 1,
        kind: "integrity",
        status,
        settings: { ...options.settings },
        coverage,
        observations: allObservations,
        ...(pathEquivalenceGroups.length > 0 ? { pathEquivalenceGroups } : {}),
        errors,
        scope: {
            remote: options.includeRemote === false ? "excluded" : "included",
            metadata: "normal-files-and-current-conflicts",
            content: "suspect-groups-only",
            history: "not-checked",
            atomicSnapshot: false,
        },
    };
}
