import type {
    DatabaseIntegrityResult,
    DiagnosticCoverage,
    DiagnosticError,
    DiagnosticIdentitySettings,
    DiagnosticNameMode,
    DiagnosticObservation,
    DiagnosticPathEquivalenceGroup,
    DiagnosticSourceName,
    DiagnosticStatus,
} from "./types.ts";
import type { DatabaseUsageError, DatabaseUsageResult, DatabaseUsageRow, DatabaseUsageStatus } from "./usage.ts";
import type { DiagnosticNameMapper } from "./names.ts";
export { createDiagnosticNameMapper, parseDiagnosticPathToken } from "./names.ts";
export type { DiagnosticNameMapper } from "./names.ts";

export interface DiagnosticReportVersions {
    commonlib?: string;
    plugin?: string;
    application?: string;
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
    caseEquivalentGroup?: string;
    nfcEquivalentGroup?: string;
    metadata?: DiagnosticObservation["metadata"];
    otherSourceGroup: DiagnosticObservation["otherSourceGroup"];
    vault: {
        reference: string;
        status: DiagnosticObservation["vault"]["status"];
        reason?: DiagnosticObservation["vault"]["reason"];
        size?: number;
        contentSizeDifference?: number;
        mtimeDifferenceMs?: number;
    };
    content: {
        status: DiagnosticObservation["content"]["status"];
        reason?: DiagnosticObservation["content"]["reason"];
        chunksRead: number;
        unavailableChunks: { id: string; status: "missing" | "unreadable" }[];
        size?: number;
        recordedSizeDifference?: number;
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
    pathEquivalenceGroups?: DiagnosticPathEquivalenceGroup[];
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

function finiteField<K extends string>(
    key: K,
    value: number | undefined,
    nonnegative = false
): Partial<Record<K, number>> {
    return typeof value === "number" && Number.isFinite(value) && (!nonnegative || value >= 0)
        ? ({ [key]: value } as Record<K, number>)
        : {};
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
        ...(observation.caseEquivalentGroup === undefined
            ? {}
            : {
                  caseEquivalentGroup: projectReference(observation.caseEquivalentGroup),
              }),
        ...(observation.nfcEquivalentGroup === undefined
            ? {}
            : {
                  nfcEquivalentGroup: projectReference(observation.nfcEquivalentGroup),
              }),
        ...(observation.metadata === undefined
            ? {}
            : {
                  metadata: {
                      type: ["plain", "newnote", "notes"].includes(observation.metadata.type)
                          ? observation.metadata.type
                          : "unknown",
                      ...finiteField("recordedSize", observation.metadata.recordedSize, true),
                      chunkReferences: observation.metadata.chunkReferences,
                      uniqueChunkReferences: observation.metadata.uniqueChunkReferences,
                      embeddedChunkReferences: observation.metadata.embeddedChunkReferences,
                  },
              }),
        otherSourceGroup: observation.otherSourceGroup,
        vault: {
            reference: projectReference(observation.vault.reference),
            status: observation.vault.status,
            ...(observation.vault.reason === undefined ? {} : { reason: observation.vault.reason }),
            ...finiteField("size", observation.vault.size, true),
            ...finiteField("contentSizeDifference", observation.vault.contentSizeDifference),
            ...finiteField("mtimeDifferenceMs", observation.vault.mtimeDifferenceMs),
        },
        content: {
            status: observation.content.status,
            ...(observation.content.reason === undefined ? {} : { reason: observation.content.reason }),
            chunksRead: observation.content.chunksRead,
            unavailableChunks: observation.content.unavailableChunks.map((chunk) => ({
                id: mapper.chunk(chunk.id),
                status: chunk.status,
            })),
            ...finiteField("size", observation.content.size, true),
            ...finiteField("recordedSizeDifference", observation.content.recordedSizeDifference),
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
    const safeReference = /^((local|remote):[0-9]+|vault:(local|remote):[0-9]+|(case|nfc):[0-9]+)$/;
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
        ...(result.pathEquivalenceGroups === undefined
            ? {}
            : {
                  pathEquivalenceGroups: result.pathEquivalenceGroups.map((group) => ({
                      reference: projectReference(group.reference),
                      kind: group.kind === "case" ? ("case" as const) : ("nfc" as const),
                      members: group.members.map(projectReference),
                  })),
              }),
        errors: result.errors.map((error) => projectIntegrityError(error, mapper)),
        scope: {
            remote: result.scope.remote === "excluded" ? "excluded" : "included",
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
        rev: mapper.mode === "pseudonym" ? (/^([1-9][0-9]*)-/.exec(revision)?.[1] ?? "") : row.rev,
        revHash: mapper.mode === "pseudonym" ? revision.replace(/^[1-9][0-9]*-/, "") : row.revHash,
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

function longestBacktickRun(value: string): number {
    let longest = 0;
    for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return longest;
}

function markdownCode(value: string): string {
    const text = value
        .replace(/\r\n?|\n|\t/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const fence = "`".repeat(longestBacktickRun(text) + 1);
    const padding = /^\s|\s$/.test(text) ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
}

function renderMaybe(value: string | undefined): string {
    return value === undefined ? "?" : markdownCode(value);
}

const IDENTITY_LABELS = {
    consistent: "consistent",
    "document-id-mismatch": "documentIdMismatch",
    "namespace-mismatch": "namespaceMismatch",
} satisfies Record<ProjectedDiagnosticObservation["identity"], string>;

function renderState(observation: ProjectedDiagnosticObservation): string {
    return [
        IDENTITY_LABELS[observation.identity],
        observation.branch,
        observation.logicallyDeleted ? "logicallyDeleted" : "logicallyLive",
        observation.pathIsNFC ? "NFC" : "nonNFC",
        observation.metadata?.type ?? "notRecorded",
    ].join("-");
}

function renderPathGroup(present: boolean, group: string | undefined): string {
    return `${present ? "yes" : "none"}${group === undefined ? "" : `@${markdownCode(group)}`}`;
}

function renderContentStatus(value: { status: string; reason?: string }): string {
    return `${value.status}${value.reason === undefined ? "" : `(${value.reason})`}`;
}

function renderDifference(value: number): string {
    return `${value > 0 ? "+" : ""}${value}`;
}

function renderObservation(observation: ProjectedDiagnosticObservation): string[] {
    const metadata = observation.metadata;
    const expectedId = observation.expectedId === observation.id ? "self" : renderMaybe(observation.expectedId);
    const lines = [
        `### ${markdownCode(observation.reference)} source=${observation.source}`,
        `path: ${markdownCode(observation.path)}`,
        `doc: ${markdownCode(observation.id)} rev=${renderMaybe(observation.revision)} expected=${expectedId}`,
        `state: ${renderState(observation)} conflicts=${observation.conflictCount}`,
        `paths: case=${renderPathGroup(observation.caseEquivalentPaths, observation.caseEquivalentGroup)} nfcPeers=${renderPathGroup(observation.nfcEquivalentPaths, observation.nfcEquivalentGroup)} | otherDB=${observation.otherSourceGroup}`,
        `data: recorded=${metadata?.recordedSize === undefined ? "?" : `${metadata.recordedSize}B`} chunks=${metadata === undefined ? "?" : `${metadata.chunkReferences}/${metadata.uniqueChunkReferences}/${metadata.embeddedChunkReferences}`} read=${observation.content.chunksRead}`,
        `check: content=${renderContentStatus(observation.content)} vault=${renderContentStatus(observation.vault)}@${markdownCode(observation.vault.reference)}`,
    ];
    const measurements: string[] = [];
    if (observation.content.size !== undefined) measurements.push(`content=${observation.content.size}B`);
    if (observation.vault.size !== undefined) measurements.push(`vault=${observation.vault.size}B`);
    if (observation.content.recordedSizeDifference !== undefined)
        measurements.push(`deltaContent=${renderDifference(observation.content.recordedSizeDifference)}B`);
    if (observation.vault.contentSizeDifference !== undefined)
        measurements.push(`deltaVault=${renderDifference(observation.vault.contentSizeDifference)}B`);
    if (observation.vault.mtimeDifferenceMs !== undefined)
        measurements.push(`deltaMtime=${renderDifference(observation.vault.mtimeDifferenceMs)}ms`);
    if (measurements.length > 0) lines.push(`measure: ${measurements.join(" ")}`);
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

function unavailableStatus(status: string): boolean {
    return status === "missing" || status === "unreadable";
}

function hasMeasuredDifference(observation: ProjectedDiagnosticObservation): boolean {
    return [
        observation.content.recordedSizeDifference,
        observation.vault.contentSizeDifference,
        observation.vault.mtimeDifferenceMs,
    ].some((value) => value !== undefined && value !== 0);
}

const REVIEW_CONDITIONS: [string, (observation: ProjectedDiagnosticObservation) => boolean][] = [
    ["Identity mismatches", (observation) => observation.identity !== "consistent"],
    ["Current conflicts", (observation) => observation.branch === "conflict" || observation.conflictCount > 0],
    ["Case-equivalent paths", (observation) => observation.caseEquivalentPaths],
    ["NFC-equivalent paths", (observation) => observation.nfcEquivalentPaths],
    ["Non-NFC paths", (observation) => !observation.pathIsNFC],
    ["Other database group missing", (observation) => observation.otherSourceGroup === "missing"],
    ["Missing or unreadable database content", (observation) => unavailableStatus(observation.content.status)],
    ["Missing or unreadable Vault content", (observation) => unavailableStatus(observation.vault.status)],
    ["Unavailable chunks", (observation) => observation.content.unavailableChunks.length > 0],
    [
        "Different or unavailable comparisons",
        (observation) =>
            observation.comparisons.some(
                (comparison) => comparison.relation === "different" || comparison.relation === "unavailable"
            ),
    ],
    ["Measured differences", hasMeasuredDifference],
    ["Metadata not recorded", (observation) => observation.metadata === undefined],
];

function renderFindingSummary(observations: ProjectedDiagnosticObservation[]): string[] {
    const states = new Map<string, number>();
    for (const observation of observations) {
        const state = renderState(observation);
        states.set(state, (states.get(state) ?? 0) + 1);
    }
    const lines = [
        "## State counts",
        "",
        "Counts are observations, not unique files. Local and remote observations are counted separately.",
        "",
        ...Array.from(states.keys())
            .sort()
            .map((state) => `- ${state}: ${states.get(state)}`),
        ...(states.size === 0 ? ["No observations were returned."] : []),
        "",
        "## Review index",
        "",
        "These references match review conditions, not confirmed corruption. Unlisted observations may contain unchecked content.",
        "",
    ];
    let matched = false;
    for (const [caption, condition] of REVIEW_CONDITIONS) {
        const references = observations.filter(condition).map((observation) => markdownCode(observation.reference));
        if (references.length === 0) continue;
        matched = true;
        for (let offset = 0; offset < references.length; offset += 8)
            lines.push(`- ${caption}: ${references.slice(offset, offset + 8).join(", ")}`);
    }
    if (!matched) lines.push("No observations matched the review conditions.");
    lines.push("");
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
        projected.scope.remote === "excluded"
            ? "- Remote database: excluded from this inspection"
            : "- Remote database: included",
        "- Metadata: normal files and current conflict branches",
        "- Metadata values are decoded and decrypted before inspection.",
        "- Content: suspect groups only",
        "- Size and time measurements use existing reads; absent measurements were not available or not checked.",
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
        `- Content not checked: ${observations.filter((observation) => observation.content.status === "not-checked").length}`,
        `- Vault content not checked: ${observations.filter((observation) => observation.vault.status === "not-checked").length}`,
        `- Unavailable chunks: ${unavailableChunkCount}`,
        `- Errors: ${projected.errors.length}`,
        "",
        "## Reading the findings",
        "",
        "- state: identity-branch-logicalDeletion-pathNormalisation-MetadataType; conflicts is the current conflict count.",
        "- Identity: consistent, documentIdMismatch (document-id-mismatch in JSON), or namespaceMismatch (namespace-mismatch in JSON).",
        "- Branch: winner or conflict. A winner can still have conflicts; a consistent identity does not prove content is readable or equal.",
        "- Deletion: logicallyLive or logicallyDeleted. Path: NFC or nonNFC. Metadata: plain, newnote, notes, unknown, or notRecorded when absent.",
        "- path is the original path or report lookup token. doc is the document ID; rev retains the revision generation.",
        "- expected=self means the expected ID equals doc exactly. ? means not recorded, never zero.",
        "- paths: case and nfcPeers are yes or none; @ gives the path-equivalence group reference.",
        "- otherDB: present, missing, or not-checked for the same identity/path group in the other inspected database; present does not prove equal content.",
        "- data: recorded is the Metadata size in bytes; chunks=total/unique/embedded references; read counts Chunks read, not network requests.",
        "- check: available, missing, unreadable, or not-checked; parentheses retain the reason, and vault@ references the Vault comparison target.",
        "- measure includes available values only: content and vault sizes in bytes, deltaContent=content-Metadata, deltaVault=Vault-content, deltaMtime=Vault-Metadata in milliseconds.",
        "- Differences retain their sign (+ for positive); absent measurements were unavailable or not checked. Measurements do not select an authoritative version.",
        "- Unavailable chunks, comparisons, path-equivalence groups, and errors retain their references and reasons.",
        "",
        ...renderFindingSummary(observations),
        "## Findings",
        ""
    );
    if (observations.length === 0) lines.push("No observations were returned.");
    for (const observation of observations) lines.push(...renderObservation(observation), "");
    if (projected.pathEquivalenceGroups?.length) {
        lines.push("## Path equivalence groups", "");
        for (const group of projected.pathEquivalenceGroups) {
            lines.push(
                `- ${markdownCode(group.reference)} (${group.kind}): ${group.members.map(markdownCode).join(", ")}`
            );
        }
        lines.push("");
    }
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
    const body = lines.join("\n").trimEnd();
    const summaryStatus = (["complete", "partial", "failed", "cancelled"] as const).includes(projected.status)
        ? projected.status
        : "unknown";
    const fenceLength = Math.max(3, longestBacktickRun(body) + 1);
    const fence = "`".repeat(fenceLength);

    return [
        "<details>",
        `<summary>Database integrity report (${summaryStatus})</summary>`,
        "",
        `${fence}text`,
        body,
        fence,
        "</details>",
    ].join("\n");
}
