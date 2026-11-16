import { describe, expect, it } from "vitest";
import type { DocumentID } from "@lib/common/types.ts";
import {
    isTransientContentReadFailure,
    type ChunkReadFailureReason,
    type ContentReadFailure,
} from "./contentRead.ts";

const documentId = "h:content" as DocumentID;

describe("isTransientContentReadFailure", () => {
    it.each(["offline", "transport"] as const)("recognises %s as transient", (reason) => {
        expect(isTransientContentReadFailure({ documentId, reason })).toBe(true);
    });

    it.each([
        "missing",
        "invalid",
        "cancelled",
        "unavailable",
        "authentication",
        "configuration",
    ] as ChunkReadFailureReason[])("keeps %s non-transient", (reason) => {
        expect(isTransientContentReadFailure({ documentId, reason })).toBe(false);
    });

    it("recognises a local database failure as transient", () => {
        const cause = Object.assign(new Error("database context is invalid"), { name: "InvalidStateError" });
        const failure = { documentId, reason: "local-database", cause } as unknown as ContentReadFailure;

        expect(isTransientContentReadFailure(failure)).toBe(true);
    });
});
