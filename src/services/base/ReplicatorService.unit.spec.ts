import { describe, expect, it, vi } from "vitest";
import { ReplicatorService, type ReplicatorServiceDependencies } from "./ReplicatorService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import type { AsyncActivityOptions, AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    REPLACE_SAME_KIND_REPLICATOR,
    defineReplicatorProviderDefinitions,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    supportedStopActiveTransfer,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import type { ActiveReplicatorContext } from "@lib/replication/ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES, REMOTE_RESOURCE_KINDS, supportedCapability } from "@lib/replication";

class TestReplicatorService extends ReplicatorService<ServiceContext> {}

const testConfigurationIdentity = (setting: { activeConfigurationId?: string; remoteType: string }) =>
    setting.activeConfigurationId || setting.remoteType;

const NO_TEST_REMOTE_OPERATIONS = {
    remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
    remoteAdministration: CAPABILITY_NOT_APPLICABLE,
} as const;

function eventHook() {
    return { addHandler: vi.fn() };
}

function createService(activityRunner?: AsyncActivityRunner) {
    const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), eventHook());
    const dependencies = {
        settingService: {
            onRealiseSetting: eventHook(),
        },
        appLifecycleService: {
            getUnresolvedMessages,
            onSuspending: eventHook(),
        },
        databaseEventService: {
            onResetDatabase: eventHook(),
            onDatabaseInitialisation: eventHook(),
            onDatabaseInitialised: eventHook(),
            onDatabaseHasReady: eventHook(),
        },
        activityRunner,
    } as unknown as ReplicatorServiceDependencies;
    return new TestReplicatorService(new ServiceContext(), dependencies);
}

function createLifecycleService(currentSettings: () => { remoteType: string; activeConfigurationId?: string }) {
    let realiseSettings!: () => Promise<boolean>;
    const dependencies = {
        settingService: {
            currentSettings,
            onRealiseSetting: {
                addHandler: vi.fn((handler: () => Promise<boolean>) => {
                    realiseSettings = handler;
                }),
            },
        },
        appLifecycleService: {
            getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
            onSuspending: eventHook(),
        },
        databaseEventService: {
            onResetDatabase: eventHook(),
            onDatabaseInitialisation: eventHook(),
            onDatabaseInitialised: eventHook(),
            onDatabaseHasReady: eventHook(),
        },
    } as unknown as ReplicatorServiceDependencies;
    return {
        dependencies,
        realiseSettings: () => realiseSettings(),
        service: new TestReplicatorService(new ServiceContext(), dependencies),
    };
}

