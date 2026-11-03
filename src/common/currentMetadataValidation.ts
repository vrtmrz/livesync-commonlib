import type { InvalidField, ValidationInspection } from "./documentValidation";

/**
 * Raw current-format Metadata fields before identity or path codecs.
 * Deletion markers describe the body; this shape does not establish a live file.
 */
export interface RawCurrentFileMetadata {
    _id: string;
    path: string;
    type: "plain" | "newnote";
    ctime: number;
    mtime: number;
    size: number;
    children: string[];
    eden: Record<string, { data: string; epoch: number }>;
    _rev?: string;
    _deleted?: boolean;
    deleted?: boolean;
    _conflicts?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectStringField(
    object: Record<string, unknown>,
    field: string,
    invalidFields: InvalidField[],
    issueField = field
): void {
    if (!(field in object)) {
        invalidFields.push({ field: issueField, reason: "missing" });
    } else if (typeof object[field] !== "string") {
        invalidFields.push({ field: issueField, reason: "not_string" });
    }
}

function inspectNumberField(
    object: Record<string, unknown>,
    field: string,
    invalidFields: InvalidField[],
    minimum?: number,
    issueField = field
): void {
    if (!(field in object)) {
        invalidFields.push({ field: issueField, reason: "missing" });
        return;
    }

    const number = object[field];
    if (typeof number !== "number") {
        invalidFields.push({ field: issueField, reason: "not_number" });
    } else if (!Number.isFinite(number) || (minimum !== undefined && number < minimum)) {
        invalidFields.push({ field: issueField, reason: "invalid_value" });
    }
}

function inspectBooleanField(object: Record<string, unknown>, field: string, invalidFields: InvalidField[]): void {
    if (field in object && typeof object[field] !== "boolean") invalidFields.push({ field, reason: "not_boolean" });
}

function inspectStringArrayField(
    object: Record<string, unknown>,
    field: string,
    invalidFields: InvalidField[],
    required: boolean
): void {
    if (!(field in object)) {
        if (required) invalidFields.push({ field, reason: "missing" });
        return;
    }

    const value = object[field];
    if (!Array.isArray(value)) {
        invalidFields.push({ field, reason: "not_array" });
        return;
    }
    for (const [index, item] of value.entries()) {
        if (typeof item !== "string") invalidFields.push({ field: `${field}[${index}]`, reason: "not_string" });
    }
}

function inspectEden(object: Record<string, unknown>, invalidFields: InvalidField[]): void {
    if (!("eden" in object)) {
        invalidFields.push({ field: "eden", reason: "missing" });
        return;
    }

    const eden = object.eden;
    if (!isRecord(eden)) {
        invalidFields.push({ field: "eden", reason: "not_object" });
        return;
    }

    for (const chunk of Object.values(eden)) {
        if (!isRecord(chunk)) {
            invalidFields.push({ field: "eden.*", reason: "not_object" });
            continue;
        }
        inspectStringField(chunk, "data", invalidFields, "eden.*.data");
        inspectNumberField(chunk, "epoch", invalidFields, undefined, "eden.*.epoch");
    }
}

function inspectOptionalStringField(
    object: Record<string, unknown>,
    field: string,
    invalidFields: InvalidField[]
): void {
    if (field in object) inspectStringField(object, field, invalidFields);
}

function inspectCurrentFileMetadata(value: unknown): ValidationInspection<RawCurrentFileMetadata> {
    if (!isRecord(value)) return { ok: false, invalidFields: [{ field: "value", reason: "not_object" }] };

    const invalidFields: InvalidField[] = [];
    inspectStringField(value, "_id", invalidFields);
    inspectStringField(value, "path", invalidFields);

    if (!("type" in value)) {
        invalidFields.push({ field: "type", reason: "missing" });
    } else if (value.type !== "plain" && value.type !== "newnote") {
        invalidFields.push({ field: "type", reason: typeof value.type === "string" ? "invalid_value" : "not_string" });
    }

    inspectNumberField(value, "ctime", invalidFields);
    inspectNumberField(value, "mtime", invalidFields);
    inspectNumberField(value, "size", invalidFields, 0);
    inspectStringArrayField(value, "children", invalidFields, true);
    inspectEden(value, invalidFields);

    inspectOptionalStringField(value, "_rev", invalidFields);
    inspectBooleanField(value, "_deleted", invalidFields);
    inspectBooleanField(value, "deleted", invalidFields);
    inspectStringArrayField(value, "_conflicts", invalidFields, false);

    return invalidFields.length > 0
        ? { ok: false, invalidFields }
        : { ok: true, value: value as unknown as RawCurrentFileMetadata };
}

/** Inspect the current Metadata shape without decoding or mutating its fields. */
export function inspectRawCurrentFileMetadata(value: unknown): ValidationInspection<RawCurrentFileMetadata> {
    return inspectCurrentFileMetadata(value);
}

/** Test current Metadata fields without asserting identity, decoding, or persistence. */
export function isRawCurrentFileMetadata(value: unknown): value is RawCurrentFileMetadata {
    return inspectRawCurrentFileMetadata(value).ok;
}

/** Require the current Metadata shape, throwing TypeError when fields are invalid. */
export function assertRawCurrentFileMetadata(value: unknown): asserts value is RawCurrentFileMetadata {
    const inspection = inspectRawCurrentFileMetadata(value);
    if (inspection.ok === true) return;
    const fields = inspection.invalidFields.map(({ field, reason }) => `${field} (${reason})`).join(", ");
    throw new TypeError(`Invalid RawCurrentFileMetadata: ${fields}`);
}
