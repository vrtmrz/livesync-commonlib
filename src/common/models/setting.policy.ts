import type { ObsidianLiveSyncSettings } from "./setting.type";
import type { TaggedType } from "./shared.type.util";
import { DEFAULT_SETTINGS } from "./setting.const.defaults";

type PersistencePolicyFor<K extends keyof ObsidianLiveSyncSettings> = K extends "passphrase"
    ? "passphrase"
    : K extends "idDerivationKey"
      ? "id-key"
      : K extends "remoteConfigurations"
        ? "profiles"
        : K extends "deviceAndVaultName" | "P2P_DevicePeerName"
          ? "device"
          : NonNullable<ObsidianLiveSyncSettings[K]> extends string
            ? "include" | "connection" | "connection-context" | "omit"
            : "include" | "omit";

type SettingsPropertyPolicyTable = {
    [K in keyof ObsidianLiveSyncSettings]-?: SettingPropertyPolicy & { persistence: PersistencePolicyFor<K> };
};

export const SettingPolicies = {
    Default: { markdown: "include", persistence: "include" },
    LocalOnly: { markdown: "omit", persistence: "include" },
    DeviceLocal: { markdown: "include", persistence: "device" },
    MarkdownCredentials: { markdown: "credentials", persistence: "include" },
    RemoteProfiles: { markdown: "credentials", persistence: "profiles" },
    LocalConnection: { markdown: "include", persistence: "connection" },
    ConnectionCredentials: { markdown: "credentials", persistence: "connection" },
    ConnectionContext: { markdown: "include", persistence: "connection-context" },
    E2EEPassphrase: { markdown: "credentials", persistence: "passphrase" },
    IdDerivationKey: { markdown: "credentials", persistence: "id-key" },
    RuntimeOnly: { markdown: "omit", persistence: "omit" },
} as const;

export type SettingPropertyPolicy = (typeof SettingPolicies)[keyof typeof SettingPolicies];

