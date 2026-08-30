import { describe, expect, it, vi } from "vitest";
import { ReplicatorService, type ReplicatorServiceDependencies } from "./ReplicatorService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import type { AsyncActivityOptions, AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
import { defaultLogger, LOG_LEVEL_INFO, setGlobalLogFunction } from "@lib/common/logger.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    defineReplicatorProviderDefinitions,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    supportedStopActiveTransfer,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import type { ActiveReplicatorContext } from "@lib/replication/ReplicatorProvider.ts";
import {
    NO_REMOTE_RESOURCE_CAPABILITIES,
    CENTRAL_REMOTE_ADMINISTRATION_ACTIONS,
    REMOTE_RESOURCE_KINDS,
    supportedCapability,
    type PreferredTweakProbe,
} from "@lib/replication";

class TestReplicatorService extends ReplicatorService<ServiceContext> {
    /** Test-only non-owning observation; production callers must acquire a reservation. */
    getActiveReplicatorContext(): ActiveReplicatorContext | undefined {
        return this.inspectActiveReplicatorContext();
    }
}

const testConfigurationIdentity = (setting: { activeConfigurationId?: string; remoteType: string }) =>
    setting.activeConfigurationId || setting.remoteType;

const NO_TEST_REMOTE_OPERATIONS = {
    remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
} as const;

function eventHook() {
    return { addHandler: vi.fn() };
}

function captureGlobalLogs() {
    const entries: Array<{ message: unknown; level?: number; key?: string }> = [];
    setGlobalLogFunction((message, level, key) => entries.push({ message, level, key }));
    return {
        entries,
        restore: () => setGlobalLogFunction(defaultLogger),
    };
}

function infoMessages(entries: Array<{ message: unknown; level?: number }>): string[] {
    return entries.filter((entry) => entry.level === LOG_LEVEL_INFO).map((entry) => String(entry.message));
}

function createService(activityRunner?: AsyncActivityRunner) {
    const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), eventHook());
    const dependencies = {
        settingService: {
            onRealiseSetting: eventHook(),
        },
        appLifecycleService: {
            getUnresolvedMessages,
            onUnload: eventHook(),
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
    let suspendReplication: () => Promise<boolean> = async () => true;
    let unloadReplicator: () => Promise<boolean> = async () => true;
    const onSuspending = {
        addHandler: vi.fn((handler: () => Promise<boolean>) => {
            suspendReplication = handler;
        }),
    };
    const onUnload = {
        addHandler: vi.fn((handler: () => Promise<boolean>) => {
            unloadReplicator = handler;
        }),
    };
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
            onSuspending,
            onUnload,
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
        onUnload,
        realiseSettings: () => realiseSettings(),
        service: new TestReplicatorService(new ServiceContext(), dependencies),
        suspendReplication: () => suspendReplication(),
        unloadReplicator: () => unloadReplicator(),
    };
}

function createProviderFixture(
    currentSettings: () => { remoteType: string; activeConfigurationId?: string },
    configurationIdentity: ReplicatorProviderDefinition<
        typeof REMOTE_COUCHDB
    >["configurationIdentity"] = testConfigurationIdentity
) {
    const replicator = {
        initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
        terminateSync: vi.fn(),
        closeReplication: vi.fn(),
    } as unknown as LiveSyncAbstractReplicator;
    const definition: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
        kind: REMOTE_COUCHDB,
        diagnosticName: "CouchDB",
        readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
        isConfigured: vi.fn(() => true),
        configurationIdentity,
        create: vi.fn().mockResolvedValue(replicator),
        remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
        userInitiatedOneShot: supportedOpenReplicationOneShot(),
        unattendedOneShot: supportedOpenReplicationUnattended(),
        continuous: supportedOpenReplicationContinuous(),
        stopActiveTransfer: supportedStopActiveTransfer(),
    };
    const lifecycle = createLifecycleService(currentSettings);
    lifecycle.service.registerReplicatorProviderDefinitions(
        defineReplicatorProviderDefinitions([REMOTE_COUCHDB] as const, { [REMOTE_COUCHDB]: definition })
    );
    return { ...lifecycle, definition, replicator };
}

