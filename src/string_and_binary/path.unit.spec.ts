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
    };
});

import { isAccepted } from "./path";

describe("isAccepted matcher cache", () => {
    beforeEach(() => {
        minimatchStats.constructions = 0;
    });

    it("reuses compiled matchers for the same ignore array", () => {
        const ignore = ["*.tmp"];

        expect(isAccepted("scratch.tmp", ignore)).toBe(false);
        expect(isAccepted("other.tmp", ignore)).toBe(false);

        expect(minimatchStats.constructions).toBe(1);
    });

    it("compiles new matchers when the ignore array is replaced", () => {
        const original = ["*.tmp"];
        const replacement = ["*.tmp"];

        expect(isAccepted("scratch.tmp", original)).toBe(false);
        expect(isAccepted("scratch.tmp", replacement)).toBe(false);

        expect(minimatchStats.constructions).toBe(2);
    });
});