describe("ReplicatorService lifecycle", () => {
    function createInitialisingService(initialiseLocalNode: () => Promise<boolean>) {
        let realiseSettings!: () => Promise<boolean>;
        const closeReplication = vi.fn();
        const replicator = {
            initializeDatabaseForReplication: initialiseLocalNode,
            closeReplication,
        } as unknown as LiveSyncAbstractReplicator;
        const dependencies = {
            settingService: {
                currentSettings: () => ({
                    remoteType: REMOTE_COUCHDB,
                    couchDB_URI: "https://example.com",
                    couchDB_DBNAME: "vault",
                }),
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.getNewReplicator.addHandler(() => Promise.resolve(replicator));
        return { closeReplication, realiseSettings: () => realiseSettings(), replicator, service };
    }

    it("runs host preparation after candidate initialisation and before active publication", async () => {
        let realiseSettings!: () => Promise<boolean>;
        const initialiseLocalNode = vi.fn(async () => true);
        const initialisationOrder: string[] = [];
        let markPreparationStarted!: () => void;
        const preparationStarted = new Promise<void>((resolve) => {
            markPreparationStarted = resolve;
        });
        let releasePreparation!: () => void;
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        initialiseLocalNode.mockImplementation(async () => {
            initialisationOrder.push("local-node");
            return true;
        });
        const replicator = {
            initializeDatabaseForReplication: initialiseLocalNode,
        } as unknown as LiveSyncAbstractReplicator;
        const dependencies = {
            settingService: {
                currentSettings: () => ({
                    remoteType: REMOTE_COUCHDB,
                    couchDB_URI: "https://example.com",
                    couchDB_DBNAME: "vault",
                }),
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.getNewReplicator.addHandler(() => Promise.resolve(replicator));
        service.onBeforeReplicatorPublication.addHandler(async () => {
            initialisationOrder.push("host-handlers");
            expect(service.getActiveReplicatorContext()).toBeUndefined();
            markPreparationStarted();
            await preparationGate;
            return true;
        });

        const initialisation = realiseSettings();
        await preparationStarted;

        expect(service.getActiveReplicatorContext()).toBeUndefined();
        let acquisitionSettled = false;
        const acquisition = service.acquireActiveReplicatorContext().then((context) => {
            acquisitionSettled = true;
            return context;
        });
        await Promise.resolve();
        expect(acquisitionSettled).toBe(false);

        releasePreparation();
        await expect(initialisation).resolves.toBe(true);
        await expect(acquisition).resolves.toBeUndefined();

        expect(initialiseLocalNode).toHaveBeenCalledOnce();
        expect(initialisationOrder).toEqual(["local-node", "host-handlers"]);
        expect(service.getActiveReplicator()).toBe(replicator);
    });

    it("closes and forgets a new replicator when local-node initialisation is rejected", async () => {
        const { closeReplication, realiseSettings, service } = createInitialisingService(async () => false);

        await expect(realiseSettings()).resolves.toBe(false);

        expect(closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicator()).toBeUndefined();
    });

    it("closes and forgets a new replicator before propagating a local-node initialisation error", async () => {
        const error = new Error("node information could not be written");
        const { closeReplication, realiseSettings, service } = createInitialisingService(async () =>
            Promise.reject(error)
        );

        await expect(realiseSettings()).rejects.toBe(error);

        expect(closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicator()).toBeUndefined();
    });

    it("selects a composed provider for configuration and construction", async () => {
        let realiseSettings!: () => Promise<boolean>;
        const legacyReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const providerReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => providerReplicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => ({ remoteType: REMOTE_MINIO }),
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        const legacyFactory = vi.fn(async () => legacyReplicator);
        service.getNewReplicator.addHandler(legacyFactory);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(realiseSettings()).resolves.toBe(true);

        expect(definition.isConfigured).toHaveBeenCalled();
        expect(definition.create).toHaveBeenCalledOnce();
        expect(legacyFactory).not.toHaveBeenCalled();
        expect(service.getActiveReplicator()).toBe(providerReplicator);
        expect(service.getActiveReplicatorContext()).toEqual({
            provider: definition,
            replicator: providerReplicator,
        });

        const conflictingDefinition = { ...definition, diagnosticName: "Other Object Storage" };
        expect(() =>
            service.registerReplicatorProviderDefinitions(
                defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, {
                    [REMOTE_MINIO]: conflictingDefinition,
                })
            )
        ).toThrow("already composed");
    });

    it("does not construct a provider when its definition rejects the settings", async () => {
        let realiseSettings!: () => Promise<boolean>;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => false),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => {
                throw new Error("must not be constructed");
            }),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => ({ remoteType: REMOTE_MINIO }),
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(realiseSettings()).resolves.toBe(true);
        expect(definition.isConfigured).toHaveBeenCalledOnce();
        expect(definition.create).not.toHaveBeenCalled();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("keeps the active provider when a same-kind identity is unchanged", async () => {
        let currentSettings: { remoteType: string; activeConfigurationId: string; displayName?: string } = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        const replicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => replicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => currentSettings);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await realiseSettings();
        currentSettings = { ...currentSettings, displayName: "renamed" };
        await realiseSettings();

        expect(definition.create).toHaveBeenCalledOnce();
        expect(replicator.closeReplication).not.toHaveBeenCalled();
        expect(service.getActiveReplicatorContext()).toEqual({ provider: definition, replicator });
    });

    it("rebinds the active instance for an identity change and publishes it only after rebind", async () => {
        let currentSettings: { remoteType: string; activeConfigurationId: string } = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        let resolveRebind!: () => void;
        const rebindGate = new Promise<void>((resolve) => {
            resolveRebind = resolve;
        });
        const replicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const rebind = vi.fn(async () => await rebindGate);
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: { kind: "rebind", rebind },
            create: vi.fn(async () => replicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => currentSettings);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await realiseSettings();
        currentSettings = { remoteType: REMOTE_MINIO, activeConfigurationId: "profile-b" };
        const rebinding = realiseSettings();
        await vi.waitFor(() => expect(rebind).toHaveBeenCalledOnce());

        expect(service.getActiveReplicatorContext()).toBeUndefined();
        let rebindingSettled = false;
        void rebinding.then(() => {
            rebindingSettled = true;
        });
        await Promise.resolve();
        expect(rebindingSettled).toBe(false);
        expect(rebind).toHaveBeenCalledWith(
            replicator,
            expect.objectContaining({ activeConfigurationId: "profile-b" })
        );

        resolveRebind();
        await expect(rebinding).resolves.toBe(true);

        expect(definition.create).toHaveBeenCalledOnce();
        expect(replicator.closeReplication).not.toHaveBeenCalled();
        expect(service.getActiveReplicatorContext()).toEqual({ provider: definition, replicator });
    });

    it("waits for a replacement before acquiring the active context", async () => {
        let currentSettings: { remoteType: string; activeConfigurationId: string } = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        let resolveCandidate!: (replicator: LiveSyncAbstractReplicator) => void;
        const candidateGate = new Promise<LiveSyncAbstractReplicator>((resolve) => {
            resolveCandidate = resolve;
        });
        const oldReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const newReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi
                .fn()
                .mockResolvedValueOnce(oldReplicator)
                .mockImplementationOnce(async () => await candidateGate),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => currentSettings);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await realiseSettings();
        currentSettings = { remoteType: REMOTE_MINIO, activeConfigurationId: "profile-b" };
        const replacement = realiseSettings();
        await vi.waitFor(() => expect(definition.create).toHaveBeenCalledTimes(2));

        let acquisitionSettled = false;
        const acquisition = service.acquireActiveReplicatorContext().then((context) => {
            acquisitionSettled = true;
            return context;
        });
        await Promise.resolve();
        expect(acquisitionSettled).toBe(false);
        expect(service.getActiveReplicatorContext()).toBeUndefined();

        resolveCandidate(newReplicator);
        await expect(replacement).resolves.toBe(true);
        await expect(acquisition).resolves.toEqual({ provider: definition, replicator: newReplicator });
        expect(acquisitionSettled).toBe(true);
        expect(oldReplicator.closeReplication).toHaveBeenCalledOnce();
    });

    it("replaces the active provider when the selected same-kind profile changes", async () => {
        let currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        let realiseSettings!: () => Promise<boolean>;
        const oldReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const newReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn().mockResolvedValueOnce(oldReplicator).mockResolvedValueOnce(newReplicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => currentSettings,
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await realiseSettings();
        currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-b",
        };
        await realiseSettings();

        expect(definition.create).toHaveBeenCalledTimes(2);
        expect(definition.create).toHaveBeenLastCalledWith(
            expect.objectContaining({ activeConfigurationId: "profile-b" })
        );
        expect(oldReplicator.closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toEqual({ provider: definition, replicator: newReplicator });
    });

    it("does not publish a candidate whose selected profile changed while creation was pending", async () => {
        let currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        let realiseSettings!: () => Promise<boolean>;
        let resolveCandidate!: (replicator: LiveSyncAbstractReplicator) => void;
        const candidateGate = new Promise<LiveSyncAbstractReplicator>((resolve) => {
            resolveCandidate = resolve;
        });
        const staleReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => await candidateGate),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => currentSettings,
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        const initialisation = realiseSettings();
        await vi.waitFor(() => expect(definition.create).toHaveBeenCalledOnce());
        currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-b",
        };
        resolveCandidate(staleReplicator);
        await initialisation;

        expect(service.getActiveReplicatorContext()?.replicator).not.toBe(staleReplicator);
        expect(staleReplicator.closeReplication).toHaveBeenCalledOnce();
    });

    it("retires the active provider when its new configuration identity cannot be calculated", async () => {
        let currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        const identityError = new Error("configuration identity failed");
        const oldReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: vi.fn((setting) => {
                if (setting.activeConfigurationId === "profile-b") {
                    throw identityError;
                }
                return testConfigurationIdentity(setting);
            }),
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => oldReplicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => currentSettings);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(realiseSettings()).resolves.toBe(true);
        currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-b",
        };
        await expect(realiseSettings()).rejects.toBe(identityError);

        expect(oldReplicator.closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
        await expect(service.acquireActiveReplicatorContext()).resolves.toBeUndefined();
    });

    it("closes a candidate when the publication identity check throws", async () => {
        const identityError = new Error("publication identity failed");
        const candidate = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const configurationIdentity = vi
            .fn()
            .mockReturnValueOnce("profile-a")
            .mockImplementation(() => {
                throw identityError;
            });
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => candidate),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => ({
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        }));
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(realiseSettings()).rejects.toBe(identityError);

        expect(configurationIdentity).toHaveBeenCalledTimes(2);
        expect(candidate.closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("closes the active provider when its configuration is later rejected", async () => {
        let configured = true;
        let realiseSettings!: () => Promise<boolean>;
        const closeReplication = vi.fn();
        const replicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication,
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => configured),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => replicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => ({ remoteType: REMOTE_MINIO }),
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(realiseSettings()).resolves.toBe(true);
        configured = false;
        await expect(realiseSettings()).resolves.toBe(true);

        expect(closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicator()).toBeUndefined();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("fences the old active context before a replacement is closed", async () => {
        let currentSettings: { remoteType: string } = { remoteType: REMOTE_MINIO };
        let realiseSettings!: () => Promise<boolean>;
        let resolveClose!: () => void;
        const closeGate = new Promise<void>((resolve) => (resolveClose = resolve));
        let contextObservedDuringClose: ActiveReplicatorContext | undefined;
        const oldReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(() => {
                contextObservedDuringClose = service.getActiveReplicatorContext();
                return closeGate;
            }),
        } as unknown as LiveSyncAbstractReplicator;
        const newReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const minio: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => oldReplicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const couch: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: vi.fn(async () => newReplicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const dependencies = {
            settingService: {
                currentSettings: () => currentSettings,
                onRealiseSetting: {
                    addHandler: vi.fn((handler: () => Promise<boolean>) => {
                        realiseSettings = handler;
                    }),
                },
            },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending: eventHook(),
            },
            databaseEventService: {
                onResetDatabase: eventHook(),
                onDatabaseInitialisation: eventHook(),
                onDatabaseInitialised: eventHook(),
                onDatabaseHasReady: eventHook(),
            },
        } as unknown as ReplicatorServiceDependencies;
        const service = new TestReplicatorService(new ServiceContext(), dependencies);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_COUCHDB, REMOTE_MINIO] as const, {
                [REMOTE_COUCHDB]: couch,
                [REMOTE_MINIO]: minio,
            })
        );

        await expect(realiseSettings()).resolves.toBe(true);
        currentSettings = { remoteType: REMOTE_COUCHDB };
        const replacement = realiseSettings();
        await vi.waitFor(() => expect(oldReplicator.closeReplication).toHaveBeenCalledOnce());
        expect(contextObservedDuringClose).toBeUndefined();
        resolveClose();
        await expect(replacement).resolves.toBe(true);
        expect(service.getActiveReplicator()).toBe(newReplicator);
        expect(service.getActiveReplicatorContext()?.provider).toBe(couch);
    });
});

