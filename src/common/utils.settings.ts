import type { ObsidianLiveSyncSettings, P2PConnectionInfo, BucketSyncSetting, CouchDBConnection, EncryptionSettings } from "@lib/common/models/setting.type";

/**
 * Copies properties from the source object to the target object only if they exist in the target.
 * @param source The object to copy properties from.
 * @param target The object to copy properties to.
 */
export function copyTo<T extends object, U extends T>(source: U, target: T): void {
    for (const key of Object.keys(target) as (keyof T)[]) {
        target[key] = source[key];
    }
}

export function pickBucketSyncSettings(setting: ObsidianLiveSyncSettings): BucketSyncSetting {
    return {
        bucket: setting.bucket,
        region: setting.region,
        endpoint: setting.endpoint,
        accessKey: setting.accessKey,
        secretKey: setting.secretKey,
        bucketPrefix: setting.bucketPrefix,
        forcePathStyle: setting.forcePathStyle,
        useCustomRequestHandler: setting.useCustomRequestHandler,
        bucketCustomHeaders: setting.bucketCustomHeaders,
    };
}

export function pickCouchDBSyncSettings(setting: ObsidianLiveSyncSettings): CouchDBConnection {
    return {
        couchDB_URI: setting.couchDB_URI,
        couchDB_USER: setting.couchDB_USER,
        couchDB_PASSWORD: setting.couchDB_PASSWORD,
        couchDB_DBNAME: setting.couchDB_DBNAME,
        useRequestAPI: setting.useRequestAPI,
        // Advanced settings
        couchDB_CustomHeaders: setting.couchDB_CustomHeaders,
        jwtAlgorithm: setting.jwtAlgorithm,
        jwtExpDuration: setting.jwtExpDuration,
        jwtKey: setting.jwtKey,
        jwtKid: setting.jwtKid,
        jwtSub: setting.jwtSub,
        useJWT: setting.useJWT,
    };
}

export function pickEncryptionSettings(setting: ObsidianLiveSyncSettings | EncryptionSettings): EncryptionSettings {
    return {
        E2EEAlgorithm: setting.E2EEAlgorithm,
        encrypt: setting.encrypt,
        passphrase: setting.passphrase,
        usePathObfuscation: setting.usePathObfuscation,
    };
}

export function pickP2PSyncSettings(setting: Partial<ObsidianLiveSyncSettings> & P2PConnectionInfo): P2PConnectionInfo {
    return {
        P2P_Enabled: setting.P2P_Enabled,
        P2P_AppID: setting.P2P_AppID,
        P2P_roomID: setting.P2P_roomID,
        P2P_passphrase: setting.P2P_passphrase,
        P2P_relays: setting.P2P_relays,
        P2P_AutoStart: setting.P2P_AutoStart,
        P2P_AutoBroadcast: setting.P2P_AutoBroadcast,
        P2P_DevicePeerName: setting.P2P_DevicePeerName || "",
        P2P_turnServers: setting.P2P_turnServers,
        P2P_turnUsername: setting.P2P_turnUsername,
        P2P_turnCredential: setting.P2P_turnCredential,
    };
}

/**
 * Generate a random P2P Room ID in the format `123-456-789-abc`.
 */
export function generateP2PRoomId(): string {
    const randomValues = new Uint16Array(4);
    crypto.getRandomValues(randomValues);
    const MAX_UINT16 = 65536;
    const a = Math.floor((randomValues[0] / MAX_UINT16) * 1000);
    const b = Math.floor((randomValues[1] / MAX_UINT16) * 1000);
    const c = Math.floor((randomValues[2] / MAX_UINT16) * 1000);
    const dRange = 36 * 36 * 36;
    const d = Math.floor((randomValues[3] / MAX_UINT16) * dRange);
    return `${a.toString().padStart(3, "0")}-${b.toString().padStart(3, "0")}-${c
        .toString()
        .padStart(3, "0")}-${d.toString(36).padStart(3, "0")}`;
}

/**
 * Extract the stable suffix (last segment) from a Room ID.
 */
export function extractP2PRoomSuffix(roomId: string): string {
    const trimmed = roomId.trim();
    if (trimmed === "") return "";
    const parts = trimmed
        .split("-")
        .map((e) => e.trim())
        .filter((e) => e);
    if (parts.length === 0) return "";
    return parts[parts.length - 1] ?? "";
}
