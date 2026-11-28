import { describe, expect, it } from "vitest";
import { haveMatchingRevisionPaths, hasFilenameCaseConflict } from "../conflicts";

describe("conflict revision paths", () => {
    it.each([
        { left: "Café.md", right: "Café.md", version: 0, matching: true, caseConflict: false },
        { left: "Café.md", right: "Cafe\u0301.md", version: 0, matching: false, caseConflict: false },
        { left: "Café.md", right: "Cafe\u0301.md", version: 1, matching: true, caseConflict: false },
        { left: "Café.md", right: "cafe\u0301.md", version: 0, matching: false, caseConflict: false },
        { left: "Café.md", right: "cafe\u0301.md", version: 1, matching: false, caseConflict: true },
        { left: "File.md", right: "file.md", version: 0, matching: false, caseConflict: true },
        { left: "File.md", right: "Other.md", version: 1, matching: false, caseConflict: false },
        { left: undefined, right: "File.md", version: 1, matching: false, caseConflict: false },
        { left: undefined, right: undefined, version: 0, matching: false, caseConflict: false },
    ])("compares $left and $right using normalisation $version", ({ left, right, version, matching, caseConflict }) => {
        expect(haveMatchingRevisionPaths(left, right, version)).toBe(matching);
        expect(hasFilenameCaseConflict(left, right, version)).toBe(caseConflict);
    });
});
