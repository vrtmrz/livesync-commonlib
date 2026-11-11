import { describe, expect, it } from "vitest";
import { normaliseAcceptUnencryptedContent } from "./setting.encryption";

describe("normaliseAcceptUnencryptedContent", () => {
    it.each([
        [true, true],
        [false, false],
        [undefined, false],
        [null, false],
        ["true", false],
        [1, false],
    ])("accepts only true (%s)", (value, expected) => {
        expect(normaliseAcceptUnencryptedContent(value)).toBe(expected);
    });
});
