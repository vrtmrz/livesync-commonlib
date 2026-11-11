import {
    type AnyEntry,
    type EntryLeaf,
    type DatabaseEntry,
    type DocumentID,
    type E2EEAlgorithm,
    E2EEAlgorithms,
    EntryTypes,
    DOCID_SYNC_PARAMETERS,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    SYNCINFO_ID,
    VERSIONING_DOCID,
    IDPrefixes,
} from "@lib/common/types";
import { isEncryptedChunkEntry, isSyncInfoEntry, isObfuscatedEntry } from "@lib/common/utils";
import {
    UnencryptedContentRejectedError,
    type UnencryptedContentKind,
} from "@lib/replication/UnencryptedContentRejectedError.ts";
import {
    ENCRYPT_V1_PREFIX_PROBABLY,
    ENCRYPT_V2_PREFIX,
    ENCRYPT_V3_PREFIX,
} from "octagonal-wheels/encryption/encryption";
import { EDEN_ENCRYPTED_KEY, EDEN_ENCRYPTED_KEY_HKDF, shouldDecryptEden } from "./encryption.eden.ts";

const METADATA_ONLY_ENTRY_TYPES = new Set<string>([
    EntryTypes.NOTE_BINARY,
    EntryTypes.NOTE_PLAIN,
    EntryTypes.INTERNAL_FILE,
]);
const ENCRYPTED_EDEN_KEYS = new Set([EDEN_ENCRYPTED_KEY, EDEN_ENCRYPTED_KEY_HKDF]);
const CONTROL_DOCUMENT_TYPES = new Map<string, string>([
    [DOCID_SYNC_PARAMETERS, EntryTypes.SYNC_PARAMETERS],
    [MILESTONE_DOCID, EntryTypes.MILESTONE_INFO],
    [NODEINFO_DOCID, EntryTypes.NODE_INFO],
    [SYNCINFO_ID, EntryTypes.SYNC_INFO],
    [VERSIONING_DOCID, EntryTypes.VERSION_INFO],
]);

function hasReadableBody(value: unknown): boolean {
    // Legacy text readers pass JSON values to Blob, which also converts non-string values.
    // Checking only the declared string/string[] shape would allow plaintext to bypass the guard.
    return value !== undefined;
}

function isEncryptedEdenKey(key: string, algorithm: E2EEAlgorithm): boolean {
    return key === EDEN_ENCRYPTED_KEY || (key === EDEN_ENCRYPTED_KEY_HKDF && algorithm !== E2EEAlgorithms.ForceV1);
}

function hasPlaintextEden(record: Record<string, unknown>, algorithm: E2EEAlgorithm): boolean {
    const eden = record.eden;
    if (typeof eden !== "object" || eden === null) return false;
    const keys = Object.keys(eden);
    return keys.some((key) => !isEncryptedEdenKey(key, algorithm));
}

function hasUnsupportedEncryptedEden(record: Record<string, unknown>, algorithm: E2EEAlgorithm): boolean {
    const eden = record.eden;
    if (typeof eden !== "object" || eden === null) return false;
    return Object.keys(eden).some(
        (key) => ENCRYPTED_EDEN_KEYS.has(key as DocumentID) && !isEncryptedEdenKey(key, algorithm)
    );
}

function getUnencryptedContentKinds(doc: AnyEntry | EntryLeaf, algorithm: E2EEAlgorithm): UnencryptedContentKind[] {
    const record = doc as unknown as Record<string, unknown>;
    const documentId = typeof record._id === "string" ? record._id : "";
    const type = record.type;
    if (record._deleted === true || documentId.startsWith("_local/")) return [];

    // Chunk IDs are consumed by the chunk fetch path even if a remote forges a
    // Metadata or control type. A control ID is exempt only with its real type.
    const isChunkId = documentId.startsWith(IDPrefixes.Chunk);
    const expectedControlType = CONTROL_DOCUMENT_TYPES.get(documentId);
    const isControlDocument = expectedControlType !== undefined && expectedControlType === type;
    if (!isChunkId && isControlDocument) return [];

    const isChunkBody = isChunkId || type === EntryTypes.CHUNK || type === EntryTypes.CHUNK_PACK;
    if (!isChunkBody && METADATA_ONLY_ENTRY_TYPES.has(type as string) && record.deleted === true) return [];

    const kinds: UnencryptedContentKind[] = [];
    if (hasPlaintextEden(record, algorithm)) kinds.push("eden");
    if (hasReadableBody(record.data)) kinds.push(isChunkBody ? "chunk" : "inline-note");
    return kinds;
}