/** Every schema property requires an explicit export and persistence policy. */
export const SETTINGS_PROPERTY_POLICY = {
    liveSync: SettingPolicies.Default,
    syncOnSave: SettingPolicies.Default,
    syncOnStart: SettingPolicies.Default,
    syncOnFileOpen: SettingPolicies.Default,
    syncOnEditorSave: SettingPolicies.Default,
    keepReplicationActiveInBackground: SettingPolicies.Default,
    allowSleepDuringSynchronisation: SettingPolicies.Default,
    allowSleepDuringSynchronisationOnDesktop: SettingPolicies.Default,
    syncMinimumInterval: SettingPolicies.Default,
    showVerboseLog: SettingPolicies.Default,
    lessInformationInLog: SettingPolicies.Default,
    showLongerLogInsideEditor: SettingPolicies.Default,
    showStatusOnEditor: SettingPolicies.Default,
    showStatusOnStatusbar: SettingPolicies.Default,
    showOnlyIconsOnEditor: SettingPolicies.Default,
    hideFileWarningNotice: SettingPolicies.Default,
    networkWarningStyle: SettingPolicies.Default,
    displayLanguage: SettingPolicies.Default,
    trashInsteadDelete: SettingPolicies.Default,
    doNotDeleteFolder: SettingPolicies.Default,
    batchSave: SettingPolicies.Default,
    batchSaveMinimumDelay: SettingPolicies.Default,
    batchSaveMaximumDelay: SettingPolicies.Default,
    syncMaxSizeInMB: SettingPolicies.Default,
    useIgnoreFiles: SettingPolicies.Default,
    ignoreFiles: SettingPolicies.Default,
    processSizeMismatchedFiles: SettingPolicies.Default,
    syncOnlyRegEx: SettingPolicies.Default,
    syncIgnoreRegEx: SettingPolicies.Default,
    syncAfterMerge: SettingPolicies.Default,
    resolveConflictsByNewerFile: SettingPolicies.Default,
    writeDocumentsIfConflicted: SettingPolicies.Default,
    disableMarkdownAutoMerge: SettingPolicies.Default,
    configPassphraseStore: SettingPolicies.Default,
    encryptedPassphrase: SettingPolicies.LocalOnly,
    encryptedIdDerivationKey: SettingPolicies.LocalOnly,
    encryptedCouchDBConnection: SettingPolicies.LocalOnly,
    periodicReplication: SettingPolicies.Default,
    periodicReplicationInterval: SettingPolicies.Default,
    syncInternalFiles: SettingPolicies.Default,
    syncInternalFilesBeforeReplication: SettingPolicies.Default,
    syncInternalFilesInterval: SettingPolicies.Default,
    syncInternalFilesIgnorePatterns: SettingPolicies.Default,
    syncInternalFilesTargetPatterns: SettingPolicies.Default,
    watchInternalFileChanges: SettingPolicies.Default,
    suppressNotifyHiddenFilesChange: SettingPolicies.Default,
    syncInternalFileOverwritePatterns: SettingPolicies.Default,
    usePluginSync: SettingPolicies.Default,
    usePluginSettings: SettingPolicies.Default,
    showOwnPlugins: SettingPolicies.Default,
    autoSweepPlugins: SettingPolicies.Default,
    autoSweepPluginsPeriodic: SettingPolicies.Default,
    notifyPluginOrSettingUpdated: SettingPolicies.Default,
    deviceAndVaultName: SettingPolicies.DeviceLocal,
    usePluginSyncV2: SettingPolicies.Default,
    usePluginEtc: SettingPolicies.Default,
    pluginSyncExtendedSetting: SettingPolicies.Default,
    useAdvancedMode: SettingPolicies.Default,
    usePowerUserMode: SettingPolicies.Default,
    useEdgeCaseMode: SettingPolicies.Default,
    notifyThresholdOfRemoteStorageSize: SettingPolicies.Default,
    disableWorkerForGeneratingChunks: SettingPolicies.Default,
    processSmallFilesInUIThread: SettingPolicies.Default,
    savingDelay: SettingPolicies.Default,
    gcDelay: SettingPolicies.Default,
    skipOlderFilesOnSync: SettingPolicies.Default,
    useIndexedDBAdapter: SettingPolicies.Default,
    enableDebugTools: SettingPolicies.Default,
    writeLogToTheFile: SettingPolicies.Default,
    settingSyncFile: SettingPolicies.Default,
    writeCredentialsForSettingSync: SettingPolicies.Default,
    notifyAllSettingSyncFile: SettingPolicies.Default,
    suspendFileWatching: SettingPolicies.Default,
    suspendParseReplicationResult: SettingPolicies.Default,
    doNotSuspendOnFetching: SettingPolicies.Default,
    maxMTimeForReflectEvents: SettingPolicies.Default,
    versionUpFlash: SettingPolicies.Default,
    settingVersion: SettingPolicies.Default,
    isConfigured: SettingPolicies.Default,
    lastReadUpdates: SettingPolicies.Default,
    doctorProcessedVersion: SettingPolicies.Default,
    remoteConfigurations: SettingPolicies.RemoteProfiles,
    activeConfigurationId: SettingPolicies.MarkdownCredentials,
    P2P_ActiveRemoteConfigurationId: SettingPolicies.MarkdownCredentials,
    couchDB_URI: SettingPolicies.LocalConnection,
    couchDB_USER: SettingPolicies.ConnectionCredentials,
    couchDB_PASSWORD: SettingPolicies.ConnectionCredentials,
    couchDB_DBNAME: SettingPolicies.LocalConnection,
    couchDB_CustomHeaders: SettingPolicies.ConnectionCredentials,
    useJWT: SettingPolicies.Default,
    jwtAlgorithm: SettingPolicies.Default,
    jwtKey: SettingPolicies.ConnectionCredentials,
    jwtKid: SettingPolicies.ConnectionCredentials,
    jwtSub: SettingPolicies.ConnectionCredentials,
    jwtExpDuration: SettingPolicies.Default,
    useRequestAPI: SettingPolicies.Default,
    accessKey: SettingPolicies.ConnectionCredentials,
    secretKey: SettingPolicies.ConnectionCredentials,
    bucket: SettingPolicies.LocalConnection,
    region: SettingPolicies.ConnectionContext,
    endpoint: SettingPolicies.LocalConnection,
    useCustomRequestHandler: SettingPolicies.Default,
    bucketCustomHeaders: SettingPolicies.ConnectionCredentials,
    bucketPrefix: SettingPolicies.Default,
    forcePathStyle: SettingPolicies.Default,
    remoteType: SettingPolicies.Default,
    encrypt: SettingPolicies.Default,
    passphrase: SettingPolicies.E2EEPassphrase,
    idDerivationVersion: SettingPolicies.MarkdownCredentials,
    idDerivationKey: SettingPolicies.IdDerivationKey,
    usePathObfuscation: SettingPolicies.Default,
    encryptInternalMetadata: SettingPolicies.Default,
    E2EEAlgorithm: SettingPolicies.Default,
    hashAlg: SettingPolicies.Default,
    minimumChunkSize: SettingPolicies.Default,
    customChunkSize: SettingPolicies.Default,
    longLineThreshold: SettingPolicies.Default,
    useSegmenter: SettingPolicies.Default,
    enableChunkSplitterV2: SettingPolicies.Default,
    doNotUseFixedRevisionForChunks: SettingPolicies.Default,
    chunkSplitterVersion: SettingPolicies.Default,
    useEden: SettingPolicies.Default,
    maxChunksInEden: SettingPolicies.Default,
    maxTotalLengthInEden: SettingPolicies.Default,
    maxAgeInEden: SettingPolicies.Default,
    tweakModified: SettingPolicies.Default,
    checkIntegrityOnSave: SettingPolicies.Default,
    useHistory: SettingPolicies.Default,
    disableRequestURI: SettingPolicies.Default,
    sendChunksBulk: SettingPolicies.Default,
    sendChunksBulkMaxSize: SettingPolicies.Default,
    useDynamicIterationCount: SettingPolicies.Default,
    doNotPaceReplication: SettingPolicies.Default,
    readChunksOnline: SettingPolicies.Default,
    useOnlyLocalChunk: SettingPolicies.Default,
    concurrencyOfReadChunksOnline: SettingPolicies.Default,
    minimumIntervalOfReadChunksOnline: SettingPolicies.Default,
    enableCompression: SettingPolicies.Default,
    batch_size: SettingPolicies.Default,
    batches_limit: SettingPolicies.Default,
    ignoreVersionCheck: SettingPolicies.Default,
    disableCheckingConfigMismatch: SettingPolicies.Default,
    autoAcceptCompatibleTweak: SettingPolicies.Default,
    hashCacheMaxCount: SettingPolicies.Default,
    hashCacheMaxAmount: SettingPolicies.Default,
    permitEmptyPassphrase: SettingPolicies.Default,
    handleFilenameCaseSensitive: SettingPolicies.Default,
    checkConflictOnlyOnOpen: SettingPolicies.Default,
    showMergeDialogOnlyOnActive: SettingPolicies.Default,
    additionalSuffixOfDatabaseName: SettingPolicies.LocalOnly,
    useTimeouts: SettingPolicies.Default,
    deleteMetadataOfDeletedFiles: SettingPolicies.Default,
    automaticallyDeleteMetadataOfDeletedFiles: SettingPolicies.Default,
    P2P_AutoAccepting: SettingPolicies.Default,
    P2P_AutoSyncPeers: SettingPolicies.Default,
    P2P_AutoWatchPeers: SettingPolicies.Default,
    P2P_SyncOnReplication: SettingPolicies.Default,
    P2P_RebuildFrom: SettingPolicies.Default,
    P2P_AutoAcceptingPeers: SettingPolicies.Default,
    P2P_AutoDenyingPeers: SettingPolicies.Default,
    P2P_IsHeadless: SettingPolicies.Default,
    P2P_iceServers: SettingPolicies.RuntimeOnly,
    P2P_iceServersExpiresAt: SettingPolicies.RuntimeOnly,
    P2P_Enabled: SettingPolicies.Default,
    P2P_relays: SettingPolicies.Default,
    P2P_roomID: SettingPolicies.Default,
    P2P_passphrase: SettingPolicies.MarkdownCredentials,
    P2P_AppID: SettingPolicies.Default,
    P2P_AutoStart: SettingPolicies.Default,
    P2P_AutoBroadcast: SettingPolicies.Default,
    P2P_DevicePeerName: SettingPolicies.DeviceLocal,
    P2P_turnServers: SettingPolicies.Default,
    P2P_turnUsername: SettingPolicies.MarkdownCredentials,
    P2P_turnCredential: SettingPolicies.MarkdownCredentials,
    P2P_managedType: SettingPolicies.RuntimeOnly,
    P2P_managedId: SettingPolicies.RuntimeOnly,
    P2P_managedToken: SettingPolicies.RuntimeOnly,
    P2P_maxWirePayloadBytes: SettingPolicies.Default,
    P2P_connectionPath: SettingPolicies.Default,
    P2P_useDiagRTC: SettingPolicies.Default,
} as const satisfies SettingsPropertyPolicyTable;

