/**
 * Eden is being phased out. Avoid proactive refactoring or enhancements;
 * limit changes to necessary fixes and compatibility maintenance.
 */
import type { AnyEntry, EntryLeaf, DocumentID } from "@lib/common/types";

export const EDEN_ENCRYPTED_KEY = "h:++encrypted" as DocumentID;
export const EDEN_ENCRYPTED_KEY_HKDF = "h:++encrypted-hkdf" as DocumentID;

export function shouldEncryptEden(doc: AnyEntry | EntryLeaf): doc is AnyEntry {
    if ("eden" in doc && !(EDEN_ENCRYPTED_KEY in doc.eden)) {
        return true;
    }
    return false;
}
export function shouldEncryptEdenHKDF(doc: AnyEntry | EntryLeaf): doc is AnyEntry {
    if ("eden" in doc && !(EDEN_ENCRYPTED_KEY_HKDF in doc.eden)) {
        if (Object.keys(doc.eden).length === 0) {
            return false; // If eden is empty, do not encrypt.
        }
        return true;
    }
    return false;
}

export function shouldDecryptEden(doc: AnyEntry | EntryLeaf): doc is AnyEntry {
    if ("eden" in doc && EDEN_ENCRYPTED_KEY in doc.eden) {
        return true;
    }
    return false;
}

export function shouldDecryptEdenHKDF(doc: AnyEntry | EntryLeaf): doc is AnyEntry {
    if ("eden" in doc && EDEN_ENCRYPTED_KEY_HKDF in doc.eden) {
        return true;
    }
    return false;
}
