import { describe, expect, it } from "vitest";
import {
    assertFetchedChunkPayload,
    assertRawRevisionRef,
    inspectFetchedChunkPayload,
    inspectRawRevisionRef,
    isFetchedChunkPayload,
    isRawRevisionRef,
} from "./documentValidation";

describe("FetchedChunkPayload validation", () => {
    it.each([undefined, null, false, 1, "payload", [], ["payload"]])("rejects non-object input: %s", (input) => {
        expect(isFetchedChunkPayload(input)).toBe(false);
        expect(inspectFetchedChunkPayload(input)).toEqual({
            ok: false,
            invalidFields: [{ field: "value", reason: "not_object" }],
        });
        expect(() => assertFetchedChunkPayload(input)).toThrow(TypeError);
    });

    it.each([
        [{ data: "payload" }, [{ field: "_id", reason: "missing" }]],
        [{ _id: "chunk-id" }, [{ field: "data", reason: "missing" }]],
        [{ _id: 4, data: "payload" }, [{ field: "_id", reason: "not_string" }]],
        [{ _id: "chunk-id", data: 4 }, [{ field: "data", reason: "not_string" }]],
    ])("reports invalid fields without exposing input contents", (input, invalidFields) => {
        const result = inspectFetchedChunkPayload(input);
        expect(result).toEqual({ ok: false, invalidFields });
        expect(JSON.stringify(result)).not.toContain("payload");
        expect(isFetchedChunkPayload(input)).toBe(false);
        expect(() => assertFetchedChunkPayload(input)).toThrow(TypeError);
    });

    it("accepts empty data, extra fields, and unexpected type values by identity", () => {
        const payload = { _id: "raw-id", data: "", type: "unexpected", extra: true };
        const result = inspectFetchedChunkPayload(payload);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected the payload to be valid");
        expect(result.value).toBe(payload);
        expect(isFetchedChunkPayload(payload)).toBe(true);
        expect(() => assertFetchedChunkPayload(payload)).not.toThrow();
    });
});

describe("RawRevisionRef validation", () => {
    it.each([undefined, null, false, 1, "revision", [], ["revision"]])("rejects non-object input: %s", (input) => {
        expect(isRawRevisionRef(input)).toBe(false);
        expect(inspectRawRevisionRef(input)).toEqual({
            ok: false,
            invalidFields: [{ field: "value", reason: "not_object" }],
        });
        expect(() => assertRawRevisionRef(input)).toThrow(TypeError);
    });

    it.each([
        [{ _rev: "revision" }, [{ field: "_id", reason: "missing" }]],
        [{ _id: "raw-id" }, [{ field: "_rev", reason: "missing" }]],
        [{ _id: 4, _rev: "revision" }, [{ field: "_id", reason: "not_string" }]],
        [{ _id: "raw-id", _rev: 4 }, [{ field: "_rev", reason: "not_string" }]],
    ])("reports invalid fields", (input, invalidFields) => {
        expect(inspectRawRevisionRef(input)).toEqual({ ok: false, invalidFields });
        expect(isRawRevisionRef(input)).toBe(false);
        expect(() => assertRawRevisionRef(input)).toThrow(TypeError);
    });

    it("accepts arbitrary string IDs and revisions by identity", () => {
        const revision = { _id: "unclassified-id", _rev: "opaque-revision", extra: true };
        const result = inspectRawRevisionRef(revision);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected the revision reference to be valid");
        expect(result.value).toBe(revision);
        expect(isRawRevisionRef(revision)).toBe(true);
        expect(() => assertRawRevisionRef(revision)).not.toThrow();
    });
});