type PolicyKeys<Axis extends keyof SettingPropertyPolicy, Action> = {
    [K in keyof typeof SETTINGS_PROPERTY_POLICY]: (typeof SETTINGS_PROPERTY_POLICY)[K][Axis] extends Action ? K : never;
}[keyof typeof SETTINGS_PROPERTY_POLICY];

type ConnectionKey = PolicyKeys<"persistence", "connection">;
type ConnectionPayloadKey = ConnectionKey | PolicyKeys<"persistence", "connection-context">;
type AlwaysOmittedMarkdownKey = PolicyKeys<"markdown", "omit">;
type MarkdownCredentialKey = PolicyKeys<"markdown", "credentials">;

const settingKeys = Object.keys(SETTINGS_PROPERTY_POLICY) as (keyof typeof SETTINGS_PROPERTY_POLICY)[];
const protectedConnectionKeys = settingKeys.filter(
    (key): key is ConnectionKey => SETTINGS_PROPERTY_POLICY[key].persistence === "connection"
);
const connectionKeys = settingKeys.filter(
    (key): key is ConnectionPayloadKey =>
        SETTINGS_PROPERTY_POLICY[key].persistence === "connection" ||
        SETTINGS_PROPERTY_POLICY[key].persistence === "connection-context"
);
const omittedPersistenceKeys = settingKeys.filter((key) => SETTINGS_PROPERTY_POLICY[key].persistence === "omit");

