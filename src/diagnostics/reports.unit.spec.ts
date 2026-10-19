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
    it("keeps exact path spelling and separates path, document, revision, and chunk aliases", () => {
        const mapper = createDiagnosticNameMapper("pseudonym");
        const nfc = "caf\u00e9.md";
        const nfd = "cafe\u0301.md";
        const upper = "Folder/NOTE.md";
        const lower = "Folder/note.md";

        expect(mapper.path(nfc)).toBe("file-001");
        expect(mapper.path(nfd)).toBe("file-002");
        expect(mapper.path(upper)).toBe("file-003");
        expect(mapper.path(lower)).toBe("file-004");
        expect(mapper.path(nfc)).toBe("file-001");
        expect(mapper.path(privatePath)).toBe(mapper.path(privatePath));
        expect(mapper.id("same-path-id-a")).toBe("document-001");
        expect(mapper.id("same-path-id-b")).toBe("document-002");
        expect(mapper.revision("same-revision-value")).toBe("revision-001");
        expect(mapper.chunk("same-revision-value")).toBe("chunk-001");

        const freshRun = createDiagnosticNameMapper("pseudonym");
        expect(freshRun.path(nfc)).toBe("file-001");
        expect(freshRun.id("same-path-id-a")).toBe("document-001");
        expect(createDiagnosticNameMapper("original").path(nfc)).toBe(nfc);
        expect(createDiagnosticNameMapper("original").id("id\u0000verbatim")).toBe("id\u0000verbatim");
    });

    it("whitelists integrity fields in both modes and uses shared safe references", () => {
        const input = integrityResult();
        const pseudonyms = createDiagnosticNameMapper("pseudonym");
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
            id: "document-001",
            revision: "revision-001",
            path: "file-001",
            expectedId: "document-002",
            content: {
                unavailableChunks: [{ id: "chunk-001", status: "unreadable" }],
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
            id: "document-003",
            path: "file-001",
            comparisons: [
                { against: "local:1", relation: "different" },
                { against: "finding-001", relation: "not-checked" },
            ],
            otherSourceGroup: "present",
            vault: { reference: "vault:remote:1", status: "unreadable", reason: "content-unreadable" },
        });
        expect(projected.observations[2]).toMatchObject({
            reference: "remote:2",
            id: "document-004",
            path: "file-002",
            otherSourceGroup: "missing",
            vault: { reference: "vault:remote:2", status: "not-checked" },
        });
        expect(projected.observations[3]).toMatchObject({
            reference: "local:2",
            id: "document-005",
            path: "file-003",
            otherSourceGroup: "not-checked",
            vault: { reference: "vault:local:2", status: "not-checked" },
        });
        expect(projected.errors[0]).toEqual({
            source: "storage",
            reason: "content-unreadable",
            id: "document-001",
            revision: "revision-001",
            path: "file-001",
            chunkId: "chunk-001",
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
        expect(markdown).toContain("Vault content status: missing (chunk-missing)");
        expect(markdown).toContain("Vault content status: unreadable (content-unreadable)");
        expect(markdown).toContain("Vault content status: not-checked");
        expect(markdown).toContain("Other inspected database group: missing");
        expect(markdown).toContain("Other inspected database group: present");
        expect(markdown).toContain("Other inspected database group: not-checked");
        expect(markdown).toContain("Vault reference: `vault:local:1`");
        expect(markdown).toContain("Vault reference: `vault:remote:1`");
        expect(markdown).toContain("Vault reference: `vault:remote:2`");
        expect(markdown).toContain("Vault reference: `vault:local:2`");
        expect(markdown).toContain("`finding-001`: not-checked");
        expect(markdown).toContain("chunkId=`chunk-001`");

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

        expect(markdown).toContain("- Path: ``alias` | [click](https://evil.invalid) &lt;img src=x onerror=1&gt;``");
        expect(markdown).toContain(
            "- Document ID: ``alias` | [click](https://evil.invalid) &lt;img src=x onerror=1&gt;``"
        );
        expect(markdown).not.toContain("<img");
        assertDoesNotContainSecrets(markdown);
    });

    it("projects Usage aliases, titles, errors, and orphan values without changing counts", () => {
        const input = usageResult();
        const projected = projectUsageReport(input, createDiagnosticNameMapper("pseudonym"));
        const json = formatDiagnosticJSON(projected);
        const tsv = formatUsageTSV(projected);

        expect(projected).toMatchObject({
            version: 1,
            kind: "usage",
            status: "partial",
            changedDuringRun: true,
            rows: [
                {
                    title: "file-001 (revision-001)",
                    id: "document-001",
                    path: "file-001",
                    revision: "revision-001",
                    rev: "7",
                    revHash: "revision-001",
                    uniqueChunkCount: 2,
                    sharedChunkCount: 3,
                    uniqueChunkSize: 41,
                    sharedChunkSize: 59,
                },
                {
                    title: "file-001 (revision-002)",
                    id: "document-002",
                    path: "file-001",
                    rev: "8",
                    revHash: "revision-002",
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
            errors: [{ code: "revision_read_failed", id: "document-001", revision: "revision-001" }],
        });
        expect(tsv.split("\n")[0]).toBe(
            "Title\tDocument ID\tPath\tRevision No\tRevision Hash\tUnique Chunk Count\tShared Chunk Count\tUnique Chunk Size\tShared Chunk Size"
        );
        expect(tsv).toContain("file-001 (revision-001)\tdocument-001\tfile-001\t7\trevision-001\t2\t3\t41\t59");
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
        const integrity = projectIntegrityReport(input, createDiagnosticNameMapper("pseudonym"), providedVersions);
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
        const usage = projectUsageReport(usageResult(), createDiagnosticNameMapper("pseudonym"), partialVersions);
        const usageJson = formatDiagnosticJSON(usage);
        expect(usage.versions).toEqual({ commonlib: "0.1.42" });
        expect(Object.hasOwn(usage.versions, "plugin")).toBe(false);
        expect(Object.hasOwn(usage.versions, "application")).toBe(false);
        expect(usageJson).not.toContain('"plugin"');
        expect(usageJson).not.toContain('"application"');

        const defaultIntegrity = projectIntegrityReport(input, createDiagnosticNameMapper("pseudonym"));
        const defaultUsage = projectUsageReport(usageResult(), createDiagnosticNameMapper("pseudonym"));
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
