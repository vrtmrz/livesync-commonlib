// utilities for (CouchDB) documents
// There may be a few redundant or duplicated functions during the migration,
// but for the most part, the code in this file should be correct as things stand.

import type { MetaEntry } from "./models/db.type";

/**
 * Checks if the error is effectively a 404 error from CouchDB or PouchDB.
 * @param ex some error object, expected to be from CouchDB or PouchDB.
 * @returns true if the error is a 404 not found error, false otherwise.
 * @throws if the input is not an object or does not have a numeric "status" property.
 */
export function isNotFoundError(ex: unknown): boolean {
    if (!ex || typeof ex !== "object") {
        throw new Error(`Expected an object error, but got ${typeof ex}`);
    }
    // now ex is an object, only check if it has a numeric "status" property equal to 404 (not strictly check).
    if ("status" in ex && typeof ex.status === "number" && ex.status == 404) {
        return true;
    }
    return false;
}

function isEntryWithPath(entry: unknown): entry is MetaEntry {
    if (!entry || typeof entry !== "object") return false;
    return "path" in entry && typeof entry.path === "string";
}

export function tryGetFilePath(entry: unknown): string | undefined {
    if (isEntryWithPath(entry)) {
        return entry.path;
    }
    return undefined;
}