describe("ReplicatorService lifecycle", () => {
    it("does not announce a database reset when no active publication exists", async () => {
        const service = createService();
        const logs = captureGlobalLogs();
        try {
            await expect(service.onCloseActiveReplication()).resolves.toBe(true);

            expect(infoMessages(logs.entries).some((message) => message.includes("database reset"))).toBe(false);
        } finally {
            logs.restore();
        }
    });

    it("does not announce a configuration closure when no active publication exists", async () => {
        const lifecycle = createLifecycleService(() => ({
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "profile-a",
        }));
        const logs = captureGlobalLogs();
        try {
            await expect(lifecycle.realiseSettings()).resolves.toBe(false);

            expect(infoMessages(logs.entries).some((message) => message.includes("Configuration changed"))).toBe(false);
        } finally {
            logs.restore();
        }
    });

    it("does not label application unload as a database reset", async () => {
        const currentSettings = {
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "profile-a",
        };
        const lifecycle = createProviderFixture(() => currentSettings);
        await lifecycle.realiseSettings();

        const logs = captureGlobalLogs();
        try {
            await expect(lifecycle.unloadReplicator()).resolves.toBe(true);

            expect(infoMessages(logs.entries).some((message) => message.includes("database reset"))).toBe(false);
        } finally {
            logs.restore();
        }
    });

    function createInitialisingService() {
        let realiseSettings!: () => Promise<boolean>;
        const initializeDatabaseForReplication = vi.fn().mockResolvedValue(true);
        const closeReplication = vi.fn();
        const replicator = {
            initializeDatabaseForReplication,
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
                onUnload: eventHook(),
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
        return {
            closeReplication,
            initializeDatabaseForReplication,
            realiseSettings: () => realiseSettings(),
            replicator,
            service,
        };
    }

    it("initialises a candidate local node before publication", async () => {
        const { initializeDatabaseForReplication, realiseSettings, replicator, service } = createInitialisingService();

        await expect(realiseSettings()).resolves.toBe(true);

        expect(initializeDatabaseForReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicator()).toBe(replicator);
    });

    it("disposes a candidate when local-node initialisation fails", async () => {
        const { closeReplication, initializeDatabaseForReplication, realiseSettings, service } =
            createInitialisingService();
        initializeDatabaseForReplication.mockResolvedValue(false);

        await expect(realiseSettings()).resolves.toBe(false);

        expect(initializeDatabaseForReplication).toHaveBeenCalledOnce();
        expect(closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("disposes a candidate when local-node initialisation throws", async () => {
        const { closeReplication, initializeDatabaseForReplication, realiseSettings, service } =
            createInitialisingService();
        const initialisationError = new Error("local-node initialisation failed");
        initializeDatabaseForReplication.mockRejectedValue(initialisationError);

        await expect(realiseSettings()).rejects.toBe(initialisationError);

        expect(initializeDatabaseForReplication).toHaveBeenCalledOnce();
        expect(closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("orders suspension as a reversible transfer stop without retiring the publication", async () => {
        const currentSettings = { remoteType: REMOTE_COUCHDB, activeConfigurationId: "profile-a" };
        const terminateSync = vi.fn();
        const closeReplication = vi.fn();
        const replicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            terminateSync,
            closeReplication,
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: testConfigurationIdentity,
            create: vi.fn(async () => replicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const lifecycle = createLifecycleService(() => currentSettings);
        lifecycle.service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_COUCHDB] as const, { [REMOTE_COUCHDB]: definition })
        );
        await lifecycle.realiseSettings();
        const context = lifecycle.service.getActiveReplicatorContext();
        let releaseUse!: () => void;
        const useGate = new Promise<void>((resolve) => {
            releaseUse = resolve;
        });
        let markUseStarted!: () => void;
        const useStarted = new Promise<void>((resolve) => {
            markUseStarted = resolve;
        });
        const activeUse = lifecycle.service.runWithActiveReplicatorContext(async () => {
            markUseStarted();
            await useGate;
        });
        await useStarted;

        try {
            await expect(lifecycle.suspendReplication()).resolves.toBe(true);

            expect(terminateSync).toHaveBeenCalledOnce();
            expect(closeReplication).not.toHaveBeenCalled();
            expect(lifecycle.service.getActiveReplicatorContext()).toBe(context);
        } finally {
            releaseUse();
        }
        await activeUse;
    });

    it("registers unload as terminal quiescing disposal without publishing a replacement", async () => {
        const currentSettings = {
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "profile-a",
        };
        const terminateSync = vi.fn();
        const closeReplication = vi.fn();
        const replicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            terminateSync,
            closeReplication,
        } as unknown as LiveSyncAbstractReplicator;
        const definition: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: testConfigurationIdentity,
            create: vi.fn(async () => replicator),
            ...NO_TEST_REMOTE_OPERATIONS,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const lifecycle = createLifecycleService(() => currentSettings);
        lifecycle.service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_COUCHDB] as const, { [REMOTE_COUCHDB]: definition })
        );
        await lifecycle.realiseSettings();
        let releaseUse!: () => void;
        const useGate = new Promise<void>((resolve) => {
            releaseUse = resolve;
        });
        let markUseStarted!: () => void;
        const useStarted = new Promise<void>((resolve) => {
            markUseStarted = resolve;
        });
        const activeUse = lifecycle.service.runWithActiveReplicatorContext(async () => {
            markUseStarted();
            await useGate;
        });
        await useStarted;
        let unloadSettled = false;
        const unload = lifecycle.unloadReplicator().then((result) => {
            unloadSettled = true;
            return result;
        });
        for (let turn = 0; turn < 5; turn++) await Promise.resolve();

        try {
            expect(lifecycle.onUnload.addHandler).toHaveBeenCalledOnce();
            expect(lifecycle.service.getActiveReplicatorContext()).toBeUndefined();
            expect(terminateSync).toHaveBeenCalledOnce();
            expect(closeReplication).not.toHaveBeenCalled();
            expect(unloadSettled).toBe(false);
        } finally {
            releaseUse();
        }
        await activeUse;
        await expect(unload).resolves.toBe(true);

        expect(closeReplication).toHaveBeenCalledOnce();
        expect(lifecycle.service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("shares terminal owner commands while draining an admitted active callback", async () => {
        const currentSettings = { remoteType: REMOTE_COUCHDB, activeConfigurationId: "profile-a" };
        const { realiseSettings, replicator, service } = createProviderFixture(() => currentSettings);
        await realiseSettings();
        let releaseUse!: () => void;
        const useGate = new Promise<void>((resolve) => {
            releaseUse = resolve;
        });
        let markUseStarted!: () => void;
        const useStarted = new Promise<void>((resolve) => {
            markUseStarted = resolve;
        });
        const activeUse = service.runWithActiveReplicatorContext(async () => {
            markUseStarted();
            await useGate;
        });
        await useStarted;

        const firstRetirement = service.onCloseActiveReplication();
        const duplicateRetirement = service.onCloseActiveReplication();

        try {
            await vi.waitFor(() => expect(service.getActiveReplicatorContext()).toBeUndefined());
            expect(replicator.terminateSync).toHaveBeenCalledOnce();
            expect(replicator.closeReplication).not.toHaveBeenCalled();
        } finally {
            releaseUse();
        }
        await activeUse;
        await expect(Promise.all([firstRetirement, duplicateRetirement])).resolves.toEqual([true, true]);

        expect(replicator.closeReplication).toHaveBeenCalledOnce();
        expect(service.getActiveReplicatorContext()).toBeUndefined();
    });

    it("runs host preparation before active publication", async () => {
        let realiseSettings!: () => Promise<boolean>;
        const initialisationOrder: string[] = [];
        let markPreparationStarted!: () => void;
        const preparationStarted = new Promise<void>((resolve) => {
            markPreparationStarted = resolve;
        });
        let releasePreparation!: () => void;
        const preparationGate = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        const replicator = {
            initializeDatabaseForReplication: vi.fn(async () => {
                initialisationOrder.push("local-node");
                return true;
            }),
            closeReplication: vi.fn(),
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
                onUnload: eventHook(),
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

        expect(initialisationOrder).toEqual(["local-node", "host-handlers"]);
        expect(service.getActiveReplicator()).toBe(replicator);
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
                onUnload: eventHook(),
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
                onUnload: eventHook(),
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
        const currentContext = service.getActiveReplicatorContext();
        expect(currentContext).toBeDefined();

        currentSettings = { ...currentSettings, displayName: "renamed" };
        await realiseSettings();

        expect(definition.create).toHaveBeenCalledOnce();
        expect(replicator.closeReplication).not.toHaveBeenCalled();
        expect(service.getActiveReplicatorContext()).toEqual({ provider: definition, replicator });
        expect(service.getActiveReplicatorContext()).toBe(currentContext);
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

    it("waits for rejecting remote administration before replacing its publication", async () => {
        let currentSettings: { remoteType: string; activeConfigurationId: string } = {
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "profile-a",
        };
        let markAdministrationStarted!: () => void;
        const administrationStarted = new Promise<void>((resolve) => {
            markAdministrationStarted = resolve;
        });
        let rejectAdministration!: () => void;
        const administrationGate = new Promise<void>((resolve) => {
            rejectAdministration = resolve;
        });
        let resolveClose!: () => void;
        const closeGate = new Promise<void>((resolve) => {
            resolveClose = resolve;
        });
        const oldReplicator = {
            nodeid: "node-1",
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            terminateSync: vi.fn(),
            closeReplication: vi.fn(async () => await closeGate),
            markRemoteResolved: vi.fn().mockResolvedValue(undefined),
            markRemoteLocked: vi.fn().mockResolvedValue(undefined),
        } as unknown as LiveSyncAbstractReplicator;
        const newReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            closeReplication: vi.fn(),
        } as unknown as LiveSyncAbstractReplicator;
        const lock = vi.fn(async () => {
            markAdministrationStarted();
            await administrationGate;
            throw new Error("administration failed");
        });
        const definition: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            create: vi.fn().mockResolvedValueOnce(oldReplicator).mockResolvedValueOnce(newReplicator),
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            centralRemoteAdministration: supportedCapability(lock),
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const { realiseSettings, service } = createLifecycleService(() => currentSettings);
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_COUCHDB] as const, { [REMOTE_COUCHDB]: definition })
        );

        await realiseSettings();
        const administration = service.runCentralRemoteAdministration({
            action: CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK,
        });
        void administration.catch(() => undefined);
        await administrationStarted;

        currentSettings = { remoteType: REMOTE_COUCHDB, activeConfigurationId: "profile-b" };
        const replacement = realiseSettings();

        try {
            await vi.waitFor(() => expect(service.getActiveReplicatorContext()).toBeUndefined());
            expect(oldReplicator.terminateSync).toHaveBeenCalledOnce();
            expect(oldReplicator.closeReplication).not.toHaveBeenCalled();

            rejectAdministration();
            await expect(administration).rejects.toThrow("administration failed");
            await vi.waitFor(() => expect(oldReplicator.closeReplication).toHaveBeenCalledOnce());

            resolveClose();
            await expect(replacement).resolves.toBe(true);
            expect(service.getActiveReplicator()).toBe(newReplicator);
        } finally {
            rejectAdministration();
            resolveClose();
            await Promise.allSettled([administration, replacement]);
        }
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
                onUnload: eventHook(),
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

    it("keeps a failed physical retirement fenced and retries it before replacement", async () => {
        let currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-a",
        };
        const closeError = new Error("close failed");
        const oldReplicator = {
            initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
            terminateSync: vi.fn(),
            closeReplication: vi.fn().mockRejectedValueOnce(closeError).mockResolvedValueOnce(undefined),
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
            create: vi.fn().mockResolvedValueOnce(oldReplicator).mockResolvedValueOnce(newReplicator),
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
        currentSettings = {
            remoteType: REMOTE_MINIO,
            activeConfigurationId: "profile-b",
        };

        await expect(realiseSettings()).rejects.toBe(closeError);
        expect(service.getActiveReplicatorContext()).toBeUndefined();
        expect(definition.create).toHaveBeenCalledOnce();

        await expect(realiseSettings()).resolves.toBe(true);
        expect(oldReplicator.terminateSync).toHaveBeenCalledTimes(2);
        expect(oldReplicator.closeReplication).toHaveBeenCalledTimes(2);
        expect(definition.create).toHaveBeenCalledTimes(2);
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
                onUnload: eventHook(),
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
                onUnload: eventHook(),
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
                onUnload: eventHook(),
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
        const connectionResource = { dispose: vi.fn() };
        const preferredTweakResource = {
            read: vi.fn(),
            write: vi.fn(),
            dispose: vi.fn(),
        } satisfies PreferredTweakProbe;
        const createConnectionResource = vi.fn(async () => connectionResource);
        const createPreferredTweakProbe = vi.fn(async () => preferredTweakResource);
        const create = vi.fn(async () => {
            throw new Error("active construction must not run for a probe");
        });
        const definition = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: vi.fn(() => true),
            configurationIdentity: testConfigurationIdentity,
            create,
            remoteResources: {
                [REMOTE_RESOURCE_KINDS.CONNECTION]: supportedCapability(createConnectionResource),
                [REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK]: supportedCapability(createPreferredTweakProbe),
                [REMOTE_RESOURCE_KINDS.SECURITY_SEED]: CAPABILITY_NOT_APPLICABLE,
            },
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        } as any;
        service.registerReplicatorProviderDefinitions(
            defineReplicatorProviderDefinitions([REMOTE_MINIO] as const, { [REMOTE_MINIO]: definition })
        );

        await expect(service.createRemoteResource(REMOTE_RESOURCE_KINDS.CONNECTION, settings)).resolves.toBe(
            connectionResource
        );
        await expect(service.createRemoteResource(REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK, settings)).resolves.toBe(
            preferredTweakResource
        );
        await expect(
            service.createRemoteResource(REMOTE_RESOURCE_KINDS.SECURITY_SEED, settings)
        ).resolves.toBeUndefined();

        expect(createConnectionResource).toHaveBeenCalledWith(settings);
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
        const onUnload = eventHook();
        const dependencies = {
            settingService: { onRealiseSetting },
            appLifecycleService: {
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), eventHook()),
                onSuspending,
                onUnload,
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
            onUnload,
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
