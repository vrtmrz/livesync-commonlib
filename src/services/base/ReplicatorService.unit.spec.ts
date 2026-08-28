import { describe, expect, it, vi } from "vitest";
import { ReplicatorService, type ReplicatorServiceDependencies } from "./ReplicatorService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import type { AsyncActivityOptions, AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
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

class TestReplicatorService extends ReplicatorService<ServiceContext> {}

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

    it("initialises local node information only when a replicator becomes active", async () => {
        let realiseSettings!: () => Promise<boolean>;
        const initialiseLocalNode = vi.fn(async () => true);
        const initialisationOrder: string[] = [];
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
        service.onReplicatorInitialised.addHandler(() => {
            initialisationOrder.push("host-handlers");
            return Promise.resolve(true);
        });

        await expect(realiseSettings()).resolves.toBe(true);

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
            create: vi.fn(async () => providerReplicator),
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

        expect(definition.isConfigured).toHaveBeenCalledOnce();
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
            create: vi.fn(async () => {
                throw new Error("must not be constructed");
            }),
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
            create: vi.fn(async () => replicator),
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
            create: vi.fn(async () => oldReplicator),
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
            create: vi.fn(async () => newReplicator),
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
