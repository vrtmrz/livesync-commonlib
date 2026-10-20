import { describe, expect, it } from "vitest";
import {
    createDiagnosticNameMapper,
    formatDiagnosticJSON,
    formatIntegrityMarkdown,
    projectIntegrityReport,
} from "./reports.ts";
import type { DatabaseIntegrityResult } from "./types.ts";

function regularResult(count = 1): DatabaseIntegrityResult {
    const coverage = {
        status: "complete" as const,
        documents: count,
        metadata: count,
        excluded: 0,
        conflictBranches: 0,
        contentReads: 0,
        changedDuringRun: false,
    };
    return {
        schemaVersion: 1,
        kind: "integrity",
        status: "complete",
        settings: {
            encrypt: false,
            usePathObfuscation: false,
            handleFilenameCaseSensitive: true,
            idDerivationVersion: 0,
            pathNormalizationVersion: 0,
        },
        coverage: { local: { ...coverage }, remote: { ...coverage } },
        scope: {
            remote: "included",
            metadata: "normal-files-and-current-conflicts",
            content: "suspect-groups-only",
            history: "not-checked",
            atomicSnapshot: false,
        },
        observations: Array.from({ length: count }, (_, index) => ({
            reference: `local:${index + 1}`,
            source: "local",
            id: `file-${index}.md`,
            expectedId: `file-${index}.md`,
            revision: "7-example",
            path: `file-${index}.md`,
            identity: "consistent",
            branch: "winner",
            logicallyDeleted: false,
            conflictCount: 0,
            pathIsNFC: true,
            caseEquivalentPaths: false,
            nfcEquivalentPaths: false,
            metadata: {
                type: "newnote",
                recordedSize: 47584,
                chunkReferences: 1,
                uniqueChunkReferences: 1,
                embeddedChunkReferences: 0,
            },
            otherSourceGroup: "present",
            vault: { reference: `vault:local:${index + 1}`, status: "not-checked" },
            content: { status: "not-checked", chunksRead: 0, unavailableChunks: [] },
            comparisons: [],
        })),
        errors: [],
    };
}

