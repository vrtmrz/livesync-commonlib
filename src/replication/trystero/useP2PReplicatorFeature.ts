import { AutoAccepting, REMOTE_P2P } from "@lib/common/types";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { type UseP2PReplicatorResult } from "./UseP2PReplicatorResult";
import { addP2PEventHandlers } from "./addP2PEventHandlers";
import { LiveSyncP2PService, type P2PServiceViews } from "@lib/p2p/P2PService";
import {
    CAPABILITY_NOT_APPLICABLE,
    PEER_REPLICATION_READINESS,
    defineReplicatorProviderDefinitions,
    outcomeFromFiniteOpenReplication,
    replicationBlocked,
    replicationFailed,
    supportedStopActiveTransfer,
    type UserInitiatedOneShotRunner,
    type UnattendedOneShotRunner,
} from "@lib/replication";

/**
 * Factory type: given the compatibility Replicator and the stable service
 * views, returns the openReplicationUI callback for that instance.
 *
 * The Replicator remains available for rebuild-specific compatibility work;
 * modal lifecycle, status, and ordinary actions should use the narrow views.
 * Injected by the host platform (for example, Obsidian). CLI and headless
 * environments omit this.
 */
export type OpenReplicationUIFactory = (
    replicator: LiveSyncTrysteroReplicator,
    p2p: P2PServiceViews
) => (showResult: boolean) => Promise<boolean | void>;

/** Same shape as OpenReplicationUIFactory, used for the rebuild/replicateAllFromServer flow. */
export type OpenRebuildUIFactory = OpenReplicationUIFactory;

/**
 * Compose one P2P service owner and register non-owning active provider
 * adapters over it.
 *
 * The returned views remain valid for the host composition lifetime. The
 * compatibility facade is retained only for consumers which have not yet
 * migrated to those views.
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
    const service = new LiveSyncP2PService({
        services: host.services,
    });
    const replicator = service.compatibilityReplicator;

    const configureReplicator = (instance: LiveSyncTrysteroReplicator) => {
        if (openReplicationUIFactory) {
            instance.env.openReplicationUI = openReplicationUIFactory(instance, service);
        }
        if (openRebuildUIFactory) {
            instance.env.openRebuildUI = openRebuildUIFactory(instance, service);
        }
    };
    configureReplicator(replicator);

    const createP2PReplicator = async () => service.createActiveReplicator();

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
    const unattendedOneShot: UnattendedOneShotRunner = async (_instance, _setting, request) => {
        if (request.interaction.kind !== "forbidden") {
            return replicationBlocked("interaction-required");
        }
        return await service.synchroniseConfiguredTargets();
    };

    host.services.replicator.registerReplicatorProviderDefinitions(
        defineReplicatorProviderDefinitions([REMOTE_P2P] as const, {
            [REMOTE_P2P]: {
                kind: REMOTE_P2P,
                diagnosticName: "P2P",
                readiness: PEER_REPLICATION_READINESS,
                isConfigured: (settings) => settings.remoteType === REMOTE_P2P && settings.P2P_Enabled,
                create: createP2PReplicator,
                userInitiatedOneShot: { kind: "supported", run: userInitiatedOneShot },
                unattendedOneShot: { kind: "supported", run: unattendedOneShot },
                continuous: CAPABILITY_NOT_APPLICABLE,
                stopActiveTransfer: supportedStopActiveTransfer(),
            },
        })
    );

    const activeReplicator: UseP2PReplicatorResult = {
        get replicator() {
            return replicator;
        },
        get transportLifecycle() {
            return service.transportLifecycle;
        },
        get peerDirectory() {
            return service.peerDirectory;
        },
        get peerAdmission() {
            return service.peerAdmission;
        },
        get targetedTransfer() {
            return service.targetedTransfer;
        },
        get changeRelay() {
            return service.changeRelay;
        },
        get configurationExchange() {
            return service.configurationExchange;
        },
        get diagnostics() {
            return service.diagnostics;
        },
    };
    addP2PEventHandlers(service, host.services.context.events);

    // Lifecycle bindings (replication should be closed).

    host.services.appLifecycle.onUnload.addHandler(async () => {
        await service.closeForLifecycle();
        return true;
    });

    host.services.appLifecycle.onSuspending.addHandler(async () => {
        await service.closeForLifecycle();
        return true;
    });

    const closeForDatabaseLifecycle = async () => {
        await service.closeForLifecycle();
        return true;
    };
    host.services.databaseEvents.onResetDatabase.addHandler(closeForDatabaseLifecycle);
    host.services.databaseEvents.onCloseDatabase.addHandler(closeForDatabaseLifecycle);
    host.services.databaseEvents.onDatabaseInitialisation.addHandler(closeForDatabaseLifecycle);

    // And, reopen if auto-start is enabled when app is resumed.
    host.services.appLifecycle.onResumed.addHandler(() => {
        service.scheduleAutoStart();
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
