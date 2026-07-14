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

import type { FilePath } from "@lib/common/types";
import { isAccepted, path2id_base } from "./path";

describe("path2id_base path case", () => {
    it("maps case variants to one document ID in case-insensitive mode", async () => {
        const upperCasePath = await path2id_base("Calculus.md" as FilePath, false, true);
        const lowerCasePath = await path2id_base("calculus.md" as FilePath, false, true);

        expect(upperCasePath).toBe(lowerCasePath);
    });

    it("keeps case variants separate in case-sensitive mode", async () => {
        const upperCasePath = await path2id_base("Calculus.md" as FilePath, false, false);
        const lowerCasePath = await path2id_base("calculus.md" as FilePath, false, false);

        expect(upperCasePath).not.toBe(lowerCasePath);
    });
});

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
