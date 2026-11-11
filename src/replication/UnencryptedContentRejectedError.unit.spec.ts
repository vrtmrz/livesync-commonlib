import { describe, expect, it } from "vitest";
import {
    UnencryptedContentRejectedError,
    getUnencryptedContentRejection,
    isUnencryptedContentRejectedError,
} from "./UnencryptedContentRejectedError.ts";

describe("UnencryptedContentRejectedError", () => {
    it("exposes safe document details and survives nested structural wrappers", () => {
        const rejection = new UnencryptedContentRejectedError("h:+private-id" as never, "chunk");
        const wrapped = {
            name: "PouchError",
            cause: {
                name: rejection.name,
                code: rejection.code,
                documentId: rejection.documentId,
                contentKind: rejection.contentKind,
            },
        };

        expect(isUnencryptedContentRejectedError(wrapped)).toBe(true);
        expect(getUnencryptedContentRejection(wrapped)).toEqual({
            documentId: "h:+private-id",
            contentKind: "chunk",
        });
    });

    it("recognises copied rejection codes even when PouchDB drops details", () => {
        const wrapped = { name: "PouchError", code: "UNENCRYPTED_CONTENT_REJECTED" };

        expect(isUnencryptedContentRejectedError(wrapped)).toBe(true);
        expect(getUnencryptedContentRejection(wrapped)).toBeUndefined();
    });

    it("handles cyclic causes without losing the rejection", () => {
        const wrapped: { name: string; cause?: unknown } = { name: "UnencryptedContentRejectedError" };
        wrapped.cause = wrapped;

        expect(isUnencryptedContentRejectedError(wrapped)).toBe(true);
        expect(getUnencryptedContentRejection(wrapped)).toBeUndefined();
    });
});
