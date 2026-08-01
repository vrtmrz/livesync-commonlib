import {
    defaultRemoteProviderRegistry,
    type BuiltInRemoteConfiguration,
} from "./remoteProviders/defaultRemoteProviderRegistry.ts";

export type RemoteConfigurationResult = BuiltInRemoteConfiguration;

/** Compatibility façade over the default, immutable remote-provider registry. */
export class ConnectionStringParser {
    static parse(uri: string): RemoteConfigurationResult {
        return defaultRemoteProviderRegistry.parse(uri);
    }

    static serialize(configuration: RemoteConfigurationResult): string {
        return defaultRemoteProviderRegistry.serialise(configuration);
    }
}
