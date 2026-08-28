import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_P2P } from "@lib/common/types";
import { EVENT_DATABASE_REBUILT, EVENT_SETTING_SAVED } from "@lib/events/coreEvents";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_ADVERTISEMENT_RECEIVED } from "./TrysteroReplicatorP2PServer";
import { useP2PReplicatorFeature } from "./useP2PReplicatorFeature";
import {
    NO_INTERACTION,
    REMOTE_ADMINISTRATION_ACTIONS,
    REMOTE_ADMINISTRATION_FAILURE_REASONS,
    REMOTE_ADMINISTRATION_RESULT_STATUSES,
    type ReplicatorProviderDefinitionMap,
} from "@lib/replication";
import { P2PRoomSessionOwner } from "./P2PRoomSessionOwner";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("useP2PReplicatorFeature", () => {
    it("does not reopen a suspended room from a delayed automatic-start callback", async () => {
        vi.useFakeTimers();
        try {
            const events = createLiveSyncEventHub();
            const settings = {
                remoteType: REMOTE_P2P,
                P2P_Enabled: true,
                P2P_AutoStart: true,
            };
            const onSuspending = { addHandler: vi.fn() };
            const onResumed = { addHandler: vi.fn() };
            const handler = { addHandler: vi.fn() };
            const host = {
                services: {
                    context: { events },
                    setting: {
                        currentSettings: vi.fn(() => settings),
                        suspendExtraSync: handler,
                    },
                    replicator: {
                        registerReplicatorProviderDefinitions: vi.fn(),
                    },
                    appLifecycle: {
                        onUnload: handler,
                        onSuspending,
                        onResumed,
                    },
                    databaseEvents: {
                        onResetDatabase: handler,
                        onCloseDatabase: handler,
                        onDatabaseInitialisation: handler,
                    },
                },
                serviceModules: {},
            } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

            useP2PReplicatorFeature(host);
            const setPersistentDemand = vi
                .spyOn(P2PRoomSessionOwner.prototype, "setPersistentDemand")
                .mockResolvedValue(undefined);
            const close = vi.spyOn(P2PRoomSessionOwner.prototype, "close").mockResolvedValue(undefined);

            await onResumed.addHandler.mock.calls[0][0]();
            await onSuspending.addHandler.mock.calls[0][0]();
            expect(close).toHaveBeenCalledOnce();

            await vi.runOnlyPendingTimersAsync();

            expect(setPersistentDemand).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("retires the stable room before database reset or close proceeds", async () => {
        const events = createLiveSyncEventHub();
        const handler = { addHandler: vi.fn() };
        const onResetDatabase = { addHandler: vi.fn() };
        const onCloseDatabase = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn(),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase,
                    onCloseDatabase,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];
        const close = vi.spyOn(P2PRoomSessionOwner.prototype, "close").mockResolvedValue(undefined);

        useP2PReplicatorFeature(host);

        expect(onResetDatabase.addHandler).toHaveBeenCalledOnce();
        expect(onCloseDatabase.addHandler).toHaveBeenCalledOnce();
        await onResetDatabase.addHandler.mock.calls[0][0]();
        await onCloseDatabase.addHandler.mock.calls[0][0]();
        expect(close).toHaveBeenCalledTimes(2);
    });

    it("keeps stable narrow views over one P2P service context while active adapters are reacquired", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const openReplicationUIFactory = vi.fn(() => vi.fn(async () => true));
        const result = useP2PReplicatorFeature(host, openReplicationUIFactory);
        const stableViews = {
            transportLifecycle: result.transportLifecycle,
            peerDirectory: result.peerDirectory,
            peerAdmission: result.peerAdmission,
            targetedTransfer: result.targetedTransfer,
            changeRelay: result.changeRelay,
            configurationExchange: result.configurationExchange,
            diagnostics: result.diagnostics,
        };

        expect(result.transportLifecycle).toBe(stableViews.transportLifecycle);
        expect(result.peerDirectory).toBe(stableViews.peerDirectory);
        expect(result.peerAdmission).toBe(stableViews.peerAdmission);
        expect(result.targetedTransfer).toBe(stableViews.targetedTransfer);
        expect(result.changeRelay).toBe(stableViews.changeRelay);
        expect(result.configurationExchange).toBe(stableViews.configurationExchange);
        expect(result.diagnostics).toBe(stableViews.diagnostics);

        const compatibilityReplicator = result.replicator;
        expect(openReplicationUIFactory).toHaveBeenCalledOnce();
        expect(openReplicationUIFactory.mock.calls[0][0]).toBe(compatibilityReplicator);
        const uiViews = openReplicationUIFactory.mock.calls[0][1];
        expect(uiViews.transportLifecycle).toBe(stableViews.transportLifecycle);
        expect(uiViews.peerDirectory).toBe(stableViews.peerDirectory);
        expect(uiViews.peerAdmission).toBe(stableViews.peerAdmission);
        expect(uiViews.targetedTransfer).toBe(stableViews.targetedTransfer);
        expect(uiViews.changeRelay).toBe(stableViews.changeRelay);
        expect(uiViews.configurationExchange).toBe(stableViews.configurationExchange);
        expect(uiViews.diagnostics).toBe(stableViews.diagnostics);
        const close = vi.spyOn(compatibilityReplicator, "close").mockResolvedValue(undefined);
        const closeReplication = vi.spyOn(compatibilityReplicator, "closeReplication");
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition).toBeDefined();

        const firstAdapter = await definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);
        const secondAdapter = await definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);

        expect(firstAdapter).not.toBe(compatibilityReplicator);
        expect(secondAdapter).not.toBe(firstAdapter);
        firstAdapter?.closeReplication();
        expect(result.replicator).toBe(compatibilityReplicator);
        expect(result.transportLifecycle).toBe(stableViews.transportLifecycle);
        expect(result.targetedTransfer).toBe(stableViews.targetedTransfer);
        expect(close).not.toHaveBeenCalled();
        expect(closeReplication).not.toHaveBeenCalled();

        await stableViews.transportLifecycle.disconnect();
        await expect(stableViews.targetedTransfer.synchroniseConfiguredTargets()).resolves.toEqual({
            status: "blocked",
            reason: "not-ready",
        });
    });

    it("keeps a compatibility-facade disconnect as an automatic-start veto while allowing rebuild continuation", async () => {
        const events = createLiveSyncEventHub();
        const settings = {
            remoteType: REMOTE_P2P,
            P2P_Enabled: true,
            P2P_AutoStart: true,
        };
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => settings),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn(),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const result = useP2PReplicatorFeature(host);
        const setPersistentDemand = vi
            .spyOn(P2PRoomSessionOwner.prototype, "setPersistentDemand")
            .mockResolvedValue(undefined);
        const close = vi.spyOn(P2PRoomSessionOwner.prototype, "close").mockResolvedValue(undefined);

        await result.replicator.close();
        events.emitEvent(EVENT_SETTING_SAVED, settings as never);
        await Promise.resolve();

        expect(close).toHaveBeenCalledOnce();
        expect(setPersistentDemand).not.toHaveBeenCalled();

        events.emitEvent(EVENT_DATABASE_REBUILT);
        await vi.waitFor(() => expect(setPersistentDemand).toHaveBeenCalledWith("rebuild-continuation", true));

        settings.P2P_Enabled = false;
        settings.P2P_AutoStart = false;
        events.emitEvent(EVENT_SETTING_SAVED, settings as never);

        await vi.waitFor(() => expect(setPersistentDemand).toHaveBeenCalledTimes(2));
        expect(setPersistentDemand).toHaveBeenNthCalledWith(1, "rebuild-continuation", true);
        expect(setPersistentDemand).toHaveBeenNthCalledWith(2, "automatic", false);
        expect(close).toHaveBeenCalledOnce();
    });

    it("declares unattended P2P replication as supported", () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({
                        remoteType: REMOTE_P2P,
                        P2P_Enabled: true,
                        P2P_AutoStart: false,
                    })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        useP2PReplicatorFeature(host);

        expect(definitions?.get(REMOTE_P2P)?.unattendedOneShot.kind).toBe("supported");
    });

    it("declares P2P administration boundaries without routing session-owned peer events through the global bridge", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const result = useP2PReplicatorFeature(host);
        const first = result.replicator;
        const firstOnNewPeer = vi.spyOn(first, "onNewPeer");
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition).toBeDefined();
        expect(definition?.kind).toBe(REMOTE_P2P);
        expect(definition?.isConfigured({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never)).toBe(true);
        expect(definition?.isConfigured({ remoteType: REMOTE_P2P, P2P_Enabled: false } as never)).toBe(false);
        expect(definition?.userInitiatedOneShot.kind).toBe("supported");
        expect(definition?.continuous.kind).toBe("not-applicable");
        expect(definition?.stopActiveTransfer.kind).toBe("supported");
        if (definition?.stopActiveTransfer.kind !== "supported") {
            throw new Error("P2P stop role should be supported");
        }
        const terminateSync = vi.fn();
        const stopResult = await definition.stopActiveTransfer.run({ terminateSync } as never);
        expect(stopResult).toEqual({ status: "completed" });
        expect(terminateSync).toHaveBeenCalledOnce();
        const activeAdapter = await definition?.create({
            remoteType: REMOTE_P2P,
            P2P_Enabled: true,
        } as never);
        expect(definition?.remoteAdministration.kind).toBe("supported");
        if (definition?.remoteAdministration.kind !== "supported") {
            throw new Error("P2P remote administration should preserve the compatibility boundary");
        }
        const setting = { remoteType: REMOTE_P2P, P2P_Enabled: true } as never;
        await expect(
            definition.remoteAdministration.run(activeAdapter!, setting, {
                action: REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
            })
        ).resolves.toEqual({
            status: REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED,
            reason: REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_APPLICABLE,
        });
        await expect(
            definition.remoteAdministration.run(activeAdapter!, setting, {
                action: REMOTE_ADMINISTRATION_ACTIONS.LOCK,
            })
        ).rejects.toThrow("P2P replication does not support database lock.");

        events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, {
            peerId: "peer-a",
            name: "Device A",
            platform: "test",
        });

        expect(activeAdapter).not.toBe(first);
        expect(result.replicator).toBe(first);
        expect(firstOnNewPeer).not.toHaveBeenCalled();
    });

    it("requires peer-selection authority for the user P2P role", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        useP2PReplicatorFeature(host);
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition?.userInitiatedOneShot.kind).toBe("supported");
        if (definition?.userInitiatedOneShot.kind !== "supported") throw new Error("P2P role is not supported");
        const openReplication = vi.fn();
        const result = await definition.userInitiatedOneShot.run({ openReplication } as never, {} as never, {
            trigger: "manual",
            interaction: NO_INTERACTION,
        });

        expect(result).toEqual({ status: "blocked", reason: "interaction-required" });
        expect(openReplication).not.toHaveBeenCalled();
    });

    it("creates independent active adapters without replacing the service owner", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: {
                    onResetDatabase: handler,
                    onCloseDatabase: handler,
                    onDatabaseInitialisation: handler,
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const result = useP2PReplicatorFeature(host);
        const original = result.replicator;
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition).toBeDefined();
        const close = vi.spyOn(original, "close").mockResolvedValue(undefined);

        const firstRequest = definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);
        const secondRequest = definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);
        const [firstReplacement, secondReplacement] = await Promise.all([firstRequest, secondRequest]);

        expect(close).not.toHaveBeenCalled();
        expect(firstReplacement).not.toBe(secondReplacement);
        expect(result.replicator).toBe(original);
    });
});
