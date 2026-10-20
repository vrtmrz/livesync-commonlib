import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDiagnosticNameMapper, parseDiagnosticPathToken, projectUsageReport } from "./reports.ts";
import type { DatabaseUsageResult } from "./usage.ts";

describe("reproducible diagnostic pseudonyms", () => {
    it("uses a public per-report salt and the exact path spelling", () => {
        const salt = "Report01";
        const mapper = createDiagnosticNameMapper("pseudonym", salt);
        const path = "Private/cafe\u0301.md";
        const digest = createHash("sha256")
            .update(JSON.stringify(["livesync-diagnostic-v1", salt, "path", path]))
            .digest("hex")
            .slice(0, 32);
        expect(mapper.path(path)).toBe(`${salt}$${digest}`);
        expect(parseDiagnosticPathToken(mapper.path(path))).toEqual({ salt, hash: digest });
        expect(mapper.path(path.normalize("NFC"))).not.toBe(mapper.path(path));
        expect(mapper.path(path.toLowerCase())).not.toBe(mapper.path(path));
        expect(mapper.salt).toBe(salt);
    });

    it("reuses every name domain with the supplied salt independently of discovery order", () => {
        const first = createDiagnosticNameMapper("pseudonym");
        const next = createDiagnosticNameMapper("pseudonym", first.salt);
        for (const domain of ["path", "id", "revision", "chunk"] as const) {
            next[domain]("another value");
            expect(next[domain]("7-private")).toBe(first[domain]("7-private"));
        }
        expect(
            new Set(
                ["path", "id", "revision", "chunk"].map((domain) =>
                    first[domain as "path" | "id" | "revision" | "chunk"]("same")
                )
            ).size
        ).toBe(4);
        expect(createDiagnosticNameMapper("pseudonym").path("private.md")).not.toBe(first.path("private.md"));
    });

    it("retains only a valid revision generation and never exposes malformed input", () => {
        const mapper = createDiagnosticNameMapper("pseudonym", "Report01");
        expect(mapper.revision("7-private-revision")).toMatch(/^7-psu[0-9a-f]{32}$/);
        expect(mapper.revision("17-private-revision")).toMatch(/^17-psu[0-9a-f]{32}$/);
        for (const malformed of ["secret", "0-secret", "01-secret", "7-", "-7-secret", "Infinity-secret"]) {
            const alias = mapper.revision(malformed);
            expect(alias).toMatch(/^psu[0-9a-f]{32}$/);
            expect(alias).not.toContain(malformed);
        }
    });

    it("validates tokens and supplied salts before using them", () => {
        for (const token of ["file-001", "Report01$abc", `Report01$${"A".repeat(32)}`, `bad salt$${"a".repeat(32)}`]) {
            expect(parseDiagnosticPathToken(token)).toBeUndefined();
        }
        expect(() => createDiagnosticNameMapper("pseudonym", "unsafe salt")).toThrow();
    });

    it("keeps Usage revision, generation, and hash consistent and preserves orphan statistics", () => {
        const row = {
            title: "private",
            path: "private.md",
            id: "private",
            revision: "7-private",
            rev: "7",
            revHash: "privat",
            uniqueChunkCount: 1,
            sharedChunkCount: 2,
            uniqueChunkSize: 3,
            sharedChunkSize: 4,
        };
        const report = projectUsageReport(
            {
                version: 1,
                kind: "usage",
                status: "complete",
                errors: [],
                rows: [row, { ...row, id: "__orphan", path: "__orphan", title: "__orphan" }],
            } as DatabaseUsageResult,
            createDiagnosticNameMapper("pseudonym", "Report01")
        );
        expect(report.rows[0].revision).toBe(`7-${report.rows[0].revHash}`);
        expect(report.rows[0].revHash).toMatch(/^psu[0-9a-f]{32}$/);
        expect(report.rows[1]).toMatchObject({ revision: "1-xxxxx", rev: "1", revHash: "xxxxx" });
    });
});
