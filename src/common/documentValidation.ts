import type { FetchedChunkPayload, RawRevisionRef } from "./models/document.type";

export type InvalidFieldReason =
    | "missing"
    | "not_string"
    | "not_number"
    | "not_boolean"
    | "not_array"
    | "invalid_value";

export interface InvalidField {
    field: string;
    reason: InvalidFieldReason | "not_object";
}

export type ValidationInspection<T> = { ok: true; value: T } | { ok: false; invalidFields: InvalidField[] };

type StringField = "_id" | "_rev" | "data";

function inspectStringFields<T extends object>(
    value: unknown,
    fields: readonly StringField[]
): ValidationInspection<T> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, invalidFields: [{ field: "value", reason: "not_object" }] };
    }

    const objectValue = value as Record<string, unknown>;
    const invalidFields: InvalidField[] = [];
    for (const field of fields) {
        if (!(field in objectValue)) {
            invalidFields.push({ field, reason: "missing" });
        } else if (typeof objectValue[field] !== "string") {
            invalidFields.push({ field, reason: "not_string" });
        }
    }

    if (invalidFields.length > 0) return { ok: false, invalidFields };
    return { ok: true, value: value as T };
}

function assertValid<T extends object>(
    inspection: ValidationInspection<T>,
    typeName: string
): asserts inspection is { ok: true; value: T } {
    if (inspection.ok === true) return;
    const fields = inspection.invalidFields.map(({ field, reason }) => `${field} (${reason})`).join(", ");
    throw new TypeError(`Invalid ${typeName}: ${fields}`);
}

/** Inspect only an ID and string content; retain extra fields and input identity. */
export function inspectFetchedChunkPayload(value: unknown): ValidationInspection<FetchedChunkPayload> {
    return inspectStringFields<FetchedChunkPayload>(value, ["_id", "data"]);
}

/** Test the retrieval payload shape without classifying its document type. */
export function isFetchedChunkPayload(value: unknown): value is FetchedChunkPayload {
    return inspectFetchedChunkPayload(value).ok;
}

/** Require the retrieval payload shape, throwing TypeError for invalid fields. */
export function assertFetchedChunkPayload(value: unknown): asserts value is FetchedChunkPayload {
    assertValid(inspectFetchedChunkPayload(value), "FetchedChunkPayload");
}

/** Inspect raw ID and revision strings without proving namespace or ancestry. */
export function inspectRawRevisionRef(value: unknown): ValidationInspection<RawRevisionRef> {
    return inspectStringFields<RawRevisionRef>(value, ["_id", "_rev"]);
}

/** Test raw reference fields without branding or checking revision freshness. */
export function isRawRevisionRef(value: unknown): value is RawRevisionRef {
    return inspectRawRevisionRef(value).ok;
}

/** Require raw reference fields, throwing TypeError for invalid fields. */
export function assertRawRevisionRef(value: unknown): asserts value is RawRevisionRef {
    assertValid(inspectRawRevisionRef(value), "RawRevisionRef");
}