describe("ReplicatorService flow-specific resources", () => {
    it("resolves each supported resource from one catalogue without constructing or publishing an active Replicator", async () => {
        const service = createService();
        const settings = { remoteType: REMOTE_MINIO, endpoint: "https://objects.example", bucket: "vault" } as any;
        const connectionProbe = { dispose: vi.fn() };
        const preferredTweakProbe = { dispose: vi.fn() };
        const createConnectionProbe = vi.fn(async () => connectionProbe);
        const createPreferredTweakProbe = vi.fn(async () => preferredTweakProbe);
        const create = vi.fn(async () => {
            throw new Error("active construction must not run for a probe");
        });
        const definition = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create,
            remoteResources: {
                [REMOTE_RESOURCE_KINDS.CONNECTION]: supportedCapability(createConnectionProbe),
                [REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK]: supportedCapability(createPreferredTweakProbe),
                [REMOTE_RESOURCE_KINDS.SECURITY_SEED]: CAPABILITY_NOT_APPLICABLE,
                [REMOTE_RESOURCE_KINDS.SYNCHRONISATION_INFORMATION]: CAPABILITY_NOT_APPLICABLE,
            },
            remoteAdministration: CAPABILITY_NOT_APPLICABLE,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        } as any;
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(service.createRemoteResource(REMOTE_RESOURCE_KINDS.CONNECTION, settings)).resolves.toBe(
            connectionProbe
        );
        await expect(service.createRemoteResource(REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK, settings)).resolves.toBe(
            preferredTweakProbe
        );
        await expect(
            service.createRemoteResource(REMOTE_RESOURCE_KINDS.SECURITY_SEED, settings)
        ).resolves.toBeUndefined();

        expect(createConnectionProbe).toHaveBeenCalledWith(settings);
        expect(createPreferredTweakProbe).toHaveBeenCalledWith(settings);
        expect(create).not.toHaveBeenCalled();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });
});

