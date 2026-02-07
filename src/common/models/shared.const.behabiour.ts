// docs should be encoded as base64, so 1 char -> 1 bytes
// and cloudant limitation is 1MB , we use 900kb;

export const MAX_DOC_SIZE = 1000; // for .md file, but if delimiters exists. use that before.
export const MAX_DOC_SIZE_BIN = 102400; // 100kb
export const VER = 12; // 12 Since 0.25.0, HKDF is used for encryption, so the version is changed to 12.

export const RECENT_MODIFIED_DOCS_QTY = 30;
export const LEAF_WAIT_TIMEOUT = 30000; // in synchronization, waiting missing leaf time out.
export const LEAF_WAIT_ONLY_REMOTE = 5000;
export const LEAF_WAIT_TIMEOUT_SEQUENTIAL_REPLICATOR = 5000;
export const REPLICATION_BUSY_TIMEOUT = 3000000;

export const SALT_OF_PASSPHRASE = "rHGMPtr6oWw7VSa3W3wpa8fT8U";
export const SALT_OF_ID = "a83hrf7f\u0003y7sa8g31";
export const SEED_MURMURHASH = 0x12345678;

export const IDPrefixes = {
    Obfuscated: "f:",
    Chunk: "h:",
    EncryptedChunk: "h:+",
};
/**
 * @deprecated Use `IDPrefixes.Obfuscated` instead.
 */
export const PREFIX_OBFUSCATED = "f:";
/**
 * @deprecated Use `IDPrefixes.Chunk` instead.
 */
export const PREFIX_CHUNK = "h:";
/**
 * @deprecated Use `IDPrefixes.EncryptedChunk` instead.
 */
export const PREFIX_ENCRYPTED_CHUNK = "h:+";
