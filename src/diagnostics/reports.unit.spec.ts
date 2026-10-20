import { describe, expect, it } from "vitest";

import type { DatabaseIntegrityResult } from "./types.ts";
import type { DiagnosticReportVersions } from "./index.ts";
import {
    createDiagnosticNameMapper,
    formatDiagnosticJSON,
    formatIntegrityMarkdown,
    formatUsageTSV,
    projectIntegrityReport,
    projectUsageReport,
    type DiagnosticNameMapper,
    type ProjectedDatabaseUsageReport,
} from "./reports.ts";
import type { DatabaseUsageResult } from "./usage.ts";

const privatePath = "private-folder/Secret File.md";
const privateId = "document-secret-271";
const privateRevision = "7-private-revision-hash";
const privateExpectedId = "expected-document-secret";
const privateChunkId = "chunk-secret-319";
const privateErrorText = "raw-error-with-secret-content";
const privateUrl = "https://user:password@example.invalid/private";
const privateMetadataValue = "raw-private-metadata-value";
const privateGroupReference = "raw-private-group-reference";
const privateMemberReference = "raw-private-member-reference";
const reportSalt = "Report01";

function pseudonymMapper(): DiagnosticNameMapper {
    return createDiagnosticNameMapper("pseudonym", reportSalt);
}

function integrityResult(): DatabaseIntegrityResult {
    return {
        schemaVersion: 1,
        kind: "integrity",
        status: "partial",
        settings: {
            encrypt: true,
            usePathObfuscation: false,
            handleFilenameCaseSensitive: true,
            idDerivationVersion: 3,
            pathNormalizationVersion: 2,
            passphrase: "secret-passphrase",
            connectionUrl: privateUrl,
        },
        coverage: {
            local: {
                status: "partial",
                documents: 2,
                metadata: 2,
                excluded: 1,
                conflictBranches: 1,
                contentReads: 1,
                changedDuringRun: true,
                privateField: "content-from-document",
            },
            remote: {
                status: "complete",
                documents: 1,
                metadata: 1,
                excluded: 0,
                conflictBranches: 0,
                contentReads: 1,
                changedDuringRun: false,
            },
        },
        observations: [
            {
                reference: "local:1",
                source: "local",
                id: privateId,
                revision: privateRevision,
                path: privatePath,
                expectedId: privateExpectedId,
                identity: "document-id-mismatch",
                logicallyDeleted: false,
                branch: "winner",
                conflictCount: 1,
                pathIsNFC: false,
                caseEquivalentPaths: true,
                nfcEquivalentPaths: true,
                otherSourceGroup: "present",
                vault: { reference: "vault:local:1", status: "missing", reason: "chunk-missing" },
                content: {
                    status: "unreadable",
                    reason: "content-unreadable",
                    chunksRead: 1,
                    unavailableChunks: [{ id: privateChunkId, status: "unreadable", rawError: privateErrorText }],
                    bytes: "private raw content",
                },
                comparisons: [
                    { against: "remote:1", relation: "different", fileContent: "private raw content" },
                    { against: "raw-private-reference", relation: "unavailable" },
                ],
                url: privateUrl,
                secret: privateErrorText,
            },
            {
                reference: "remote:1",
                source: "remote",
                id: "remote-document-secret",
                path: privatePath,
                identity: "consistent",
                logicallyDeleted: false,
                branch: "conflict",
                conflictCount: 1,
                pathIsNFC: true,
                caseEquivalentPaths: true,
                nfcEquivalentPaths: true,
                otherSourceGroup: "present",
                vault: { reference: "vault:remote:1", status: "unreadable", reason: "content-unreadable" },
                content: { status: "available", chunksRead: 2, unavailableChunks: [] },
                comparisons: [
                    { against: "local:1", relation: "different" },
                    { against: "raw-private-reference", relation: "not-checked" },
                ],
            },
            {
                reference: "remote:2",
                source: "remote",
                id: "remote-case-variant-document",
                path: "PRIVATE-FOLDER/Secret File.md",
                identity: "consistent",
                logicallyDeleted: false,
                branch: "winner",
                conflictCount: 0,
                pathIsNFC: true,
                caseEquivalentPaths: true,
                nfcEquivalentPaths: false,
                otherSourceGroup: "missing",
                vault: { reference: "vault:remote:2", status: "not-checked" },
                content: { status: "not-checked", chunksRead: 0, unavailableChunks: [] },
                comparisons: [],
            },
            {
                reference: "local:2",
                source: "local",
                id: "local-unchecked-document",
                path: "Uninspected.md",
                identity: "consistent",
                logicallyDeleted: false,
                branch: "winner",
                conflictCount: 0,
                pathIsNFC: true,
                caseEquivalentPaths: false,
                nfcEquivalentPaths: false,
                otherSourceGroup: "not-checked",
                vault: { reference: "vault:local:2", status: "not-checked" },
                content: { status: "not-checked", chunksRead: 0, unavailableChunks: [] },
                comparisons: [],
            },
        ],
        errors: [
            {
                source: "storage",
                reason: "content-unreadable",
                id: privateId,
                revision: privateRevision,
                path: privatePath,
                chunkId: privateChunkId,
                rawError: privateErrorText,
                url: privateUrl,
            },
        ],
        scope: {
            metadata: "normal-files-and-current-conflicts",
            content: "suspect-groups-only",
            history: "not-checked",
            atomicSnapshot: false,
            connectionString: privateUrl,
        },
        startUpdateSeq: "opaque-sequence-with-host-data",
        endUpdateSeq: "another-opaque-sequence-with-host-data",
        rawDatabase: "private raw content",
    } as unknown as DatabaseIntegrityResult;
}