describe("ReplicatorService bounded remote activity", () => {
    it("does not register application database lifecycle handlers for direct access", () => {
        const onRealiseSetting = eventHook();
        const onResetDatabase = eventHook();
        const onDatabaseInitialisation = eventHook();
        const onDatabaseInitialised = eventHook();
        const onDatabaseHasReady = eventHook();
        const onSuspending = eventHook();
        const dependencies = {
            settingService: { onRealiseSetting },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending,
            },
            databaseEventService: {
                onResetDatabase,
                onDatabaseInitialisation,
                onDatabaseInitialised,
                onDatabaseHasReady,
            },
            registerLifecycleHandlers: false,
        } as unknown as ReplicatorServiceDependencies;

        new TestReplicatorService(new ServiceContext(), dependencies);

        for (const hook of [
            onRealiseSetting,
            onResetDatabase,
            onDatabaseInitialisation,
            onDatabaseInitialised,
            onDatabaseHasReady,
            onSuspending,
        ]) {
            expect(hook.addHandler).not.toHaveBeenCalled();
        }
    });

    it("runs the task through an injected host activity policy", async () => {
        const run = vi.fn<(task: () => unknown, options?: AsyncActivityOptions) => void>();
        const service = createService({
            async run<T>(task: () => T | PromiseLike<T>, options?: AsyncActivityOptions) {
                run(task, options);
                return await task();
            },
        });

        await expect(
            service.runFiniteReplicationActivity(() => Promise.resolve("done"), { label: "replication" })
        ).resolves.toBe("done");

        expect(run).toHaveBeenCalledWith(expect.any(Function), { label: "replication" });
    });

    it("tracks overlapping bounded activities until each one settles", async () => {
        const service = createService();
        const observedCounts: number[] = [];
        const observedReplicationCounts: number[] = [];
        service.boundedRemoteActivityCount.onChanged((value) => observedCounts.push(value.value));
        service.finiteReplicationActivityCount.onChanged((value) => observedReplicationCounts.push(value.value));
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstGate = new Promise<void>((resolve) => (finishFirst = resolve));
        const secondGate = new Promise<void>((resolve) => (finishSecond = resolve));

        const first = service.runFiniteReplicationActivity(() => firstGate, { label: "replication" });
        const second = service.runBoundedRemoteActivity(() => secondGate, { label: "chunk-fetch" });

        expect(service.boundedRemoteActivityCount.value).toBe(2);
        expect(service.finiteReplicationActivityCount.value).toBe(1);
        finishFirst();
        await first;
        expect(service.boundedRemoteActivityCount.value).toBe(1);
        expect(service.finiteReplicationActivityCount.value).toBe(0);
        finishSecond();
        await second;

        expect(service.boundedRemoteActivityCount.value).toBe(0);
        expect(observedCounts).toEqual([1, 2, 1, 0]);
        expect(observedReplicationCounts).toEqual([1, 0]);
    });

    it("ends the activity when the bounded task rejects", async () => {
        const service = createService();

        await expect(
            service.runFiniteReplicationActivity(() => Promise.reject(new Error("network failed")), {
                label: "replication",
            })
        ).rejects.toThrow("network failed");

        expect(service.boundedRemoteActivityCount.value).toBe(0);
        expect(service.finiteReplicationActivityCount.value).toBe(0);
    });
});
