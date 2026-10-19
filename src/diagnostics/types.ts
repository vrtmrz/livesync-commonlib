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

/** Only these reads are available to an analyser; it cannot initialise or repair a database. */
export interface DiagnosticDatabaseSource {
    info(): Promise<{ update_seq?: string | number }>;
    enumerateIds(): AsyncIterable<string>;
    get(id: string, options?: DiagnosticReadOptions): Promise<EntryDoc>;
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
    | { status: "available"; bytes: Uint8Array<ArrayBuffer>; reason?: never }
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
    nfcEquivalentPaths: boolean;
    /** Presence of this identity/path group in the other inspected database. */
    otherSourceGroup: "present" | "missing" | "not-checked";
    vault: {
        reference: string;
        status: DiagnosticContent["status"];
        reason?: DiagnosticReason;
    };
    content: {
        status: DiagnosticContent["status"];
        reason?: DiagnosticReason;
        chunksRead: number;
        unavailableChunks: { id: string; status: "missing" | "unreadable" }[];
    };
    comparisons: {
        against: string;
        relation: "equal" | "different" | "unavailable" | "not-checked";
    }[];
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
    errors: DiagnosticError[];
    /** Scope declarations are part of every report, including a successful one. */
    scope: {
        metadata: "normal-files-and-current-conflicts";
        content: "suspect-groups-only";
        history: "not-checked";
        atomicSnapshot: false;
    };
}

export interface DatabaseIntegrityOptions {
    local: DiagnosticDatabaseSource;
    remote?: () => Promise<DiagnosticDatabaseSource & { close(): Promise<void> }>;
    remoteUnavailableReason?: "unsupported-remote" | "source-unavailable";
    path: Pick<IPathService, "getPath" | "path2id">;
    settings: DiagnosticIdentitySettings;
    readStorage(path: string): Promise<DiagnosticContent>;
    /** Captures profile and relevant settings identity without exporting it. */
    isConfigurationCurrent(): boolean;
    signal?: AbortSignal;
    onProgress?(progress: { phase: "metadata" | "content"; processed: number }): void;
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
