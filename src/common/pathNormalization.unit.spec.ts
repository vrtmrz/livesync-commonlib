import { describe, expect, it } from "vitest";
import {
    assertSupportedPathNormalizationVersion,
    getPathNormalizationVersion,
    normalisePathForIdentity,
} from "./pathNormalization.ts";

describe("path normalisation version validation", () => {
    it.each([undefined, 0, 1])("accepts version %s", (version) => {
        expect(() => assertSupportedPathNormalizationVersion(version)).not.toThrow();
        expect(getPathNormalizationVersion({ pathNormalizationVersion: version })).toBe(version ?? 0);
    });

    it.each([-1, 2, NaN, Infinity, null, "1"])("rejects unsupported stored version %s", (storedVersion) => {
        const version = storedVersion as number;
        const message = `Unsupported path normalisation version: ${version}`;
        expect(() => assertSupportedPathNormalizationVersion(version)).toThrow(message);
        expect(() => getPathNormalizationVersion({ pathNormalizationVersion: version })).toThrow(message);
        expect(() => normalisePathForIdentity("e\u0301.md", version)).toThrow(message);
    });

    it("preserves legacy paths and applies NFC only in version one", () => {
        const path = "e\u0301.md";
        expect(normalisePathForIdentity(path)).toBe(path);
        expect(normalisePathForIdentity(path, 0)).toBe(path);
        expect(normalisePathForIdentity(path, 1)).toBe("é.md");
    });
});
