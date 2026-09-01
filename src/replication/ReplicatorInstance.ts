import type { RemoteDBSettings } from "@lib/common/types.ts";

/**
 * Minimal lifecycle contract shared by active Replicator instances.
 *
 * Providers may expose additional operations through focused capability facets;
 * this contract contains only the lifecycle operations required by the host.
 */
export interface ReplicatorInstance {
    /** Initialise local database state required by replication before publication. */
    initializeDatabaseForReplication(): Promise<boolean>;

    /**
     * Invoke the legacy replication entry point.
     *
     * A `void` settlement may mean an accepted long-lived start, while finite
     * adapters require an explicit `true`. Provider runners convert this
     * compatibility result to a typed outcome before exposing it to callers.
     */
    openReplication(
        setting: RemoteDBSettings,
        keepAlive: boolean,
        showResult: boolean,
        ignoreCleanLock: boolean
    ): Promise<void | boolean>;

    /** Stop active transfer work; providers may settle this synchronously. */
    terminateSync(): void | Promise<void>;

    /** Close the instance; providers may settle this synchronously. */
    closeReplication(): void | Promise<void>;
}
