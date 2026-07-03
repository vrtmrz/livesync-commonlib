import { describe, expect, it } from "vitest";
import { isSuccessfulHttpStatus } from "./RemoteService";

describe("isSuccessfulHttpStatus", () => {
    it("treats all 2xx statuses as success", () => {
        expect(isSuccessfulHttpStatus(200)).toBe(true);
        expect(isSuccessfulHttpStatus(201)).toBe(true);
        expect(isSuccessfulHttpStatus(204)).toBe(true);
        expect(isSuccessfulHttpStatus(299)).toBe(true);
    });

    it("rejects non-2xx statuses", () => {
        expect(isSuccessfulHttpStatus(199)).toBe(false);
        expect(isSuccessfulHttpStatus(300)).toBe(false);
        expect(isSuccessfulHttpStatus(404)).toBe(false);
        expect(isSuccessfulHttpStatus(500)).toBe(false);
    });
});