function usageResult(): DatabaseUsageResult {
    return {
        version: 1,
        kind: "usage",
        status: "partial",
        startUpdateSeq: "opaque-sequence-with-host-data",
        endUpdateSeq: "another-opaque-sequence-with-host-data",
        changedDuringRun: true,
        rows: [
            {
                title: "untrusted title must not survive",
                id: privateId,
                path: privatePath,
                revision: privateRevision,
                rev: "7",
                revHash: "private-hash",
                uniqueChunkCount: 2,
                sharedChunkCount: 3,
                uniqueChunkSize: 41,
                sharedChunkSize: 59,
                content: "private raw content",
                url: privateUrl,
            },
            {
                title: "another untrusted title",
                id: "second-private-document",
                path: privatePath,
                revision: "8-another-private-revision",
                rev: "8",
                revHash: "another-private-hash",
                uniqueChunkCount: 5,
                sharedChunkCount: 7,
                uniqueChunkSize: 61,
                sharedChunkSize: 71,
            },
            {
                title: "__orphan",
                id: "__orphan",
                path: "__orphan",
                revision: "1-xxxxx",
                rev: "1",
                revHash: "xxxxx",
                uniqueChunkCount: 11,
                sharedChunkCount: 0,
                uniqueChunkSize: 101,
                sharedChunkSize: 0,
            },
        ],
        errors: [
            {
                code: "revision_read_failed",
                id: privateId,
                revision: privateRevision,
                rawError: privateErrorText,
                url: privateUrl,
            },
        ],
        passphrase: "secret-passphrase",
        rawError: privateErrorText,
        rawContent: "private raw content",
        url: privateUrl,
    } as unknown as DatabaseUsageResult;
}

function assertDoesNotContainSecrets(value: string): void {
    for (const secret of [
        privatePath,
        privateId,
        privateRevision,
        privateExpectedId,
        privateChunkId,
        privateErrorText,
        privateUrl,
        "secret-passphrase",
        "private raw content",
        "private-hash",
        "remote-document-secret",
        "remote-case-variant-document",
        "local-unchecked-document",
        "Uninspected.md",
        "PRIVATE-FOLDER/Secret File.md",
        "another-private-revision",
        "another-private-hash",
        "raw-private-reference",
        privateMetadataValue,
        privateGroupReference,
        privateMemberReference,
        "opaque-sequence-with-host-data",
    ]) {
        expect(value).not.toContain(secret);
    }
}

function assertDoesNotContainSensitiveExtras(value: string): void {
    for (const secret of [
        privateErrorText,
        privateUrl,
        "secret-passphrase",
        "private raw content",
        "opaque-sequence-with-host-data",
        "another-opaque-sequence-with-host-data",
    ]) {
        expect(value).not.toContain(secret);
    }
}

