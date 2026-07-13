import { beforeEach, describe, expect, it, vi } from "vitest";

const minimatchStats = vi.hoisted(() => ({ constructions: 0 }));

vi.mock("minimatch", async (importOriginal) => {
    const actual = await importOriginal<typeof import("minimatch")>();

    class CountingMinimatch extends actual.Minimatch {
        constructor(pattern: string, options?: import("minimatch").MinimatchOptions) {
            super(pattern, options);
            minimatchStats.constructions++;
        }
    }

    return {
        ...actual,
        Minimatch: CountingMinimatch,
        minimatch: (path: string, pattern: string, options?: import("minimatch").MinimatchOptions) =>
            new CountingMinimatch(pattern, options).match(path),
    };
});

import { isAccepted } from "./path";

describe("isAccepted", () => {
    beforeEach(() => {
        minimatchStats.constructions = 0;
    });

    it("reuses compiled matchers for the same ignore list", () => {
        const ignore = ["*.tmp"];

        expect(isAccepted("a.md", ignore)).toBeUndefined();
        expect(isAccepted("a.tmp", ignore)).toBe(false);
        expect(isAccepted("b.md", ignore)).toBeUndefined();
        expect(isAccepted("b.tmp", ignore)).toBe(false);

        expect(minimatchStats.constructions).toBe(2);
    });
});
