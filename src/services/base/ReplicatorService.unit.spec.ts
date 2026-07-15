import { describe, expect, it, vi } from "vitest";
import { ReplicatorService, type ReplicatorServiceDependencies } from "./ReplicatorService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import type { AsyncActivityOptions, AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner.ts";

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

describe("ReplicatorService bounded remote activity", () => {
    it("runs the task through an injected host activity policy", async () => {
        const run = vi.fn<(task: () => unknown, options?: AsyncActivityOptions) => void>();
        const service = createService({
            async run<T>(task: () => T | PromiseLike<T>, options?: AsyncActivityOptions) {
                run(task, options);
                return await task();
            },
        });

        await expect(
            service.runBoundedRemoteActivity(() => Promise.resolve("done"), { label: "replication" })
        ).resolves.toBe("done");

        expect(run).toHaveBeenCalledWith(expect.any(Function), { label: "replication" });
    });

    it("tracks overlapping bounded activities until each one settles", async () => {
        const service = createService();
        const observedCounts: number[] = [];
        service.boundedRemoteActivityCount.onChanged((value) => observedCounts.push(value.value));
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstGate = new Promise<void>((resolve) => (finishFirst = resolve));
        const secondGate = new Promise<void>((resolve) => (finishSecond = resolve));

        const first = service.runBoundedRemoteActivity(() => firstGate, { label: "replication" });
        const second = service.runBoundedRemoteActivity(() => secondGate, { label: "chunk-fetch" });

        expect(service.boundedRemoteActivityCount.value).toBe(2);
        finishFirst();
        await first;
        expect(service.boundedRemoteActivityCount.value).toBe(1);
        finishSecond();
        await second;

        expect(service.boundedRemoteActivityCount.value).toBe(0);
        expect(observedCounts).toEqual([1, 2, 1, 0]);
    });

    it("ends the activity when the bounded task rejects", async () => {
        const service = createService();

        await expect(
            service.runBoundedRemoteActivity(() => Promise.reject(new Error("network failed")))
        ).rejects.toThrow("network failed");

        expect(service.boundedRemoteActivityCount.value).toBe(0);
    });
});
