import type {
    DatabaseIntegrityResult,
    DiagnosticCoverage,
    DiagnosticError,
    DiagnosticIdentitySettings,
    DiagnosticNameMode,
    DiagnosticObservation,
    DiagnosticSourceName,
    DiagnosticStatus,
} from "./types.ts";
import type { DatabaseUsageError, DatabaseUsageResult, DatabaseUsageRow, DatabaseUsageStatus } from "./usage.ts";

export interface DiagnosticNameMapper {
    readonly mode: DiagnosticNameMode;
    path(value: string): string;
    id(value: string): string;
    revision(value: string): string;
    chunk(value: string): string;
}

export interface DiagnosticReportVersions {
    commonlib?: string;
    plugin?: string;
    application?: string;
}

function createDomainMapper(prefix: string): (value: string) => string {
    const aliases = new Map<string, string>();
    return (value) => {
        const existing = aliases.get(value);
        if (existing !== undefined) return existing;
        const alias = `${prefix}-${String(aliases.size + 1).padStart(3, "0")}`;
        aliases.set(value, alias);
        return alias;
    };
}

/** Creates run-local name aliases. Each name domain has an independent map. */
export function createDiagnosticNameMapper(mode: DiagnosticNameMode): DiagnosticNameMapper {
    if (mode === "original") {
        const original = (value: string) => value;
        return { mode, path: original, id: original, revision: original, chunk: original };
    }

    return {
        mode,
        path: createDomainMapper("file"),
        id: createDomainMapper("document"),
        revision: createDomainMapper("revision"),
        chunk: createDomainMapper("chunk"),
    };
}

export interface ProjectedDiagnosticError {
    source: DiagnosticError["source"];
    reason: DiagnosticError["reason"];
    id?: string;
    revision?: string;
    path?: string;
    chunkId?: string;
}

export interface ProjectedDiagnosticObservation {
    reference: string;
    source: DiagnosticSourceName;
    id: string;
    revision?: string;
    path: string;
    expectedId?: string;
    identity: DiagnosticObservation["identity"];
    logicallyDeleted: boolean;
    branch: DiagnosticObservation["branch"];
    conflictCount: number;
    pathIsNFC: boolean;
    caseEquivalentPaths: boolean;
    nfcEquivalentPaths: boolean;
    otherSourceGroup: DiagnosticObservation["otherSourceGroup"];
    vault: {
        reference: string;
        status: DiagnosticObservation["vault"]["status"];
        reason?: DiagnosticObservation["vault"]["reason"];
    };
    content: {
        status: DiagnosticObservation["content"]["status"];
        reason?: DiagnosticObservation["content"]["reason"];
        chunksRead: number;
        unavailableChunks: { id: string; status: "missing" | "unreadable" }[];
    };
    comparisons: {
        against: string;
        relation: DiagnosticObservation["comparisons"][number]["relation"];
    }[];
}

export interface ProjectedDatabaseIntegrityReport {
    schemaVersion: 1;
    kind: "integrity";
    status: DiagnosticStatus;
    nameMode: DiagnosticNameMode;
    versions: DiagnosticReportVersions;
    settings: DiagnosticIdentitySettings;
    coverage: Record<DiagnosticSourceName, DiagnosticCoverage>;
    observations: ProjectedDiagnosticObservation[];
    errors: ProjectedDiagnosticError[];
    scope: DatabaseIntegrityResult["scope"];
}