function isBase64Payload(value: string): boolean {
    return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function hasForceV1CiphertextHeaderFor(data: unknown): boolean {
    if (typeof data !== "string") return false;

    // The current V1 writer emits a flat '%'-prefixed payload. V3 uses a
    // twelve-byte IV; the older format uses a sixteen-byte IV and salt.
    if (data.startsWith(ENCRYPT_V3_PREFIX)) {
        return /^[0-9a-f]{24}$/i.test(data.slice(2, 26)) && isBase64Payload(data.slice(26));
    }
    if (data.startsWith(ENCRYPT_V2_PREFIX)) {
        return /^[0-9a-f]{64}$/i.test(data.slice(1, 65)) && isBase64Payload(data.slice(65));
    }

    // An older V1 writer emitted [ciphertext, IV, salt] as a JSON array.
    // Validate the complete shape so an ordinary JSON array is not mistaken
    // for ciphertext merely because it starts with '['.
    if (!data.startsWith(ENCRYPT_V1_PREFIX_PROBABLY) || !data.endsWith("]")) return false;
    try {
        const parsed: unknown = JSON.parse(data);
        if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string")) {
            return false;
        }
        const [ciphertext, iv, salt] = parsed as [string, string, string];
        return isBase64Payload(ciphertext) && /^[0-9a-f]{32}$/i.test(iv) && /^[0-9a-f]{32}$/i.test(salt);
    } catch {
        return false;
    }
}

export function assertUnencryptedContentPolicy(
    doc: AnyEntry | EntryLeaf,
    algorithm: E2EEAlgorithm,
    acceptUnencryptedContent: boolean,
    hasForceV1CiphertextHeader = false
): void {
    const contentKinds = getUnencryptedContentKinds(doc, algorithm);
    if (contentKinds.length === 0) return;

    const record = doc as unknown as Record<string, unknown>;
    if (hasUnsupportedEncryptedEden(record, algorithm)) {
        throw new Error("Encrypted Eden uses a representation which this E2EE reader cannot decrypt.");
    }
    const dataIsHandledByExistingDecryptor =
        isEncryptedChunkEntry(doc as DatabaseEntry) || isSyncInfoEntry(doc as DatabaseEntry);
    const forceV1DecryptsMarkedData =
        algorithm === E2EEAlgorithms.ForceV1 &&
        (dataIsHandledByExistingDecryptor || isObfuscatedEntry(doc as DatabaseEntry) || shouldDecryptEden(doc));
    for (const contentKind of contentKinds) {
        if (contentKind !== "eden" && record.e_ === true) {
            if (forceV1DecryptsMarkedData || dataIsHandledByExistingDecryptor) continue;
            throw new Error("Encrypted file content uses a representation which this E2EE reader cannot decrypt.");
        }
        if (
            contentKind === "chunk" &&
            algorithm === E2EEAlgorithms.ForceV1 &&
            !record.e_ &&
            isEncryptedChunkEntry(doc as DatabaseEntry) &&
            hasForceV1CiphertextHeader
        ) {
            continue;
        }
        if (!acceptUnencryptedContent) throw new UnencryptedContentRejectedError(doc._id, contentKind);
    }
}

type EncryptedEntry = (AnyEntry | EntryLeaf) & { data: string };

/** Identify a body handled by the V1 decryptor; authentication remains with the decryptor. */
export function isEncryptedEntry(
    doc: AnyEntry | EntryLeaf,
    hasForceV1CiphertextHeader: boolean
): doc is EncryptedEntry {
    const hasMarkedCiphertext = "e_" in doc && doc.e_ === true;
    const shouldDecryptData =
        isEncryptedChunkEntry(doc) || isSyncInfoEntry(doc)
            ? hasMarkedCiphertext || hasForceV1CiphertextHeader
            : (isObfuscatedEntry(doc) || shouldDecryptEden(doc)) && hasMarkedCiphertext;
    if (!shouldDecryptData) return false;
    // A malformed encrypted body must fail, never fall through as accepted plaintext.
    if (!("data" in doc) || typeof doc.data !== "string") {
        throw new TypeError("Encrypted file content must be a string.");
    }
    return true;
}