export type ConnectionSettings = Pick<ObsidianLiveSyncSettings, ConnectionPayloadKey>;
export type ConfigurationCiphertext = TaggedType<string, "ConfigurationCiphertext">;
export type PersistedSettings = TaggedType<
    Omit<ObsidianLiveSyncSettings, ConnectionKey | "encryptedCouchDBConnection"> & {
        [K in ConnectionKey]: "";
    } & { encryptedCouchDBConnection: ConfigurationCiphertext | "" },
    "PersistedSettings"
>;
export type MarkdownSettings = TaggedType<
    Partial<Omit<ObsidianLiveSyncSettings, AlwaysOmittedMarkdownKey>> & {
        [K in AlwaysOmittedMarkdownKey]?: never;
    },
    "MarkdownSettings"
>;
export type CredentialFreeMarkdownSettings = MarkdownSettings & {
    [K in MarkdownCredentialKey]?: never;
};

function copySetting<K extends keyof ObsidianLiveSyncSettings>(
    target: Partial<ObsidianLiveSyncSettings>,
    source: Partial<ObsidianLiveSyncSettings>,
    key: K
): void {
    if (key in source) target[key] = source[key];
    else delete target[key];
}

function cloneProfiles(settings: Partial<ObsidianLiveSyncSettings>): ObsidianLiveSyncSettings["remoteConfigurations"] {
    const profiles: ObsidianLiveSyncSettings["remoteConfigurations"] = {};
    for (const [id, profile] of Object.entries(settings.remoteConfigurations ?? {})) {
        Object.defineProperty(profiles, id, {
            value: { ...profile },
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return profiles;
}

/** Omit credentials and their dependent profile selections unless sharing is enabled. */
export function createMarkdownSettings(
    settings: Partial<ObsidianLiveSyncSettings>,
    includeCredentials: false
): CredentialFreeMarkdownSettings;
export function createMarkdownSettings(
    settings: Partial<ObsidianLiveSyncSettings>,
    includeCredentials?: boolean
): MarkdownSettings;
export function createMarkdownSettings(
    settings: Partial<ObsidianLiveSyncSettings>,
    includeCredentials = settings.writeCredentialsForSettingSync === true
): MarkdownSettings {
    const output: Partial<ObsidianLiveSyncSettings> = {};
    for (const key of settingKeys) {
        const action = SETTINGS_PROPERTY_POLICY[key].markdown;
        if (action === "omit" || (action === "credentials" && !includeCredentials)) continue;
        copySetting(output, settings, key);
    }
    if (output.remoteConfigurations) output.remoteConfigurations = cloneProfiles(output);
    return output as MarkdownSettings;
}

/** Keep local values for properties which Markdown is not permitted to replace. */
export function mergeMarkdownSettings(
    incoming: Partial<ObsidianLiveSyncSettings>,
    current: ObsidianLiveSyncSettings
): ObsidianLiveSyncSettings {
    const merged: ObsidianLiveSyncSettings = { ...DEFAULT_SETTINGS, ...incoming };
    for (const key of settingKeys) {
        const action = SETTINGS_PROPERTY_POLICY[key].markdown;
        if (action === "omit" || (action === "credentials" && merged.writeCredentialsForSettingSync !== true)) {
            copySetting(merged, current, key);
        }
    }
    merged.remoteConfigurations = cloneProfiles(merged);
    return merged;
}

export function selectConnectionSettings(settings: ObsidianLiveSyncSettings): ConnectionSettings {
    const connection = {} as ConnectionSettings;
    for (const key of connectionKeys) connection[key] = settings[key];
    return connection;
}

export function hasConnectionSettings(settings: ObsidianLiveSyncSettings): boolean {
    return protectedConnectionKeys.some((key) => settings[key] !== "");
}

export function clearConnectionSettings(settings: ObsidianLiveSyncSettings): void {
    for (const key of connectionKeys) settings[key] = "";
}

/** Older encrypted payloads may omit properties added by later schema versions. */
export function restoreConnectionSettings(settings: ObsidianLiveSyncSettings, payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const connection = payload as Record<string, unknown>;
    if (connectionKeys.some((key) => key in connection && typeof connection[key] !== "string")) return false;
    for (const key of connectionKeys) {
        if (key in connection) settings[key] = connection[key] as string;
    }
    return true;
}

export function omitUnpersistedSettings(settings: ObsidianLiveSyncSettings): void {
    for (const key of omittedPersistenceKeys) delete settings[key];
}

/** An empty encryption result must never be treated as a successfully encrypted value. */
export function requireConfigurationCiphertext(value: string): ConfigurationCiphertext {
    if (value === "") throw new Error("Failed to encrypt configuration. Settings were not saved.");
    return value as ConfigurationCiphertext;
}

/** Grant the persistence type only after the runtime policy has been checked. */
export function prepareSettingsForPersistence(settings: ObsidianLiveSyncSettings): PersistedSettings {
    if (hasConnectionSettings(settings)) throw new Error("Connection settings were not prepared for persistence.");
    if (settings.encrypt && settings.passphrase !== "")
        throw new Error("The passphrase was not prepared for persistence.");
    if (settings.idDerivationVersion === 1 && settings.idDerivationKey !== "") {
        throw new Error("The ID derivation key was not prepared for persistence.");
    }
    if (omittedPersistenceKeys.some((key) => key in settings)) {
        throw new Error("Runtime settings were not removed before persistence.");
    }
    if (
        settings.configPassphraseStore !== "" &&
        Object.values(settings.remoteConfigurations).some(
            (profile) => profile.uri.trim() !== "" && !profile.isEncrypted
        )
    ) {
        throw new Error("Remote configurations were not prepared for persistence.");
    }
    return settings as PersistedSettings;
}
