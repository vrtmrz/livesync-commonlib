import { describe, expect, it, vi } from "vitest";
import { ReplicatorService, type ReplicatorServiceDependencies } from "./ReplicatorService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import type { AsyncActivityOptions, AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner.ts";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";

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
