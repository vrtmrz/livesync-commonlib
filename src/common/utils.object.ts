import { LiveSyncError } from "./LSError";
import { cloneViaJSON, type JsonCompatible } from "octagonal-wheels/encoding/json";

export function asCopy<T>(obj: T): T {
    // The legacy entry accepts arbitrary inputs and retains native JSON behaviour.
    return cloneViaJSON<T>(obj as T & JsonCompatible<T>);
}

export function ensureError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return LiveSyncError.fromError(error);
}