function findings(markdown: string): string {
    return markdown
        .split("## Findings\n\n")[1]!
        .split("\n## ")[0]!
        .replace(/\n`{3,}\n<\/details>$/, "");
}

describe("compact integrity Markdown", () => {
    it("retains an ordinary observation in seven lines with the original lookup token and revision", () => {
        const mapper = createDiagnosticNameMapper("pseudonym", "Report01");
        const report = projectIntegrityReport(regularResult(), mapper);
        const jsonBefore = formatDiagnosticJSON(report);
        const markdown = formatIntegrityMarkdown(report);
        expect(findings(markdown).split("\n\n")[0]!.split("\n")).toEqual([
            "### `local:1` source=local",
            `path: \`${mapper.path("file-0.md")}\``,
            `doc: \`${mapper.id("file-0.md")}\` rev=\`${mapper.revision("7-example")}\` expected=self`,
            "state: consistent-winner-logicallyLive-NFC-newnote conflicts=0",
            "paths: case=none nfcPeers=none | otherDB=present",
            "data: recorded=47584B chunks=1/1/0 read=0",
            "check: content=not-checked vault=not-checked@`vault:local:1`",
        ]);
        expect(markdown).toContain("chunks=total/unique/embedded");
        expect(markdown).toContain("State counts");
        expect(markdown).toContain("consistent-winner-logicallyLive-NFC-newnote: 1");
        expect(formatDiagnosticJSON(report)).toBe(jsonBefore);
    });

    it("distinguishes missing evidence from zero and abbreviates only an equal expected ID", () => {
        const input = regularResult(3);
        input.observations[0].metadata = undefined;
        input.observations[0].revision = undefined;
        input.observations[0].expectedId = undefined;
        input.observations[1].metadata!.recordedSize = 0;
        input.observations[1].metadata!.chunkReferences = 0;
        input.observations[1].metadata!.uniqueChunkReferences = 0;
        input.observations[1].expectedId = "different.md";
        input.observations[1].identity = "consistent";
        input.observations[2].metadata!.recordedSize = undefined;
        input.observations[2].otherSourceGroup = "not-checked";
        const markdown = formatIntegrityMarkdown(projectIntegrityReport(input, createDiagnosticNameMapper("original")));
        const rows = findings(markdown).split("\n\n");
        expect(rows[0]).toContain("rev=? expected=?");
        expect(rows[0]).toContain("state: consistent-winner-logicallyLive-NFC-notRecorded");
        expect(rows[0]).toContain("data: recorded=? chunks=? read=0");
        expect(rows[1]).toContain("expected=`different.md`");
        expect(rows[1]).toContain("data: recorded=0B chunks=0/0/0 read=0");
        expect(rows[2]).toContain("data: recorded=? chunks=1/1/0 read=0");
        expect(rows[2]).toContain("otherDB=not-checked");
        expect(markdown).toContain("Content not checked: 3");
        expect(markdown).toContain("Vault content not checked: 3");
    });

    it("preserves exceptional states, signed measurements, reasons, groups, and comparison targets", () => {
        const input = regularResult();
        Object.assign(input.observations[0], {
            identity: "namespace-mismatch",
            branch: "conflict",
            logicallyDeleted: true,
            conflictCount: 2,
            pathIsNFC: false,
            caseEquivalentPaths: true,
            caseEquivalentGroup: "case:1",
            nfcEquivalentPaths: true,
            nfcEquivalentGroup: "nfc:1",
            metadata: {
                type: "plain",
                recordedSize: 8,
                chunkReferences: 4,
                uniqueChunkReferences: 2,
                embeddedChunkReferences: 2,
            },
            content: {
                status: "unreadable",
                reason: "chunk-unreadable",
                chunksRead: 3,
                size: 6,
                recordedSizeDifference: -2,
                unavailableChunks: [
                    { id: "h:missing", status: "missing" },
                    { id: "h:unreadable", status: "unreadable" },
                ],
            },
            vault: {
                reference: "vault:local:1",
                status: "available",
                size: 6,
                contentSizeDifference: 0,
                mtimeDifferenceMs: 30,
            },
            comparisons: [
                { against: "remote:1", relation: "different" },
                { against: "remote:2", relation: "unavailable" },
                { against: "vault:local:1", relation: "not-checked" },
            ],
        });
        input.pathEquivalenceGroups = [
            { reference: "case:1", kind: "case", members: ["local:1", "remote:1"] },
            { reference: "nfc:1", kind: "nfc", members: ["local:1", "remote:2"] },
        ];
        const markdown = formatIntegrityMarkdown(projectIntegrityReport(input, createDiagnosticNameMapper("original")));
        expect(markdown).toContain("state: namespaceMismatch-conflict-logicallyDeleted-nonNFC-plain conflicts=2");
        expect(markdown).toContain("paths: case=yes@`case:1` nfcPeers=yes@`nfc:1`");
        expect(markdown).toContain("data: recorded=8B chunks=4/2/2 read=3");
        expect(markdown).toContain("check: content=unreadable(chunk-unreadable) vault=available@`vault:local:1`");
        expect(markdown).toContain("measure: content=6B vault=6B deltaContent=-2B deltaVault=0B deltaMtime=+30ms");
        expect(markdown).toContain("`h:missing` (missing), `h:unreadable` (unreadable)");
        expect(markdown).toContain("`remote:1`: different; `remote:2`: unavailable; `vault:local:1`: not-checked");
        expect(markdown).toContain("`case:1` (case): `local:1`, `remote:1`");
        expect(markdown).toContain("`nfc:1` (nfc): `local:1`, `remote:2`");
        const index = markdown.split("## Review index\n\n")[1]!.split("\n## Findings")[0]!;
        for (const caption of [
            "Case-equivalent paths",
            "NFC-equivalent paths",
            "Non-NFC paths",
            "Missing or unreadable database content",
            "Unavailable chunks",
            "Measured differences",
        ]) {
            expect(index).toContain(`${caption}: \`local:1\``);
        }
    });

    it("indexes review candidates without treating an unchecked ordinary winner as an error", () => {
        const input = regularResult(4);
        input.observations[1].conflictCount = 1;
        input.observations[2].identity = "document-id-mismatch";
        input.observations[2].otherSourceGroup = "missing";
        input.observations[2].vault = { reference: "vault:local:3", status: "missing" };
        input.observations[2].comparisons = [{ against: "remote:3", relation: "unavailable" }];
        input.observations[3].metadata = undefined;
        const markdown = formatIntegrityMarkdown(projectIntegrityReport(input, createDiagnosticNameMapper("original")));
        const index = markdown.split("## Review index\n\n")[1]?.split("\n## Findings")[0];
        expect(index).toBeDefined();
        expect(index).toContain("Current conflicts: `local:2`");
        expect(index).toContain("Identity mismatches: `local:3`");
        expect(index).toContain("Other database group missing: `local:3`");
        expect(index).toContain("Missing or unreadable Vault content: `local:3`");
        expect(index).toContain("Different or unavailable comparisons: `local:3`");
        expect(index).toContain("Metadata not recorded: `local:4`");
        expect(index).not.toContain("`local:1`");
        expect(markdown).toContain("state: documentIdMismatch-winner-logicallyLive-NFC-newnote");
        expect(findings(markdown).match(/^### /gm)).toHaveLength(4);
    });

    it("bounds repeated labels for 4000 paths across both databases while retaining every observation", () => {
        const input = regularResult(8000);
        for (const coverage of Object.values(input.coverage)) {
            coverage.documents = 4000;
            coverage.metadata = 4000;
        }
        for (let index = 0; index < input.observations.length; index++) {
            const observation = input.observations[index];
            const source = index < 4000 ? "local" : "remote";
            const number = index % 4000;
            Object.assign(observation, {
                source,
                reference: `${source}:${number + 1}`,
                path: `file-${number}.md`,
                id: `file-${number}.md`,
                expectedId: `file-${number}.md`,
                vault: { reference: `vault:${source}:${number + 1}`, status: "not-checked" },
            });
        }
        const report = projectIntegrityReport(input, createDiagnosticNameMapper("pseudonym", "Report01"));
        const markdown = formatIntegrityMarkdown(report);
        expect(markdown.match(/^### /gm)).toHaveLength(8000);
        expect(markdown.split("\n").length).toBeLessThan(8000 * 9);
        expect(markdown).toContain("consistent-winner-logicallyLive-NFC-newnote: 8000");
        expect(markdown).toContain("### `remote:4000` source=remote");
        expect(markdown).toContain(`path: \`${report.observations[7999].path}\``);
        expect(markdown).toContain("Content not checked: 8000");
        expect(markdown).toContain("No observations matched the review conditions.");
    });
});
