import type { ObsidianLiveSyncSettings } from "./setting.type";

export const LEVEL_ADVANCED = "ADVANCED";
export const LEVEL_POWER_USER = "POWER_USER";
export const LEVEL_EDGE_CASE = "EDGE_CASE";
export type ConfigLevel = "" | "ADVANCED" | "POWER_USER" | "EDGE_CASE";
export type ConfigurationItem = {
    name: string;
    desc?: string;
    placeHolder?: string;
    status?: "BETA" | "ALPHA" | "EXPERIMENTAL";
    obsolete?: boolean;
    level?: ConfigLevel;
    isHidden?: boolean;
    isAdvanced?: boolean;
};

export const configurationNames: Partial<Record<keyof ObsidianLiveSyncSettings, ConfigurationItem>> = {
    minimumChunkSize: {
        name: "Minimum Chunk Size (Not Configurable from the UI Now).",
    },
    longLineThreshold: {
        name: "Longest chunk line threshold value (Not Configurable from the UI Now).",
    },
    encrypt: {
        name: "End-to-End Encryption",
        desc: "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.",
    },
    usePathObfuscation: {
        name: "Property Encryption",
        desc: "If enabled, the file properties will be encrypted in the remote database. This is useful for protecting sensitive information in file paths, sizes, and IDs of its chunks. If you are using V1 E2EE, this only obfuscates the file path.",
    },
    enableCompression: {
        name: "Data Compression",
        status: "EXPERIMENTAL",
    },
    useEden: {
        name: "Incubate Chunks in Document",
        desc: "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
        status: "BETA",
    },
    customChunkSize: {
        name: "Enhance chunk size",
    },
    useDynamicIterationCount: {
        name: "Use dynamic iteration count",
        status: "EXPERIMENTAL",
    },
    hashAlg: {
        name: "The Hash algorithm for chunk IDs",
        status: "EXPERIMENTAL",
    },
    enableChunkSplitterV2: {
        name: "Use splitting-limit-capped chunk splitter",
        desc: "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
    },
    maxChunksInEden: {
        name: "Maximum Incubating Chunks",
        desc: "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.",
    },
    maxTotalLengthInEden: {
        name: "Maximum Incubating Chunk Size",
        desc: "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.",
    },
    maxAgeInEden: {
        name: "Maximum Incubation Period",
        desc: "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.",
    },
    usePluginSyncV2: {
        name: "Per-file-saved customization sync",
        desc: "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
    },
    handleFilenameCaseSensitive: {
        name: "Handle files as Case-Sensitive",
        desc: "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
    },
    doNotUseFixedRevisionForChunks: {
        name: "Compute revisions for chunks (Previous behaviour)",
        desc: "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)",
    },
    useSegmenter: {
        name: "Use Segmented-splitter",
        desc: "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
    },
    useJWT: {
        name: "Use JWT instead of Basic Authentication",
        desc: "If this enabled, JWT will be used for authentication.",
        isAdvanced: true,
    },
    jwtAlgorithm: {
        name: "JWT Algorithm",
        desc: "The algorithm used for JWT authentication.",
        isAdvanced: true,
    },
    jwtKey: {
        name: "Keypair or pre-shared key",
        desc: "The key (PSK in HSxxx in base64, or private key in ESxxx in PEM) used for JWT authentication.",
        isAdvanced: true,
        isHidden: true,
        // placeHolder:""
    },
    jwtKid: {
        name: "Key ID",
        desc: "The key ID. this should be matched with CouchDB->jwt_keys->ALG:_`kid`.",
        isAdvanced: true,
    },
    jwtExpDuration: {
        name: "Rotation Duration",
        desc: "The Rotation duration of token in minutes. Each generated tokens will be valid only within this duration.",
        isAdvanced: true,
    },
    jwtSub: {
        name: "Subject (whoami)",
        desc: "The subject for JWT authentication. Mostly username.",
        isAdvanced: true,
    },
    bucketCustomHeaders: {
        name: "Custom Headers",
        desc: "Custom headers for requesting the bucket. e.g. `x-custom-header1: value1\n x-custom-header2: value2`",
        placeHolder: "x-custom-header1: value1\n x-custom-header2: value2",
    },
    couchDB_CustomHeaders: {
        name: "Custom Headers",
        desc: "Custom headers for requesting the CouchDB. e.g. `x-custom-header1: value1\n x-custom-header2: value2`",
        placeHolder: "x-custom-header1: value1\n x-custom-header2: value2",
    },
    chunkSplitterVersion: {
        name: "Chunk Splitter",
        desc: "Now we can choose how to split the chunks; V3 is the most efficient. If you have troubled, please make this Default or Legacy.",
    },
    E2EEAlgorithm: {
        name: "End-to-End Encryption Algorithm",
        desc: "Please use V2, V1 is deprecated and will be removed in the future, It was not a very appropriate algorithm. Only for compatibility V1 is kept.",
        isAdvanced: true,
    },
    P2P_AppID: {
        name: "Application ID",
        desc: "The Application ID for P2P connection. This should be same among your devices. Default is 'self-hosted-livesync' and could not be modified from the UI.",
        isAdvanced: true,
    },
    P2P_relays: {
        name: "Signalling Relays",
        desc: "The Nostr relay servers to establish connections for P2P connections. Multiple servers can be separated by commas.",
        placeHolder: "wss://relay1.example.com,wss://relay2.example.com",
    },
    P2P_roomID: {
        name: "Room ID",
        desc: "The Room ID for P2P connection. This should be same among your devices.",
    },
    P2P_passphrase: {
        name: "Passphrase",
        desc: "The Passphrase for P2P connection. This should be same among your devices.",
        isHidden: true,
    },
    P2P_turnServers: {
        name: "TURN Servers",
        desc: "The TURN servers to use for P2P connections. Multiple servers can be separated by commas.",
        placeHolder: "turn:turn1.example.com,turn:turn2.example.com",
    },
    P2P_turnUsername: {
        name: "TURN Username",
        desc: "The username for the TURN servers.",
    },
    P2P_turnCredential: {
        name: "TURN Credential",
        desc: "The credential/password for the TURN servers.",
        isHidden: true,
    },
    useOnlyLocalChunk: {
        name: "Use Only Local Chunks",
        desc: "If enabled, the plugin will not attempt to connect to the remote database even if the chunk was not found locally.",
        isAdvanced: true,
    },
};

/**
 * Get human readable Configuration stability
 * @param status
 * @returns
 */
export function statusDisplay(status?: string): string {
    if (!status) return "";
    if (status == "EXPERIMENTAL") return ` (Experimental)`;
    if (status == "ALPHA") return ` (Alpha)`;
    if (status == "BETA") return ` (Beta)`;
    return ` (${status})`;
}

/**
 * Get human readable configuration name.
 * @param key configuration key
 * @param alt
 * @returns
 */
export function confName(key: keyof ObsidianLiveSyncSettings, alt: string = "") {
    if (key in configurationNames) {
        return `${configurationNames[key]?.name}${statusDisplay(configurationNames[key]?.status)}`;
    } else {
        return `${alt || ""}`;
    }
}

/**
 * Get human readable configuration description.
 * @param key configuration key
 * @param alt
 * @returns
 */
export function confDesc(key: keyof ObsidianLiveSyncSettings, alt?: string) {
    if (key in configurationNames) {
        if (configurationNames[key]?.desc) {
            return `${configurationNames[key]?.name}${statusDisplay(configurationNames[key]?.status)}`;
        }
        return alt;
    } else {
        return alt;
    }
}
