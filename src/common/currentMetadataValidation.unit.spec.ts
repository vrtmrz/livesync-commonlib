import { describe, expect, it } from "vitest";
import {
    assertRawCurrentFileMetadata,
    inspectRawCurrentFileMetadata,
    isRawCurrentFileMetadata,
} from "./currentMetadataValidation";

function currentMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        _id: "opaque-id",
        path: "notes/empty.md",
        type: "plain",
        ctime: 10,
        mtime: 20,
        size: 0,
        children: [],
        eden: {},
        ...overrides,
    };
}

describe("RawCurrentFileMetadata validation", () => {
    it("accepts a valid empty file and preserves its identity", () => {
        const metadata = currentMetadata();
        const result = inspectRawCurrentFileMetadata(metadata);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected current Metadata to be valid");
        expect(result.value).toBe(metadata);
        expect(isRawCurrentFileMetadata(metadata)).toBe(true);
        expect(() => assertRawCurrentFileMetadata(metadata)).not.toThrow();
    });

    it.each(["plain", "newnote"])("inspects a complete deleted %s body without claiming it is live", (type) => {
        const metadata = currentMetadata({ type, _rev: "3-deleted", _deleted: true });
        const result = inspectRawCurrentFileMetadata(metadata);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected current-format Metadata shape");
        expect(result.value).toBe(metadata);
        expect(result.value._deleted).toBe(true);
        expect(isRawCurrentFileMetadata(metadata)).toBe(true);
        expect(() => assertRawCurrentFileMetadata(metadata)).not.toThrow();
    });

    it("does not mistake a body-less tombstone for a complete Metadata shape", () => {
        const result = inspectRawCurrentFileMetadata({ _id: "opaque-id", _rev: "3-deleted", _deleted: true });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected missing file fields");
        expect(result.invalidFields.map(({ field }) => field)).toEqual([
            "path",
            "type",
            "ctime",
            "mtime",
            "size",
            "children",
            "eden",
        ]);
    });

    it("accepts repeated, ordered children and content-bearing information views", () => {
        const metadata = currentMetadata({
            children: ["chunk-b", "chunk-a", "chunk-b"],
            data: "materialised content",
            datatype: "newnote",
        });
        const result = inspectRawCurrentFileMetadata(metadata);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Expected current Metadata to be valid");
        expect(result.value).toBe(metadata);
        expect(result.value.children).toEqual(["chunk-b", "chunk-a", "chunk-b"]);
        expect(result.value).toHaveProperty("data", "materialised content");
    });

    it.each(["notes", "chunkpack", "unknown"])("rejects non-current document type %s", (type) => {
        const result = inspectRawCurrentFileMetadata(currentMetadata({ type }));

        expect(result).toEqual({
            ok: false,
            invalidFields: [{ field: "type", reason: "invalid_value" }],
        });
    });

    it("does not treat a partial raw encrypted representation as current Metadata", () => {
        const encrypted = {
            _id: "f:opaque-id",
            _rev: "1-revision",
            type: "plain",
            path: "/\\:ciphertext",
            children: [],
            e_: true,
        };
        const result = inspectRawCurrentFileMetadata(encrypted);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected the undecoded representation to be invalid");
        expect(result.invalidFields.map(({ field }) => field)).toEqual(["ctime", "mtime", "size", "eden"]);
    });

    it.each(["_id", "path", "type", "ctime", "mtime", "size", "children", "eden"])("requires %s", (field) => {
        const metadata = currentMetadata();
        delete metadata[field];
        const result = inspectRawCurrentFileMetadata(metadata);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error(`Expected ${field} to be required`);
        expect(result.invalidFields).toContainEqual({ field, reason: "missing" });
    });

    it.each([undefined, null, false, 1, "metadata", [], ["metadata"]])("rejects non-object input: %s", (input) => {
        expect(isRawCurrentFileMetadata(input)).toBe(false);
        expect(inspectRawCurrentFileMetadata(input)).toEqual({
            ok: false,
            invalidFields: [{ field: "value", reason: "not_object" }],
        });
        expect(() => assertRawCurrentFileMetadata(input)).toThrow(TypeError);
    });

    it.each([
        ["ctime", NaN, "invalid_value"],
        ["mtime", Infinity, "invalid_value"],
        ["size", -1, "invalid_value"],
        ["size", "1", "not_number"],
        ["children", "chunk-a", "not_array"],
        ["children", ["chunk-a", 7], "not_string"],
        ["eden", null, "not_object"],
        ["eden", [], "not_object"],
        ["eden", { "private-eden-id": { data: 7, epoch: 2 } }, "not_string"],
        ["eden", { "private-eden-id": { data: "value", epoch: Infinity } }, "invalid_value"],
        ["eden", { "private-eden-id": { data: "value" } }, "missing"],
        ["_rev", 3, "not_string"],
        ["_deleted", "true", "not_boolean"],
        ["deleted", 1, "not_boolean"],
        ["_conflicts", "revision", "not_array"],
        ["_conflicts", ["revision", 2], "not_string"],
    ] as const)("rejects malformed %s values", (field, value, reason) => {
        const result = inspectRawCurrentFileMetadata(currentMetadata({ [field]: value }));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error(`Expected ${field} to be invalid`);
        expect(result.invalidFields.some((issue) => issue.field.startsWith(field) && issue.reason === reason)).toBe(
            true
        );
        expect(isRawCurrentFileMetadata(currentMetadata({ [field]: value }))).toBe(false);
        expect(() => assertRawCurrentFileMetadata(currentMetadata({ [field]: value }))).toThrow(TypeError);
    });

    it("reports missing and malformed Eden entries without exposing Eden IDs or values", () => {
        const edenId = "private-eden-document-id";
        const content = "private-eden-content";
        const metadata = currentMetadata({ eden: { [edenId]: { data: content, epoch: "bad" } } });
        const result = inspectRawCurrentFileMetadata(metadata);

        expect(result).toEqual({
            ok: false,
            invalidFields: [{ field: "eden.*.epoch", reason: "not_number" }],
        });
        expect(JSON.stringify(result)).not.toContain(edenId);
        expect(JSON.stringify(result)).not.toContain(content);
        try {
            assertRawCurrentFileMetadata(metadata);
            throw new Error("Expected the assertion to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).not.toContain(edenId);
            expect((error as Error).message).not.toContain(content);
        }
    });
});
