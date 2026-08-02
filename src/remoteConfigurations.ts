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
export {
    builtInRemoteProviderDescriptors,
    createBuiltInRemoteProviderRegistry,
    defaultRemoteProviderRegistry,
} from "@lib/common/remoteProviders/defaultRemoteProviderRegistry.ts";
export { RemoteProviderRegistry } from "@lib/common/remoteProviders/RemoteProviderRegistry.ts";
export type {
    SerializableRemoteConfigurationType,
    UpsertRemoteConfigurationOptions,
} from "@lib/serviceFeatures/remoteConfig";
export type { BuiltInRemoteConfiguration } from "@lib/common/remoteProviders/defaultRemoteProviderRegistry.ts";
export type {
    RemoteActivationRole,
    RemoteProviderConfiguration,
    RemoteProviderDescriptor,
    RemoteProviderFamily,
} from "@lib/common/remoteProviders/RemoteProviderRegistry.ts";
export type { RemoteConfiguration } from "@lib/common/models/setting.type";
