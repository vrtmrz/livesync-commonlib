import { describe, expect, it } from "vitest";
import type { DocumentID, EntryLeaf } from "@lib/common/types.ts";
import { classifyFetchedChunks, decideMissingChunkAction } from "./chunkFetcher.helper.ts";

const firstId = "chunk-1" as DocumentID;
const secondId = "chunk-2" as DocumentID;
const thirdId = "chunk-3" as DocumentID;
const leaf = (id: DocumentID): EntryLeaf => ({ _id: id, type: "leaf", data: `data-${id}` });

describe("decideMissingChunkAction", () => {
    it.each([false, true])("retries the first miss when finite replication is %s", (finiteReplicationActive) => {
        const input = Object.freeze({ missingResponses: 0, finiteReplicationActive, completedDuringRequest: false });

        expect(decideMissingChunkAction(input)).toEqual({ kind: "retry", missingResponses: 1, delayMs: 2_000 });
    });

    it.each([
        [1, 4_000],
        [2, 6_000],
        [3, 8_000],
        [4, 10_000],
        [5, 10_000],
        [42, 10_000],
    ])("backs off after %i misses while finite replication remains active", (missingResponses, delayMs) => {
        expect(
            decideMissingChunkAction({ missingResponses, finiteReplicationActive: true, completedDuringRequest: false })
        ).toEqual({ kind: "retry", missingResponses: missingResponses + 1, delayMs });
    });

    it.each([1, 5, 42])(
        "reports a final miss after %i earlier misses without finite replication",
        (missingResponses) => {
            expect(
                decideMissingChunkAction({
                    missingResponses,
                    finiteReplicationActive: false,
                    completedDuringRequest: false,
                })
            ).toEqual({ kind: "missing" });
        }
    );

    it.each([
        { missingResponses: 0, finiteReplicationActive: false },
        { missingResponses: 0, finiteReplicationActive: true },
        { missingResponses: 1, finiteReplicationActive: false },
        { missingResponses: 1, finiteReplicationActive: true },
        { missingResponses: 9, finiteReplicationActive: false },
        { missingResponses: 9, finiteReplicationActive: true },
    ])("retries a pre-completion result immediately: %j", (input) => {
        expect(decideMissingChunkAction({ ...input, completedDuringRequest: true })).toEqual({
            kind: "retry",
            missingResponses: input.missingResponses + 1,
            delayMs: 0,
        });
    });
});

describe("classifyFetchedChunks", () => {
    it("preserves every valid response in response order", () => {
        const chunks = [leaf(secondId), leaf(firstId), leaf(secondId)];

        const result = classifyFetchedChunks([firstId, secondId], chunks);

        expect(result).toEqual({ chunks, invalidChunks: [], missingIds: [], invalidIds: [] });
        expect(result.chunks[0]).toBe(chunks[0]);
    });

    it("distinguishes omitted identifiers from returned invalid chunks", () => {
        const valid = leaf(firstId);
        const invalid = { _id: secondId };

        expect(classifyFetchedChunks([thirdId, secondId, firstId], [valid, invalid])).toEqual({
            chunks: [valid],
            invalidChunks: [invalid],
            missingIds: [thirdId],
            invalidIds: [secondId],
        });
    });

    it("keeps malformed responses without string identifiers separate from missing identifiers", () => {
        const invalidChunks = [null, undefined, false, 42, "invalid", { _id: 1, data: "data" }, { data: "data" }];

        expect(classifyFetchedChunks([secondId, firstId], invalidChunks)).toEqual({
            chunks: [],
            invalidChunks,
            missingIds: [secondId, firstId],
            invalidIds: [],
        });
    });

    it("classifies a string identifier with non-string data as invalid", () => {
        const invalidChunks = [
            { _id: secondId, data: null },
            { _id: firstId, data: 42 },
        ];

        expect(classifyFetchedChunks([firstId, secondId], invalidChunks)).toEqual({
            chunks: [],
            invalidChunks,
            missingIds: [],
            invalidIds: [firstId, secondId],
        });
    });

    it("accepts the existing identifier-and-data contract without requiring a type field", () => {
        const chunks = [
            { _id: firstId, data: "" },
            { _id: secondId, data: "data", type: "unexpected" },
        ];

        expect(classifyFetchedChunks([firstId, secondId], chunks)).toEqual({
            chunks,
            invalidChunks: [],
            missingIds: [],
            invalidIds: [],
        });
    });

    it("lets a valid duplicate satisfy an identifier while retaining its invalid duplicate for logging", () => {
        const valid = leaf(firstId);
        const invalid = { _id: firstId };

        expect(classifyFetchedChunks([firstId], [invalid, valid])).toEqual({
            chunks: [valid],
            invalidChunks: [invalid],
            missingIds: [],
            invalidIds: [],
        });
    });

    it("retains unrequested chunks for persistence and arrival events", () => {
        const unrequested = leaf(secondId);
        const invalid = { _id: thirdId };

        expect(classifyFetchedChunks([firstId], [unrequested, invalid])).toEqual({
            chunks: [unrequested],
            invalidChunks: [invalid],
            missingIds: [firstId],
            invalidIds: [],
        });
    });

    it("classifies every requested identifier as missing for an empty response", () => {
        expect(classifyFetchedChunks([secondId, firstId], [])).toEqual({
            chunks: [],
            invalidChunks: [],
            missingIds: [secondId, firstId],
            invalidIds: [],
        });
    });

    it("handles empty inputs", () => {
        expect(classifyFetchedChunks([], [])).toEqual({
            chunks: [],
            invalidChunks: [],
            missingIds: [],
            invalidIds: [],
        });
    });

    it("does not mutate the requested identifiers, response array, or response objects", () => {
        const requestedIds = Object.freeze([firstId, secondId, thirdId]);
        const valid = Object.freeze(leaf(secondId));
        const invalid = Object.freeze({ _id: thirdId });
        const fetched = Object.freeze([invalid, valid]);

        expect(classifyFetchedChunks(requestedIds, fetched)).toEqual({
            chunks: [valid],
            invalidChunks: [invalid],
            missingIds: [firstId],
            invalidIds: [thirdId],
        });
        expect(requestedIds).toEqual([firstId, secondId, thirdId]);
        expect(fetched).toEqual([invalid, valid]);
    });
});
