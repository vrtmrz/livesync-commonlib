import type { EntryDoc, MetaEntry } from "../common/types.ts";
import type { IPathService } from "../services/base/IService.ts";

export type DiagnosticStatus = "complete" | "partial" | "failed" | "cancelled";
export type DiagnosticSourceName = "local" | "remote";
export type DiagnosticNameMode = "original" | "pseudonym";
export type DiagnosticReason =
    | "source-unavailable"
    | "unsupported-remote"
    | "document-unreadable"
    | "revision-unavailable"
    | "invalid-metadata"
    | "unsupported-content"
    | "chunk-missing"
    | "chunk-unreadable"
    | "security-seed-unavailable"
    | "content-unreadable"
    | "source-changed"
    | "storage-changed"
    | "configuration-changed";

export interface DiagnosticReadOptions {
    rev?: string;
    conflicts?: boolean;
    revs?: boolean;
    revs_info?: boolean;
}

export type DiagnosticDocumentReadResult =
    | { id: string; document: EntryDoc; error?: never }
    | { id: string; error: unknown; document?: never };

/** Only these reads are available to an analyser; it cannot initialise or repair a database. */
export interface DiagnosticDatabaseSource {
    info(): Promise<{ update_seq?: string | number; doc_count?: number }>;
    enumerateIds(): AsyncIterable<string>;
    get(id: string, options?: DiagnosticReadOptions): Promise<EntryDoc>;
    /** Current documents only; exact conflict revisions still use get. Results retain input order. */
    getMany?(
        ids: string[],
        options?: Pick<DiagnosticReadOptions, "conflicts">
    ): Promise<DiagnosticDocumentReadResult[]>;
}

export interface DiagnosticError {
    source: DiagnosticSourceName | "storage" | "configuration";
    reason: DiagnosticReason;
    id?: string;
    revision?: string;
    path?: string;
    chunkId?: string;
}

export type DiagnosticContent =
    | { status: "available"; bytes: Uint8Array<ArrayBuffer>; mtime?: number; reason?: never }
    | { status: "missing" | "unreadable" | "not-checked"; reason?: DiagnosticReason };

export interface DiagnosticCoverage {
    status: "complete" | "partial" | "failed" | "not-checked";
    documents: number;
    metadata: number;
    excluded: number;
    conflictBranches: number;
    contentReads: number;
    changedDuringRun: boolean;
}

export interface DiagnosticObservation {
    reference: string;
    source: DiagnosticSourceName;
    id: string;
    revision?: string;
    /** Exact stored spelling, retained independently of the host's identity normalisation. */
    path: string;
    expectedId?: string;
    identity: "consistent" | "document-id-mismatch" | "namespace-mismatch";
    logicallyDeleted: boolean;
    branch: "winner" | "conflict";
    conflictCount: number;
    pathIsNFC: boolean;
    caseEquivalentPaths: boolean;
    caseEquivalentGroup?: string;
    nfcEquivalentPaths: boolean;
    nfcEquivalentGroup?: string;
    /** Presence of this identity/path group in the other inspected database. */
    otherSourceGroup: "present" | "missing" | "not-checked";
    metadata?: {
        type: string;
        recordedSize?: number;
        chunkReferences: number;
        uniqueChunkReferences: number;
        embeddedChunkReferences: number;
    };
    vault: {
        reference: string;
        status: DiagnosticContent["status"];
        reason?: DiagnosticReason;
        size?: number;
        contentSizeDifference?: number;
        mtimeDifferenceMs?: number;
    };
    content: {
        status: DiagnosticContent["status"];
        reason?: DiagnosticReason;
        chunksRead: number;
        unavailableChunks: { id: string; status: "missing" | "unreadable" }[];
        size?: number;
        recordedSizeDifference?: number;
    };
    comparisons: {
        against: string;
        relation: "equal" | "different" | "unavailable" | "not-checked";
    }[];
}

export interface DiagnosticPathEquivalenceGroup {
    reference: string;
    kind: "case" | "nfc";
    members: string[];
}

/** A whitelist: connection details, keys, and passphrases have no report field. */
export interface DiagnosticIdentitySettings {
    encrypt: boolean;
    usePathObfuscation: boolean;
    handleFilenameCaseSensitive: boolean;
    idDerivationVersion: number;
    pathNormalizationVersion: number;
}

export interface DatabaseIntegrityResult {
    schemaVersion: 1;
    kind: "integrity";
    status: DiagnosticStatus;
    settings: DiagnosticIdentitySettings;
    coverage: Record<DiagnosticSourceName, DiagnosticCoverage>;
    observations: DiagnosticObservation[];
    pathEquivalenceGroups?: DiagnosticPathEquivalenceGroup[];
    errors: DiagnosticError[];
    /** Scope declarations are part of every report, including a successful one. */
    scope: {
        remote: "included" | "excluded";
        metadata: "normal-files-and-current-conflicts";
        content: "suspect-groups-only";
        history: "not-checked";
        atomicSnapshot: false;
    };
}

export interface DatabaseIntegrityProgress {
    phase: "metadata" | "content";
    source?: DiagnosticSourceName;
    /** Completed documents (including exclusions), or completed suspect content groups. */
    processed: number;
    /** A source's document count, or the number of suspect groups; absent until known. */
    total?: number;
    elapsedMs: number;
}

/** Timing and counters only: no document identifiers, paths, or connection details. */
export interface DatabaseIntegrityLog {
    phase: "metadata" | "grouping" | "content";
    source?: DiagnosticSourceName;
    event: "started" | "progress" | "completed" | "partial" | "cancelled";
    processed: number;
    total?: number;
    elapsedMs: number;
    concurrency: number;
    activeReads: number;
    peakActiveReads: number;
    readOperations: number;
    /** Sum of read durations, including overlap between parallel reads. */
    readDurationMs: number;
}

export interface DatabaseIntegrityOptions {
    local: DiagnosticDatabaseSource;
    /** Defaults to true. False inspects only local evidence and never opens the remote source. */
    includeRemote?: boolean;
    remote?: () => Promise<DiagnosticDatabaseSource & { close(): Promise<void> }>;
    remoteUnavailableReason?: "unsupported-remote" | "source-unavailable";
    path: Pick<IPathService, "getPath" | "path2id">;
    settings: DiagnosticIdentitySettings;
    readStorage(path: string): Promise<DiagnosticContent>;
    /** Captures profile and relevant settings identity without exporting it. */
    isConfigurationCurrent(): boolean;
    signal?: AbortSignal;
    /** Concurrent Metadata classifications or content groups, default four, clamped to 1–16. Source-internal bulk decoding has its own limit. */
    concurrency?: number;
    onProgress?(progress: DatabaseIntegrityProgress): void;
    onLog?(event: DatabaseIntegrityLog): void;
}

export class DiagnosticReadError extends Error {
    constructor(
        readonly reason: DiagnosticReason,
        readonly missing = false
    ) {
        super(reason);
        this.name = "DiagnosticReadError";
    }
}

export type InspectedMetadata = MetaEntry & { _conflicts?: string[] };
