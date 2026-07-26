/**
 * Focused public primitives for storing and selecting multiple remote connection profiles.
 *
 * The compatibility fields remain available to existing hosts, but new profile-management code
 * should use this entry point instead of importing the wider service feature module.
 */
export {
    activateP2PRemoteConfiguration,
    activateRemoteConfiguration,
    createRemoteConfigurationId,
    suggestRemoteConfigurationName,
    upsertRemoteConfigurationInPlace,
} from "@lib/serviceFeatures/remoteConfig";
export type {
    SerializableRemoteConfigurationType,
    UpsertRemoteConfigurationOptions,
} from "@lib/serviceFeatures/remoteConfig";
export type { RemoteConfiguration } from "@lib/common/models/setting.type";
