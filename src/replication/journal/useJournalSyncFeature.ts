import type { RemoteDBSettings } from "@lib/common/models/setting.type.ts";
import { defaultRemoteProviderRegistry } from "@lib/common/remoteProviders/defaultRemoteProviderRegistry.ts";
import type {
    RemoteProviderConfiguration,
    RemoteProviderRegistry,
} from "@lib/common/remoteProviders/RemoteProviderRegistry.ts";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";

export type JournalSyncFeatureHost = NecessaryServices<
    | "API"
    | "appLifecycle"
    | "setting"
    | "vault"
    | "database"
    | "databaseEvents"
    | "keyValueDB"
    | "replication"
    | "config"
    | "UI"
    | "replicator"
    | "remote",
    never
>;

export interface JournalSyncFeatureOptions {
    createReplicator?: (environment: LiveSyncJournalReplicatorEnv) => LiveSyncAbstractReplicator;
    registry?: RemoteProviderRegistry<RemoteProviderConfiguration>;
}

/** Register the Journal replicator family selected by the composed remote-provider registry. */
export function useJournalSyncFeature(host: JournalSyncFeatureHost, options: JournalSyncFeatureOptions = {}): void {
    const registry = options.registry ?? defaultRemoteProviderRegistry;
    const createReplicator = options.createReplicator ?? ((environment) => new LiveSyncJournalReplicator(environment));
    host.services.replicator.getNewReplicator.addHandler(async (settingOverride: Partial<RemoteDBSettings> = {}) => {
        const settings = { ...host.services.setting.currentSettings(), ...settingOverride };
        if (!registry.isRemoteTypeInFamily(settings.remoteType, "journal")) return undefined;
        return createReplicator(host);
    });
}
