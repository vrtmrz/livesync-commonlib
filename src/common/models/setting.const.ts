export const SETTING_VERSION_INITIAL = 0;
export const SETTING_VERSION_SUPPORT_CASE_INSENSITIVE = 10;
export const CURRENT_SETTING_VERSION = SETTING_VERSION_SUPPORT_CASE_INSENSITIVE;

// Remote Type
export const RemoteTypes = {
    REMOTE_COUCHDB: "",
    REMOTE_MINIO: "MINIO",
    REMOTE_P2P: "ONLY_P2P",
} as const;
export const REMOTE_COUCHDB = RemoteTypes.REMOTE_COUCHDB;
export const REMOTE_MINIO = RemoteTypes.REMOTE_MINIO;
//
export const REMOTE_P2P = RemoteTypes.REMOTE_P2P;

export const E2EEAlgorithmNames = {
    "": "V1: Legacy",
    v2: "V2: AES-256-GCM With HKDF",
    forceV1: "Force-V1: Force Legacy (Not recommended)",
} as const;
export const E2EEAlgorithms = {
    V1: "",
    V2: "v2",
    ForceV1: "forceV1",
} as const;

export const HashAlgorithms = {
    XXHASH32: "xxhash32",
    XXHASH64: "xxhash64",
    MIXED_PUREJS: "mixed-purejs",
    SHA1: "sha1",
    LEGACY: "",
} as const;

// Note: xxhash32 is obsolete and not preferred since v0.24.7.
// export type HashAlgorithm = "" | "xxhash32" | "xxhash64" | "mixed-purejs" | "sha1";
export const ChunkAlgorithmNames = {
    v1: "V1: Legacy",
    v2: "V2: Simple (Default)",
    "v2-segmenter": "V2.5: Lexical chunks",
    "v3-rabin-karp": "V3: Fine deduplication",
} as const;
export const ChunkAlgorithms = {
    V1: "v1",
    V2: "v2",
    V2Segmenter: "v2-segmenter",
    RabinKarp: "v3-rabin-karp",
} as const;

// Plugin Sync Settings

export const MODE_SELECTIVE = 0;
export const MODE_AUTOMATIC = 1;
export const MODE_PAUSED = 2;
export const MODE_SHINY = 3;

// Network constants for banner setting
export const NetworkWarningStyles = {
    BANNER: "",
    ICON: "icon",
    HIDDEN: "hidden",
} as const;
