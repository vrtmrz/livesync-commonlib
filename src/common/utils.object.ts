import { LiveSyncError } from "./LSError";
import { cloneViaJSON } from "octagonal-wheels/encoding/json";

export function asCopy<T>(obj: T): T {
    return cloneViaJSON(obj) as T;
}

export function ensureError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return LiveSyncError.fromError(error);
}