describe("diagnostic report projection", () => {
    it("projects safe Metadata evidence and path equivalence groups to JSON and Markdown", () => {
        const input = integrityResult();
        Object.assign(input.observations[1], {
            metadata: {
                type: privateMetadataValue,
                recordedSize: Number.NaN,
                chunkReferences: 2,
                uniqueChunkReferences: 2,
                embeddedChunkReferences: 0,
                rawPath: privatePath,
                privateField: privateErrorText,
            },
            pathEquivalenceGroup: privateGroupReference,
        });
        Object.assign(input.observations[2], { nfcEquivalentGroup: "nfc:1" });
        Object.assign(input.observations[3], {
            reference: privateMemberReference,
            caseEquivalentGroup: "case:1",
            nfcEquivalentGroup: privateGroupReference,
            metadata: {
                type: "plain",
                recordedSize: 8,
                chunkReferences: 4,
                uniqueChunkReferences: 2,
                embeddedChunkReferences: 2,
                rawPath: privatePath,
                privateField: privateMetadataValue,
            },
            content: {
                status: "available",
                chunksRead: 4,
                unavailableChunks: [],
                size: 6,
                recordedSizeDifference: -2,
                rawBytes: "private raw content",
            },
            vault: {
                reference: "vault:local:2",
                status: "available",
                size: 5,
                contentSizeDifference: -1,
                mtimeDifferenceMs: 30,
                privateField: privateErrorText,
            },
        });
        Object.assign(input, {
            pathEquivalenceGroups: [
                {
                    reference: "case:1",
                    kind: "case",
                    members: ["local:1", privateMemberReference],
                    rawPath: privatePath,
                    privateField: privateMetadataValue,
                },
                {
                    reference: "nfc:1",
                    kind: "nfc",
                    members: ["remote:1", "local:2"],
                    rawPath: privatePath,
                    privateField: privateMetadataValue,
                },
                {
                    reference: privateGroupReference,
                    kind: "nfc",
                    members: [privateMemberReference],
                    rawPath: privatePath,
                    privateField: privateErrorText,
                },
            ],
        });

        const mapper = pseudonymMapper();
        const projected = projectIntegrityReport(input, mapper);
        const json = formatDiagnosticJSON(projected);
        const markdown = formatIntegrityMarkdown(projected);
        type ProjectedEvidence = {
            reference: string;
            caseEquivalentGroup?: string;
            nfcEquivalentGroup?: string;
            metadata?: {
                type: string;
                recordedSize?: number;
                chunkReferences: number;
                uniqueChunkReferences: number;
                embeddedChunkReferences: number;
            };
            vault: {
                reference: string;
                status: string;
                size?: number;
                contentSizeDifference?: number;
                mtimeDifferenceMs?: number;
            };
            content: {
                status: string;
                size?: number;
                recordedSizeDifference?: number;
            };
        };
        type ProjectedPathGroup = { reference: string; kind: "case" | "nfc"; members: string[] };
        const observations = projected.observations as unknown as ProjectedEvidence[];
        const groups = (projected as unknown as { pathEquivalenceGroups?: ProjectedPathGroup[] }).pathEquivalenceGroups;

        expect(observations[3].metadata).toEqual({
            type: "plain",
            recordedSize: 8,
            chunkReferences: 4,
            uniqueChunkReferences: 2,
            embeddedChunkReferences: 2,
        });
        expect(observations[3].content).toMatchObject({ status: "available", size: 6, recordedSizeDifference: -2 });
        expect(observations[3].vault).toMatchObject({
            reference: "vault:local:2",
            status: "available",
            size: 5,
            contentSizeDifference: -1,
            mtimeDifferenceMs: 30,
        });
        expect(observations[1].metadata).toEqual({
            type: "unknown",
            chunkReferences: 2,
            uniqueChunkReferences: 2,
            embeddedChunkReferences: 0,
        });
        expect(observations[0]).not.toHaveProperty("metadata");
        expect(observations[2]).not.toHaveProperty("metadata");
        expect(observations[2].content).not.toHaveProperty("size");
        expect(observations[2].vault).not.toHaveProperty("size");
        expect(observations[2].nfcEquivalentGroup).toBe("nfc:1");
        expect(observations[3].caseEquivalentGroup).toBe("case:1");

        expect(groups).toHaveLength(3);
        expect(groups?.[0]).toEqual({
            reference: "case:1",
            kind: "case",
            members: ["local:1", observations[3].reference],
        });
        expect(groups?.[1]).toEqual({ reference: "nfc:1", kind: "nfc", members: ["remote:1", "local:2"] });
        expect(groups?.[2].reference).toMatch(/^finding-[0-9]{3}$/);
        expect(groups?.[2].members).toEqual([observations[3].reference]);
        expect(observations[3].nfcEquivalentGroup).toBe(groups?.[2].reference);

        const parsed = JSON.parse(json) as unknown as {
            pathEquivalenceGroups?: ProjectedPathGroup[];
            observations: ProjectedEvidence[];
        };
        expect(parsed.pathEquivalenceGroups).toEqual(groups);
        expect(parsed.observations[3].metadata).toEqual(observations[3].metadata);
        expect(markdown).toContain("-plain conflicts=");
        expect(markdown).toContain("data: recorded=8B chunks=4/2/2 read=4");
        expect(markdown).toContain("measure: content=6B vault=5B deltaContent=-2B deltaVault=-1B deltaMtime=+30ms");
        expect(markdown).toContain("case:1");
        expect(markdown).toContain("nfc:1");
        assertDoesNotContainSecrets(json);
        assertDoesNotContainSecrets(markdown);
    });

    it("retains the explicitly excluded remote scope in JSON and Markdown", () => {
        const result = integrityResult();
        result.scope.remote = "excluded";
        result.coverage.remote.status = "not-checked";
        const projected = projectIntegrityReport(result, createDiagnosticNameMapper("pseudonym"));
        expect(projected.scope.remote).toBe("excluded");
        expect(JSON.parse(formatDiagnosticJSON(projected)).coverage.remote.status).toBe("not-checked");
        expect(formatIntegrityMarkdown(projected)).toContain("Remote database: excluded from this inspection");
    });

    it("keeps exact path spelling and separates path, document, revision, and chunk aliases", () => {
        const mapper = pseudonymMapper();
        const nfc = "caf\u00e9.md";
        const nfd = "cafe\u0301.md";
        const upper = "Folder/NOTE.md";
        const lower = "Folder/note.md";

        const nfcAlias = mapper.path(nfc);
        const nfdAlias = mapper.path(nfd);
        expect(nfcAlias).toMatch(new RegExp(`^${reportSalt}\\$[0-9a-f]{32}$`));
        expect(nfdAlias).toMatch(new RegExp(`^${reportSalt}\\$[0-9a-f]{32}$`));
        expect(nfcAlias).not.toBe(nfdAlias);
        expect(mapper.path(upper)).not.toBe(mapper.path(lower));
        expect(mapper.path(nfc)).toBe(nfcAlias);
        expect(mapper.path(privatePath)).toBe(mapper.path(privatePath));
        const firstIdAlias = mapper.id("same-path-id-a");
        expect(firstIdAlias).toMatch(/^document-[0-9a-f]{32}$/);
        expect(mapper.id("same-path-id-b")).not.toBe(firstIdAlias);
        expect(mapper.revision("same-revision-value")).toMatch(/^psu[0-9a-f]{32}$/);
        expect(mapper.chunk("same-revision-value")).toMatch(/^chunk-[0-9a-f]{32}$/);

        const freshRun = pseudonymMapper();
        expect(freshRun.path(nfc)).toBe(nfcAlias);
        expect(freshRun.id("same-path-id-a")).toBe(firstIdAlias);
        expect(createDiagnosticNameMapper("original").path(nfc)).toBe(nfc);
        expect(createDiagnosticNameMapper("original").id("id\u0000verbatim")).toBe("id\u0000verbatim");
    });

    it("whitelists integrity fields in both modes and uses shared safe references", () => {
        const input = integrityResult();
        const pseudonyms = pseudonymMapper();
        const projected = projectIntegrityReport(input, pseudonyms);
        const json = formatDiagnosticJSON(projected);
        const markdown = formatIntegrityMarkdown(projected);
        const parsed = JSON.parse(json) as typeof projected;

        expect(parsed).toEqual(projected);
        expect(parsed.observations.map((observation) => observation.reference)).toEqual([
            "local:1",
            "remote:1",
            "remote:2",
            "local:2",
        ]);
        expect(parsed.observations.map((observation) => observation.vault)).toEqual([
            { reference: "vault:local:1", status: "missing", reason: "chunk-missing" },
            { reference: "vault:remote:1", status: "unreadable", reason: "content-unreadable" },
            { reference: "vault:remote:2", status: "not-checked" },
            { reference: "vault:local:2", status: "not-checked" },
        ]);
        expect(projected.observations[0]).toMatchObject({
            reference: "local:1",
            id: pseudonyms.id(privateId),
            revision: pseudonyms.revision(privateRevision),
            path: pseudonyms.path(privatePath),
            expectedId: pseudonyms.id(privateExpectedId),
            content: {
                unavailableChunks: [{ id: pseudonyms.chunk(privateChunkId), status: "unreadable" }],
            },
            comparisons: [
                { against: "remote:1", relation: "different" },
                { against: "finding-001", relation: "unavailable" },
            ],
            otherSourceGroup: "present",
            vault: { reference: "vault:local:1", status: "missing", reason: "chunk-missing" },
        });
        expect(projected.observations[1]).toMatchObject({
            reference: "remote:1",
            id: pseudonyms.id("remote-document-secret"),
            path: pseudonyms.path(privatePath),
            comparisons: [
                { against: "local:1", relation: "different" },
                { against: "finding-001", relation: "not-checked" },
            ],
            otherSourceGroup: "present",
            vault: { reference: "vault:remote:1", status: "unreadable", reason: "content-unreadable" },
        });
        expect(projected.observations[2]).toMatchObject({
            reference: "remote:2",
            id: pseudonyms.id("remote-case-variant-document"),
            path: pseudonyms.path("PRIVATE-FOLDER/Secret File.md"),
            otherSourceGroup: "missing",
            vault: { reference: "vault:remote:2", status: "not-checked" },
        });
        expect(projected.observations[3]).toMatchObject({
            reference: "local:2",
            id: pseudonyms.id("local-unchecked-document"),
            path: pseudonyms.path("Uninspected.md"),
            otherSourceGroup: "not-checked",
            vault: { reference: "vault:local:2", status: "not-checked" },
        });
        expect(projected.errors[0]).toEqual({
            source: "storage",
            reason: "content-unreadable",
            id: pseudonyms.id(privateId),
            revision: pseudonyms.revision(privateRevision),
            path: pseudonyms.path(privatePath),
            chunkId: pseudonyms.chunk(privateChunkId),
        });
        expect(projected.errors[0].chunkId).toBe(projected.observations[0].content.unavailableChunks[0].id);
        expect(projected.errors[0].chunkId).not.toBe(projected.errors[0].id);
        expect(projected.coverage.local.changedDuringRun).toBe(true);
        expect(projected.coverage.remote.changedDuringRun).toBe(false);
        expect(json).toContain('"scope"');
        expect(json).not.toContain("UpdateSeq");
        assertDoesNotContainSecrets(json);
        assertDoesNotContainSecrets(markdown);
        expect(markdown).toContain("Status: partial");
        expect(markdown).toContain("History: not checked");
        expect(markdown).toContain("Atomic snapshot: no");
        expect(markdown).toContain("Identity mismatches: 1");
        expect(markdown).toContain("Conflict observations: 1");
        expect(markdown).toContain("Missing or unreadable content observations: 1");
        expect(markdown).toContain("`local:1`: different");
        expect(markdown).toContain("`finding-001`: unavailable");
        expect(markdown).toContain("vault=missing(chunk-missing)@`vault:local:1`");
        expect(markdown).toContain("vault=unreadable(content-unreadable)@`vault:remote:1`");
        expect(markdown).toContain("vault=not-checked@`vault:remote:2`");
        expect(markdown).toContain("vault=not-checked@`vault:local:2`");
        expect(markdown).toContain("otherDB=missing");
        expect(markdown).toContain("otherDB=present");
        expect(markdown).toContain("otherDB=not-checked");
        expect(markdown).toContain("`finding-001`: not-checked");
        expect(markdown).toContain(`chunkId=\`${pseudonyms.chunk(privateChunkId)}\``);

        const original = projectIntegrityReport(input, createDiagnosticNameMapper("original"));
        const originalJson = formatDiagnosticJSON(original);
        expect(original.observations[0]).toMatchObject({ id: privateId, path: privatePath, revision: privateRevision });
        expect(original.errors[0]).toMatchObject({ id: privateId, path: privatePath, revision: privateRevision });
        expect(original.errors[0].chunkId).toBe(privateChunkId);
        expect(original.observations[0].comparisons[1].against).toBe("finding-001");
        expect(originalJson).toContain(privatePath);
        assertDoesNotContainSensitiveExtras(originalJson);
    });

    it("escapes original paths in Markdown and never turns them into links or HTML", () => {
        const input = integrityResult();
        input.observations[0].path = "<img src=x onerror=alert(1)> | `*_[link](https://evil.invalid)\nnext";
        const report = projectIntegrityReport(input, createDiagnosticNameMapper("original"));
        const markdown = formatIntegrityMarkdown(report);

        expect(markdown).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(markdown).toContain("| `*_[link](https://evil.invalid) next");
        expect(markdown).toContain("`".repeat(2));
        expect(markdown).not.toContain("<img");
        expect(markdown).not.toContain("\nnext");
    });

    it("folds the complete integrity Markdown report into a safe text code block", () => {
        const input = integrityResult();
        input.observations[0].path = "Project/File.md\n</details>\n``````\n<img src=x onerror=alert(1)>";
        const projected = projectIntegrityReport(input, createDiagnosticNameMapper("original"));
        const markdown = formatIntegrityMarkdown(projected);
        const lines = markdown.split("\n");
        const openingFenceLine = lines[3];

        expect(lines[0]).toBe("<details>");
        expect(lines[1]).toBe("<summary>Database integrity report (partial)</summary>");
        expect(lines[2]).toBe("");
        expect(openingFenceLine).toMatch(/^`{3,}text$/);

        const openingFence = openingFenceLine!.slice(0, -"text".length);
        const closingFenceIndex = lines.findIndex((line, index) => index > 3 && line === openingFence);
        expect(closingFenceIndex).toBeGreaterThan(3);
        expect(lines[closingFenceIndex + 1]).toBe("</details>");

        const body = lines.slice(4, closingFenceIndex).join("\n");
        const longestBacktickRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
        expect(openingFence.length).toBeGreaterThan(longestBacktickRun);
        expect(body).toContain("# Database integrity report");
        expect(body).toContain("## Versions");
        expect(body).toContain("## Settings");
        expect(body).toContain("## Scope");
        expect(body).toContain("## Coverage");
        expect(body).toContain("## Counts");
        expect(body).toContain("## Findings");
        expect(body).toContain("## Errors");
        expect(body).toContain("| Local | partial | 2 | 2 | 1 | 1 | 1 | true |");
        expect(body).toContain("| Remote | complete | 1 | 1 | 0 | 0 | 1 | false |");
        expect(body).toContain("&lt;/details&gt;");
        expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(body).not.toContain("</details>");
        expect(body).not.toContain("<img");
        assertDoesNotContainSensitiveExtras(markdown);
    });

    it("uses only a known status in the integrity report summary", () => {
        const input = integrityResult();
        (input as unknown as { status: string }).status = "partial</summary><img src=x onerror=alert(1)>";
        const projected = projectIntegrityReport(input, createDiagnosticNameMapper("pseudonym"));
        const markdown = formatIntegrityMarkdown(projected);

        expect(markdown).toContain("<summary>Database integrity report (unknown)</summary>");
        expect(markdown).not.toContain("<summary>Database integrity report (partial</summary>");
    });

    it("handles many backtick runs without exceeding the JavaScript argument limit", () => {
        const input = integrityResult();
        input.observations[0].path = "`x".repeat(150000);
        const report = projectIntegrityReport(input, createDiagnosticNameMapper("original"));
        expect(() => formatIntegrityMarkdown(report)).not.toThrow();
    });

    it("retains every observation in a large folded report", () => {
        const input = integrityResult();
        input.observations = Array.from({ length: 10000 }, (_, index) => ({
            ...input.observations[0],
            reference: `local:${index}`,
        }));
        const report = projectIntegrityReport(input, createDiagnosticNameMapper("pseudonym"));
        const markdown = formatIntegrityMarkdown(report);
        expect(markdown.match(/^### /gm)).toHaveLength(10000);
        expect(markdown.endsWith("</details>")).toBe(true);
    });

    it("keeps aliases containing Markdown syntax inert in integrity details", () => {
        const input = integrityResult();
        const aliasWithMarkdown = "alias` | [click](https://evil.invalid) <img src=x onerror=1>";
        const mapper: DiagnosticNameMapper = {
            mode: "pseudonym",
            path: () => aliasWithMarkdown,
            id: () => aliasWithMarkdown,
            revision: () => aliasWithMarkdown,
            chunk: () => aliasWithMarkdown,
        };
        const projected = projectIntegrityReport(input, mapper);
        const markdown = formatIntegrityMarkdown(projected);

        expect(markdown).toContain("path: ``alias` | [click](https://evil.invalid) &lt;img src=x onerror=1&gt;``");
        expect(markdown).toContain("doc: ``alias` | [click](https://evil.invalid) &lt;img src=x onerror=1&gt;``");
        expect(markdown).not.toContain("<img");
        assertDoesNotContainSecrets(markdown);
    });

    it("projects Usage aliases, titles, errors, and orphan values without changing counts", () => {
        const input = usageResult();
        const pseudonyms = pseudonymMapper();
        const projected = projectUsageReport(input, pseudonyms);
        const json = formatDiagnosticJSON(projected);
        const tsv = formatUsageTSV(projected);
        const firstPath = pseudonyms.path(privatePath);
        const firstRevision = pseudonyms.revision(privateRevision);
        const secondRevision = pseudonyms.revision("8-another-private-revision");
        const firstRevisionHash = firstRevision.replace(/^7-/, "");
        const secondRevisionHash = secondRevision.replace(/^8-/, "");
        const firstId = pseudonyms.id(privateId);
        const secondId = pseudonyms.id("second-private-document");

        expect(projected).toMatchObject({
            version: 1,
            kind: "usage",
            status: "partial",
            changedDuringRun: true,
            rows: [
                {
                    title: `${firstPath} (${firstRevision})`,
                    id: firstId,
                    path: firstPath,
                    revision: firstRevision,
                    rev: "7",
                    revHash: firstRevisionHash,
                    uniqueChunkCount: 2,
                    sharedChunkCount: 3,
                    uniqueChunkSize: 41,
                    sharedChunkSize: 59,
                },
                {
                    title: `${firstPath} (${secondRevision})`,
                    id: secondId,
                    path: firstPath,
                    rev: "8",
                    revHash: secondRevisionHash,
                    uniqueChunkCount: 5,
                    sharedChunkCount: 7,
                    uniqueChunkSize: 61,
                    sharedChunkSize: 71,
                },
                {
                    title: "__orphan",
                    id: "__orphan",
                    path: "__orphan",
                    revision: "1-xxxxx",
                    rev: "1",
                    revHash: "xxxxx",
                    uniqueChunkCount: 11,
                    sharedChunkCount: 0,
                    uniqueChunkSize: 101,
                    sharedChunkSize: 0,
                },
            ],
            errors: [{ code: "revision_read_failed", id: firstId, revision: firstRevision }],
        });
        expect(tsv.split("\n")[0]).toBe(
            "Title\tDocument ID\tPath\tRevision No\tRevision Hash\tUnique Chunk Count\tShared Chunk Count\tUnique Chunk Size\tShared Chunk Size"
        );
        expect(tsv).toContain(
            `${firstPath} (${firstRevision})\t${firstId}\t${firstPath}\t7\t${firstRevisionHash}\t2\t3\t41\t59`
        );
        assertDoesNotContainSecrets(json);
        assertDoesNotContainSecrets(tsv);
        expect(json).not.toContain("another-private-revision");
        expect(json).not.toContain("another-private-hash");

        const raw = projectUsageReport(input, createDiagnosticNameMapper("original"));
        expect(raw.rows[0]).toMatchObject({
            title: `${privatePath} (${privateRevision})`,
            id: privateId,
            path: privatePath,
            revision: privateRevision,
            rev: "7",
            revHash: "private-hash",
        });
        expect(raw.rows[0].title).not.toBe(input.rows[0].title);
        expect(raw.rows.at(-1)).toMatchObject({ title: "__orphan", id: "__orphan", rev: "1", revHash: "xxxxx" });
        expect(raw.errors).toEqual([{ code: "revision_read_failed", id: privateId, revision: privateRevision }]);
        const rawJson = formatDiagnosticJSON(raw);
        expect(rawJson).toContain(privatePath);
        expect(rawJson).toContain(privateId);
        assertDoesNotContainSensitiveExtras(rawJson);
    });

    it("escapes TSV tabs, newlines, carriage returns, and double quotes", () => {
        const projected: ProjectedDatabaseUsageReport = {
            version: 1,
            kind: "usage",
            status: "complete",
            nameMode: "pseudonym",
            versions: {},
            rows: [
                {
                    title: 'tab\tline\n"quoted"',
                    id: "document-1",
                    path: 'folder\r\n"name"',
                    revision: "revision-1",
                    rev: "1",
                    revHash: "revision-1",
                    uniqueChunkCount: 1,
                    sharedChunkCount: 2,
                    uniqueChunkSize: 3,
                    sharedChunkSize: 4,
                },
            ],
            errors: [],
        };

        const lines = formatUsageTSV(projected);
        expect(lines).toContain('"tab\tline\n""quoted"""\tdocument-1');
        expect(lines).toContain('"folder\r\n""name"""\t1\trevision-1');
        expect(lines.split("\n")[0]).toBe(
            "Title\tDocument ID\tPath\tRevision No\tRevision Hash\tUnique Chunk Count\tShared Chunk Count\tUnique Chunk Size\tShared Chunk Size"
        );
    });

    it("projects known report versions and includes the same versions and settings in integrity Markdown", () => {
        const input = integrityResult();
        const providedVersions: DiagnosticReportVersions & { privateUrl: string } = {
            commonlib: "0.1.42",
            plugin: "1.0.38",
            application: "1.0.38",
            privateUrl,
        };
        const integrity = projectIntegrityReport(input, pseudonymMapper(), providedVersions);
        const json = formatDiagnosticJSON(integrity);
        const parsed = JSON.parse(json) as typeof integrity;
        const markdown = formatIntegrityMarkdown(integrity);

        expect(integrity.versions).toEqual({
            commonlib: "0.1.42",
            plugin: "1.0.38",
            application: "1.0.38",
        });
        expect(parsed.versions).toEqual(integrity.versions);
        expect(markdown).toContain("- Commonlib version: `0.1.42`");
        expect(markdown).toContain("- Plug-in version: `1.0.38`");
        expect(markdown).toContain("- Application version: `1.0.38`");
        expect(markdown).toContain("- Encryption: enabled");
        expect(markdown).toContain("- Path obfuscation: disabled");
        expect(markdown).toContain("- Filename case sensitivity: enabled");
        expect(markdown).toContain("- ID derivation version: 3");
        expect(markdown).toContain("- Path normalisation version: 2");
        expect(json).not.toContain(privateUrl);
        expect(markdown).not.toContain(privateUrl);

        const partialVersions: DiagnosticReportVersions = { commonlib: "0.1.42" };
        const usage = projectUsageReport(usageResult(), pseudonymMapper(), partialVersions);
        const usageJson = formatDiagnosticJSON(usage);
        expect(usage.versions).toEqual({ commonlib: "0.1.42" });
        expect(Object.hasOwn(usage.versions, "plugin")).toBe(false);
        expect(Object.hasOwn(usage.versions, "application")).toBe(false);
        expect(usageJson).not.toContain('"plugin"');
        expect(usageJson).not.toContain('"application"');

        const defaultIntegrity = projectIntegrityReport(input, pseudonymMapper());
        const defaultUsage = projectUsageReport(usageResult(), pseudonymMapper());
        expect(defaultIntegrity.versions).toEqual({});
        expect(defaultUsage.versions).toEqual({});
        expect(formatUsageTSV(usage)).toBe(formatUsageTSV(defaultUsage));
        expect(formatUsageTSV(usage)).not.toContain("0.1.42");
    });

    it("records the selected name mode in JSON reports and integrity Markdown", () => {
        for (const mode of ["original", "pseudonym"] as const) {
            const mapper = createDiagnosticNameMapper(mode);
            const integrity = projectIntegrityReport(integrityResult(), mapper);
            const usage = projectUsageReport(usageResult(), mapper);
            const integrityJSON = JSON.parse(formatDiagnosticJSON(integrity)) as { nameMode?: string };
            const usageJSON = JSON.parse(formatDiagnosticJSON(usage)) as { nameMode?: string };

            expect(integrityJSON.nameMode).toBe(mode);
            expect(usageJSON.nameMode).toBe(mode);
            expect(formatIntegrityMarkdown(integrity)).toContain(`Names: ${mode}`);
        }
    });
});
