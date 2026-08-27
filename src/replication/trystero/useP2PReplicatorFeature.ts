import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { AutoAccepting, REMOTE_P2P } from "@lib/common/types";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { type UseP2PReplicatorResult } from "./UseP2PReplicatorResult";
import { addP2PEventHandlers } from "./addP2PEventHandlers";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_NOT_IMPLEMENTED,
    defineReplicatorProviderDefinitions,
    outcomeFromFiniteOpenReplication,
    replicationBlocked,
    replicationFailed,
    supportedStopActiveTransfer,
    type UserInitiatedOneShotRunner,
} from "@lib/replication";

/**
 * Factory type: given a replicator instance, returns the openReplicationUI callback for that instance.
 * Injected by the host platform (e.g. Obsidian). CLI/headless environments omit this.
 */
export type OpenReplicationUIFactory = (
    replicator: LiveSyncTrysteroReplicator
) => (showResult: boolean) => Promise<boolean | void>;

/** Same shape as OpenReplicationUIFactory, used for the rebuild/replicateAllFromServer flow. */
export type OpenRebuildUIFactory = OpenReplicationUIFactory;

/**
 * ServiceFeature: P2P Replicator integration and lifecycle management.
 * Registers a LiveSyncTrysteroReplicator instance as the active replicator when P2P is enabled in settings,
 * and binds it to lifecycle events for proper initialization and cleanup.
 * @param host
 */

export function useP2PReplicatorFeature(
    host: NecessaryServices<
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
    >,
    openReplicationUIFactory?: OpenReplicationUIFactory,
    openRebuildUIFactory?: OpenRebuildUIFactory
): UseP2PReplicatorResult {
    // Replicator instance should be single and shared across the plug-in.
    let replicator: LiveSyncTrysteroReplicator = new LiveSyncTrysteroReplicator({
        services: host.services,
    });
    let replacementPromise: Promise<LiveSyncTrysteroReplicator> | undefined;

    const configureReplicator = (instance: LiveSyncTrysteroReplicator) => {
        if (openReplicationUIFactory) {
            instance.env.openReplicationUI = openReplicationUIFactory(instance);
        }
        if (openRebuildUIFactory) {
            instance.env.openRebuildUI = openRebuildUIFactory(instance);
        }
    };
    configureReplicator(replicator);

    const createP2PReplicator = async (): Promise<LiveSyncTrysteroReplicator> => {
        // Preserve the former factory boundary: every active acquisition closes
        // the pre-existing outer instance before publishing its replacement.
        if (replacementPromise) return await replacementPromise;
        const operation = (async () => {
            const existingReplicator = replicator;
            try {
                await existingReplicator?.close();
            } catch (e) {
                Logger(`Error closing existing p2p replicator`);
                Logger(e, LOG_LEVEL_VERBOSE);
            }
            const newReplicator = new LiveSyncTrysteroReplicator({ services: host.services });
            configureReplicator(newReplicator);
            replicator = newReplicator; // Update the replicator reference for lifecycle handlers.
            return replicator;
        })();
        replacementPromise = operation;
        try {
            return await operation;
        } finally {
            if (replacementPromise === operation) replacementPromise = undefined;
        }
    };

    const userInitiatedOneShot: UserInitiatedOneShotRunner = async (instance, setting, request) => {
        if (request.interaction.kind !== "permitted" || !request.interaction.permissions.peerSelection) {
            return replicationBlocked("interaction-required");
        }
        try {
            const result = await instance.openReplication(
                setting,
                false,
                request.interaction.permissions.failureRecovery,
                false
            );
            return outcomeFromFiniteOpenReplication(result);
        } catch (error) {
            return replicationFailed(error);
        }
    };

    host.services.replicator.registerReplicatorProviderDefinitions(
        defineReplicatorProviderDefinitions([REMOTE_P2P] as const, {
            [REMOTE_P2P]: {
                kind: REMOTE_P2P,
                diagnosticName: "P2P",
                isConfigured: (settings) => settings.remoteType === REMOTE_P2P && settings.P2P_Enabled,
                create: createP2PReplicator,
                userInitiatedOneShot: { kind: "supported", run: userInitiatedOneShot },
                unattendedOneShot: CAPABILITY_NOT_IMPLEMENTED,
                continuous: CAPABILITY_NOT_APPLICABLE,
                stopActiveTransfer: supportedStopActiveTransfer(),
            },
        })
    );

    const activeReplicator = {
        get replicator() {
            return replicator;
        },
    };
    addP2PEventHandlers(() => activeReplicator.replicator, host.services.context.events);

    // Lifecycle bindings (replication should be closed).

    host.services.appLifecycle.onUnload.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    host.services.appLifecycle.onSuspending.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    host.services.databaseEvents.onDatabaseInitialisation.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    // And, reopen if auto-start is enabled when app is resumed.
    host.services.appLifecycle.onResumed.addHandler(() => {
        const settings = host.services.setting.currentSettings();
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            compatGlobal.setTimeout((): void => void replicator?.open(), 100);
        }
        return Promise.resolve(true);
    });

    // Suspend extra sync handler
    host.services.setting.suspendExtraSync.addHandler(() => {
        const s = host.services.setting.currentSettings();
        // When P2P is the primary remote type, do not disable P2P_Enabled —
        // the rebuild/fetch flows depend on it to replicate from a peer.
        if (s.remoteType !== REMOTE_P2P) {
            s.P2P_Enabled = false;
        }
        s.P2P_AutoAccepting = AutoAccepting.NONE;
        s.P2P_AutoBroadcast = false;
        s.P2P_AutoStart = false;
        s.P2P_AutoSyncPeers = "";
        s.P2P_AutoWatchPeers = "";
        return Promise.resolve(true);
    });

    return activeReplicator;
}
