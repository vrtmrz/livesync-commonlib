import { describe, expect, it } from "vitest";

import { AdaptiveJournalError } from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveBatchOperationV1,
    decodeBatchRequestV1,
    decodeBatchResponseV1,
    encodeBatchRequestV1,
    encodeBatchResponseV1,
} from "./AdaptiveJournalBatch.ts";

function key(value: number): Uint8Array {
    return new Uint8Array(32).fill(value);
}

function frame(value: number, length = 7): Uint8Array {
    return new Uint8Array(length).fill(value);
}

describe("BatchEnvelopeV1", () => {
    it("round-trips ordered HAS, GET, and PUT requests", () => {
        const has = encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ key: key(1) }, { key: key(2) }],
        });
        expect(decodeBatchRequestV1(has)).toEqual({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ key: key(1) }, { key: key(2) }],
        });

        const get = encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [{ key: key(3) }, { key: key(4) }],
        });
        expect(decodeBatchRequestV1(get)).toEqual({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [{ key: key(3) }, { key: key(4) }],
        });

        const put = encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [
                { key: key(5), frame: frame(0x51), frameDigest: key(0xa1) },
                { key: key(6), frame: frame(0x61, 11), frameDigest: key(0xa2) },
            ],
        });
        expect(decodeBatchRequestV1(put)).toEqual({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [
                { key: key(5), frame: frame(0x51), frameDigest: key(0xa1) },
                { key: key(6), frame: frame(0x61, 11), frameDigest: key(0xa2) },
            ],
        });
    });

    it("round-trips ordered per-entry response statuses", () => {
        const has = encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ status: "missing" }, { status: "present" }],
        });
        expect(decodeBatchResponseV1(has)).toEqual({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ status: "missing" }, { status: "present" }],
        });

        const get = encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [
                { status: "missing" },
                { status: "found", frame: frame(0x22), frameDigest: key(0x33) },
            ],
        });
        expect(decodeBatchResponseV1(get)).toEqual({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [
                { status: "missing" },
                { status: "found", frame: frame(0x22), frameDigest: key(0x33) },
            ],
        });

        const put = encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [
                { status: "inserted" },
                { status: "exact-existing" },
                { status: "validate-existing" },
            ],
        });
        expect(decodeBatchResponseV1(put)).toEqual({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [
                { status: "inserted" },
                { status: "exact-existing" },
                { status: "validate-existing" },
            ],
        });
    });

    it("rejects malformed lengths, response flags, and configured limits", () => {
        const encoded = encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ key: key(1) }, { key: key(2) }],
        });
        const truncated = encoded.slice(0, -1);
        expect(() => decodeBatchRequestV1(truncated)).toThrowError(
            expect.objectContaining<Partial<AdaptiveJournalError>>({ code: "invalid-batch-envelope" })
        );

        const responseFlag = encoded.slice();
        responseFlag[7] = 1;
        expect(() => decodeBatchRequestV1(responseFlag)).toThrowError(
            expect.objectContaining<Partial<AdaptiveJournalError>>({ code: "unexpected-batch-direction" })
        );
        expect(() => decodeBatchRequestV1(encoded, { maxEntries: 1 })).toThrowError(
            expect.objectContaining<Partial<AdaptiveJournalError>>({ code: "batch-limit-exceeded" })
        );
        expect(() => decodeBatchRequestV1(encoded, { maxBytes: encoded.byteLength - 1 })).toThrowError(
            expect.objectContaining<Partial<AdaptiveJournalError>>({ code: "batch-limit-exceeded" })
        );
    });
});
