import { describe, expect, it, vi } from "vitest";
import { ControlService, type ControlServiceDependencies } from "./ControlService.ts";
import { ServiceContext } from "./ServiceBase.ts";

vi.mock("octagonal-wheels/concurrency/task", () => ({
    cancelAllPeriodicTask: vi.fn(),
    cancelAllTasks: vi.fn(),
}));

vi.mock("octagonal-wheels/concurrency/processor", () => ({
    stopAllRunningProcessors: vi.fn(),
}));

describe("ControlService unload", () => {
    it("awaits lifecycle-owned Replicator retirement before closing the local database", async () => {
        const order: string[] = [];
        const closeReplication = vi.fn();
        const getActiveReplicator = vi.fn(() => ({ closeReplication }));
        const dependencies = {
            appLifecycleService: {
                onLoaded: { addHandler: vi.fn() },
                onBeforeUnload: vi.fn(async () => true),
                onAppUnload: vi.fn(async () => []),
                onUnload: vi.fn(async () => {
                    order.push("lifecycle-unload");
                    return true;
                }),
            },
            replicatorService: { getActiveReplicator },
            settingService: {},
            databaseService: {
                localDatabaseDirect: {
                    onunload: vi.fn(() => {
                        order.push("database-unload");
                    }),
                    close: vi.fn(async () => {
                        order.push("database-close");
                    }),
                },
            },
            fileProcessingService: {},
            APIService: { addLog: vi.fn() },
        } as unknown as ControlServiceDependencies;
        const service = new ControlService(new ServiceContext(), dependencies);

        await service.onUnload();

        expect(order).toEqual(["lifecycle-unload", "database-unload", "database-close"]);
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(closeReplication).not.toHaveBeenCalled();
    });
});
