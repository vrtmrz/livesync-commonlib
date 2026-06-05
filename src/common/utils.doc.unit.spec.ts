import { describe, expect, it } from "vitest";
import { isNotFoundError } from "./utils.doc";

describe("isNotFoundError", () => {
    it("returns true when status is 404", () => {
        expect(isNotFoundError({ status: 404 })).toBe(true);
    });

    it("returns true when status is 404 with additional properties", () => {
        expect(isNotFoundError({ status: 404, error: "not_found" })).toBe(true);
    });

    it("returns false when status is not 404", () => {
        expect(isNotFoundError({ status: 500 })).toBe(false);
    });

    it("returns false when status is missing", () => {
        expect(isNotFoundError({ name: "error" })).toBe(false);
    });

    it("returns false when status is not a number", () => {
        expect(isNotFoundError({ status: "404" })).toBe(false);
    });

    it("throws for null", () => {
        expect(() => isNotFoundError(null)).toThrow();
    });

    it("throws for non-object values", () => {
        expect(() => isNotFoundError(undefined)).toThrow();
        expect(() => isNotFoundError("error")).toThrow();
        expect(() => isNotFoundError(404)).toThrow();
        expect(() => isNotFoundError(true)).toThrow();
    });
});
