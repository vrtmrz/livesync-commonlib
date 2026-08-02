import {
    defaultRemoteProviderRegistry,
    type BuiltInRemoteConfiguration,
} from "./remoteProviders/defaultRemoteProviderRegistry.ts";

/**
 * Configurations recognised by the maintained connection-string façade.
 *
 * The placeholder keeps the previous source-level shape while WebDAV remains outside the default
 * registry. A host which adds another provider should use its composed registry directly.
 */
export type RemoteConfigurationResult = BuiltInRemoteConfiguration | { type: "webdav"; settings: never };

/** Compatibility façade over the default, immutable remote-provider registry. */
export class ConnectionStringParser {
    static parse(uri: string): RemoteConfigurationResult {
        return defaultRemoteProviderRegistry.parse(uri);
    }

    static serialize(configuration: RemoteConfigurationResult): string {
        return defaultRemoteProviderRegistry.serialise(configuration as BuiltInRemoteConfiguration);
    }
}