export interface ProjectedDatabaseUsageRow {
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

export interface ProjectedDatabaseUsageError {
    code: DatabaseUsageError["code"];
    id?: string;
    revision?: string;
}

export interface ProjectedDatabaseUsageReport {
    version: 1;
    kind: "usage";
    status: DatabaseUsageStatus;
    nameMode: DiagnosticNameMode;
    versions: DiagnosticReportVersions;
    changedDuringRun?: boolean;
    rows: ProjectedDatabaseUsageRow[];
    errors: ProjectedDatabaseUsageError[];
}

export type ProjectedDiagnosticReport = ProjectedDatabaseIntegrityReport | ProjectedDatabaseUsageReport;

function copyVersions(versions: DiagnosticReportVersions): DiagnosticReportVersions {
    return {
        ...(versions.commonlib === undefined ? {} : { commonlib: versions.commonlib }),
        ...(versions.plugin === undefined ? {} : { plugin: versions.plugin }),
        ...(versions.application === undefined ? {} : { application: versions.application }),
    };
}

function copyCoverage(coverage: DiagnosticCoverage): DiagnosticCoverage {
    return {
        status: coverage.status,
        documents: coverage.documents,
        metadata: coverage.metadata,
        excluded: coverage.excluded,
        conflictBranches: coverage.conflictBranches,
        contentReads: coverage.contentReads,
        changedDuringRun: coverage.changedDuringRun,
    };
}

function projectIntegrityObservation(
    observation: DiagnosticObservation,
    mapper: DiagnosticNameMapper,
    projectReference: (value: string) => string
): ProjectedDiagnosticObservation {
    return {
        reference: projectReference(observation.reference),
        source: observation.source,
        id: mapper.id(observation.id),
        ...(observation.revision === undefined ? {} : { revision: mapper.revision(observation.revision) }),
        path: mapper.path(observation.path),
        ...(observation.expectedId === undefined ? {} : { expectedId: mapper.id(observation.expectedId) }),
        identity: observation.identity,
        logicallyDeleted: observation.logicallyDeleted,
        branch: observation.branch,
        conflictCount: observation.conflictCount,
        pathIsNFC: observation.pathIsNFC,
        caseEquivalentPaths: observation.caseEquivalentPaths,
        nfcEquivalentPaths: observation.nfcEquivalentPaths,
        otherSourceGroup: observation.otherSourceGroup,
        vault: {
            reference: projectReference(observation.vault.reference),
            status: observation.vault.status,
            ...(observation.vault.reason === undefined ? {} : { reason: observation.vault.reason }),
        },
        content: {
            status: observation.content.status,
            ...(observation.content.reason === undefined ? {} : { reason: observation.content.reason }),
            chunksRead: observation.content.chunksRead,
            unavailableChunks: observation.content.unavailableChunks.map((chunk) => ({
                id: mapper.chunk(chunk.id),
                status: chunk.status,
            })),
        },
        comparisons: observation.comparisons.map((comparison) => ({
            against: projectReference(comparison.against),
            relation: comparison.relation,
        })),
    };
}

function projectIntegrityError(error: DiagnosticError, mapper: DiagnosticNameMapper): ProjectedDiagnosticError {
    return {
        source: error.source,
        reason: error.reason,
        ...(error.id === undefined ? {} : { id: mapper.id(error.id) }),
        ...(error.revision === undefined ? {} : { revision: mapper.revision(error.revision) }),
        ...(error.path === undefined ? {} : { path: mapper.path(error.path) }),
        ...(error.chunkId === undefined ? {} : { chunkId: mapper.chunk(error.chunkId) }),
    };
}

/** Copies only the documented report fields and projects every stored name through the run mapper. */
export function projectIntegrityReport(
    result: DatabaseIntegrityResult,
    mapper: DiagnosticNameMapper,
    versions: DiagnosticReportVersions = {}
): ProjectedDatabaseIntegrityReport {
    const safeReference = /^((local|remote):[0-9]+|vault:(local|remote):[0-9]+)$/;
    const referenceAliases = new Map<string, string>();
    const projectReference = (value: string) => {
        if (safeReference.test(value)) return value;
        const existing = referenceAliases.get(value);
        if (existing !== undefined) return existing;
        const alias = `finding-${String(referenceAliases.size + 1).padStart(3, "0")}`;
        referenceAliases.set(value, alias);
        return alias;
    };

    return {
        schemaVersion: 1,
        kind: "integrity",
        status: result.status,
        nameMode: mapper.mode,
        versions: copyVersions(versions),
        settings: {
            encrypt: result.settings.encrypt,
            usePathObfuscation: result.settings.usePathObfuscation,
            handleFilenameCaseSensitive: result.settings.handleFilenameCaseSensitive,
            idDerivationVersion: result.settings.idDerivationVersion,
            pathNormalizationVersion: result.settings.pathNormalizationVersion,
        },
        coverage: {
            local: copyCoverage(result.coverage.local),
            remote: copyCoverage(result.coverage.remote),
        },
        observations: result.observations.map((observation) =>
            projectIntegrityObservation(observation, mapper, projectReference)
        ),
        errors: result.errors.map((error) => projectIntegrityError(error, mapper)),
        scope: {
            metadata: "normal-files-and-current-conflicts",
            content: "suspect-groups-only",
            history: "not-checked",
            atomicSnapshot: false,
        },
    };
}

function isOrphanRow(row: DatabaseUsageRow): boolean {
    return row.id === "__orphan" && row.path === "__orphan" && row.title === "__orphan";
}

function projectUsageRow(row: DatabaseUsageRow, mapper: DiagnosticNameMapper): ProjectedDatabaseUsageRow {
    const statistics = {
        uniqueChunkCount: row.uniqueChunkCount,
        sharedChunkCount: row.sharedChunkCount,
        uniqueChunkSize: row.uniqueChunkSize,
        sharedChunkSize: row.sharedChunkSize,
    };

    if (isOrphanRow(row)) {
        return {
            title: "__orphan",
            id: "__orphan",
            path: "__orphan",
            revision: "1-xxxxx",
            rev: "1",
            revHash: "xxxxx",
            ...statistics,
        };
    }

    const path = mapper.path(row.path);
    const revision = mapper.revision(row.revision);
    return {
        title: `${path} (${revision})`,
        id: mapper.id(row.id),
        path,
        revision,
        rev: row.rev,
        revHash: mapper.mode === "pseudonym" ? revision : row.revHash,
        ...statistics,
    };
}

function projectUsageError(error: DatabaseUsageError, mapper: DiagnosticNameMapper): ProjectedDatabaseUsageError {
    return {
        code: error.code,
        ...(error.id === undefined ? {} : { id: mapper.id(error.id) }),
        ...(error.revision === undefined ? {} : { revision: mapper.revision(error.revision) }),
    };
}

/** Projects Usage rows and errors without carrying through extra analyser fields. */
export function projectUsageReport(
    result: DatabaseUsageResult,
    mapper: DiagnosticNameMapper,
    versions: DiagnosticReportVersions = {}
): ProjectedDatabaseUsageReport {
    return {
        version: 1,
        kind: "usage",
        status: result.status,
        nameMode: mapper.mode,
        versions: copyVersions(versions),
        ...(result.changedDuringRun === undefined ? {} : { changedDuringRun: result.changedDuringRun }),
        rows: result.rows.map((row) => projectUsageRow(row, mapper)),
        errors: result.errors.map((error) => projectUsageError(error, mapper)),
    };
}

const USAGE_COLUMNS: (keyof ProjectedDatabaseUsageRow)[] = [
    "title",
    "id",
    "path",
    "rev",
    "revHash",
    "uniqueChunkCount",
    "sharedChunkCount",
    "uniqueChunkSize",
    "sharedChunkSize",
];

const USAGE_HEADERS = [
    "Title",
    "Document ID",
    "Path",
    "Revision No",
    "Revision Hash",
    "Unique Chunk Count",
    "Shared Chunk Count",
    "Unique Chunk Size",
    "Shared Chunk Size",
];

function escapeTSVField(value: string | number): string {
    const text = String(value);
    return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Formats the legacy nine-column Usage export from an already projected report. */
export function formatUsageTSV(projected: ProjectedDatabaseUsageReport): string {
    const lines = [USAGE_HEADERS.map(escapeTSVField).join("\t")];
    for (const row of projected.rows) {
        lines.push(USAGE_COLUMNS.map((column) => escapeTSVField(row[column])).join("\t"));
    }
    return lines.join("\n");
}

/** Serialises a projected report. Raw analyser values never enter this formatter. */
export function formatDiagnosticJSON(projected: ProjectedDiagnosticReport): string {
    return JSON.stringify(projected, null, 2);
}

function markdownCode(value: string): string {
    const text = value
        .replace(/\r\n?|\n|\t/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const backtickRuns = text.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(0, ...backtickRuns.map((run) => run.length)) + 1);
    const padding = /^\s|\s$/.test(text) ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
}

function renderMaybe(value: string | undefined): string {
    return value === undefined ? "not recorded" : markdownCode(value);
}

function renderObservation(observation: ProjectedDiagnosticObservation): string[] {
    const lines = [
        `### ${markdownCode(observation.reference)}`,
        `- Source: ${observation.source}`,
        `- Path: ${markdownCode(observation.path)}`,
        `- Document ID: ${markdownCode(observation.id)}`,
        `- Revision: ${renderMaybe(observation.revision)}`,
        `- Expected ID: ${renderMaybe(observation.expectedId)}`,
        `- Identity: ${observation.identity}`,
        `- Branch: ${observation.branch}`,
        `- Logically deleted: ${observation.logicallyDeleted}`,
        `- Conflict count: ${observation.conflictCount}`,
        `- Path is NFC: ${observation.pathIsNFC}`,
        `- Case-equivalent paths: ${observation.caseEquivalentPaths}`,
        `- NFC-equivalent paths: ${observation.nfcEquivalentPaths}`,
        `- Other inspected database group: ${observation.otherSourceGroup}`,
        `- Vault content status: ${observation.vault.status}${observation.vault.reason === undefined ? "" : ` (${observation.vault.reason})`}`,
        `- Vault reference: ${markdownCode(observation.vault.reference)}`,
        `- Content: ${observation.content.status}${observation.content.reason === undefined ? "" : ` (${observation.content.reason})`}`,
        `- Chunks read: ${observation.content.chunksRead}`,
    ];
    if (observation.content.unavailableChunks.length > 0) {
        lines.push(
            `- Unavailable chunks: ${observation.content.unavailableChunks
                .map((chunk) => `${markdownCode(chunk.id)} (${chunk.status})`)
                .join(", ")}`
        );
    }
    if (observation.comparisons.length > 0) {
        lines.push(
            `- Comparisons: ${observation.comparisons
                .map((comparison) => `${markdownCode(comparison.against)}: ${comparison.relation}`)
                .join("; ")}`
        );
    }
    return lines;
}

/** Renders the same projected integrity fields used by JSON, with user-controlled values in escaped code spans. */
export function formatIntegrityMarkdown(projected: ProjectedDatabaseIntegrityReport): string {
    const observations = projected.observations;
    const mismatchCount = observations.filter((observation) => observation.identity !== "consistent").length;
    const conflictCount = observations.filter((observation) => observation.branch === "conflict").length;
    const unavailableContentCount = observations.filter(
        (observation) => observation.content.status === "missing" || observation.content.status === "unreadable"
    ).length;
    const unavailableChunkCount = observations.reduce(
        (count, observation) => count + observation.content.unavailableChunks.length,
        0
    );
    const coverageRows: [string, DiagnosticCoverage][] = [
        ["Local", projected.coverage.local],
        ["Remote", projected.coverage.remote],
    ];
    const lines = [
        "# Database integrity report",
        "",
        `Status: ${projected.status}`,
        `Names: ${projected.nameMode}`,
        "",
        "A complete status means the declared inspection finished. It does not mean that every finding is healthy.",
        "Equal content applies only within the inspected scope and is not deletion advice.",
        "",
        "## Versions",
        "",
        ...(projected.versions.commonlib === undefined
            ? []
            : [`- Commonlib version: ${markdownCode(projected.versions.commonlib)}`]),
        ...(projected.versions.plugin === undefined
            ? []
            : [`- Plug-in version: ${markdownCode(projected.versions.plugin)}`]),
        ...(projected.versions.application === undefined
            ? []
            : [`- Application version: ${markdownCode(projected.versions.application)}`]),
        ...(projected.versions.commonlib === undefined &&
        projected.versions.plugin === undefined &&
        projected.versions.application === undefined
            ? ["No version information was provided."]
            : []),
        "",
        "## Settings",
        "",
        `- Encryption: ${projected.settings.encrypt ? "enabled" : "disabled"}`,
        `- Path obfuscation: ${projected.settings.usePathObfuscation ? "enabled" : "disabled"}`,
        `- Filename case sensitivity: ${projected.settings.handleFilenameCaseSensitive ? "enabled" : "disabled"}`,
        `- ID derivation version: ${projected.settings.idDerivationVersion}`,
        `- Path normalisation version: ${projected.settings.pathNormalizationVersion}`,
        "",
        "## Scope",
        "",
        "- Metadata: normal files and current conflict branches",
        "- Content: suspect groups only",
        "- History: not checked",
        "- Atomic snapshot: no",
        "",
        "## Coverage",
        "",
        "| Source | Status | Documents | Metadata | Excluded | Conflict branches | Content reads | Changed during run |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ];
    for (const [source, coverage] of coverageRows) {
        lines.push(
            `| ${source} | ${coverage.status} | ${coverage.documents} | ${coverage.metadata} | ${coverage.excluded} | ${coverage.conflictBranches} | ${coverage.contentReads} | ${coverage.changedDuringRun} |`
        );
    }
    lines.push(
        "",
        "## Counts",
        "",
        `- Identity mismatches: ${mismatchCount}`,
        `- Conflict observations: ${conflictCount}`,
        `- Missing or unreadable content observations: ${unavailableContentCount}`,
        `- Unavailable chunks: ${unavailableChunkCount}`,
        `- Errors: ${projected.errors.length}`,
        "",
        "## Findings",
        ""
    );
    if (observations.length === 0) lines.push("No observations were returned.");
    for (const observation of observations) lines.push(...renderObservation(observation), "");
    if (projected.errors.length > 0) {
        lines.push("## Errors", "");
        for (const error of projected.errors) {
            const details = [
                `source=${error.source}`,
                `reason=${error.reason}`,
                ...(error.id === undefined ? [] : [`id=${markdownCode(error.id)}`]),
                ...(error.revision === undefined ? [] : [`revision=${markdownCode(error.revision)}`]),
                ...(error.path === undefined ? [] : [`path=${markdownCode(error.path)}`]),
                ...(error.chunkId === undefined ? [] : [`chunkId=${markdownCode(error.chunkId)}`]),
            ];
            lines.push(`- ${details.join(", ")}`);
        }
    }
    return lines.join("\n").trimEnd();
}
