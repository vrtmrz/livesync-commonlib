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
    it("reports failed unload preparation after completing resource cleanup", async () => {
        const close = vi.fn(async () => {});
        const onAppUnload = vi.fn(async () => []);
        const onUnload = vi.fn(async () => true);
        const service = new ControlService(new ServiceContext(), {
            appLifecycleService: {
                onLoaded: { addHandler: vi.fn() },
                onBeforeUnload: vi.fn(async () => false),
                onAppUnload,
                onUnload,
            },
            databaseService: { localDatabaseDirect: { onunload: vi.fn(), close } },
            APIService: { addLog: vi.fn() },
        } as unknown as ControlServiceDependencies);
        await expect(service.onUnload()).rejects.toThrow("Unload preparation failed");
        expect(onAppUnload).toHaveBeenCalledOnce();
        expect(onUnload).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

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


describe("ControlService local completion", () => {
    function createService(commit: () => Promise<boolean>) {
        const dependencies = {
            appLifecycleService: {
                onLoaded: { addHandler: vi.fn() },
                onSuspending: vi.fn(async () => true),
                isSuspended: vi.fn(() => false),
                onResuming: vi.fn(async () => true),
                onResumed: vi.fn(async () => true),
            },
            settingService: {
                onBeforeRealiseSetting: vi.fn(async () => true),
                onRealiseSetting: vi.fn(async () => true),
                onSettingRealised: vi.fn(async () => true),
            },
            databaseService: { localDatabase: { refreshSettings: vi.fn() } },
            fileProcessingService: { commitPendingFileEvents: vi.fn(commit) },
            APIService: { addLog: vi.fn() },
        };
        const service = new ControlService(new ServiceContext(), dependencies as unknown as ControlServiceDependencies);
        return { service, dependencies };
    }

    it("does not realise settings or resume after local file processing fails", async () => {
        const { service, dependencies } = createService(async () => false);
        await expect(service.applySettings()).rejects.toThrow();
        expect(dependencies.settingService.onRealiseSetting).not.toHaveBeenCalled();
        expect(dependencies.appLifecycleService.onResuming).not.toHaveBeenCalled();
        expect(dependencies.settingService.onSettingRealised).not.toHaveBeenCalled();
    });

    it("waits for local processing before resuming settings", async () => {
        let complete!: (result: boolean) => void;
        const pending = new Promise<boolean>((resolve) => { complete = resolve; });
        const { service, dependencies } = createService(() => pending);
        const applying = service.applySettings();
        try {
            await vi.waitFor(() => expect(dependencies.fileProcessingService.commitPendingFileEvents).toHaveBeenCalled());
            expect(dependencies.settingService.onRealiseSetting).not.toHaveBeenCalled();
        } finally {
            complete(true);
            await applying;
        }
        expect(dependencies.appLifecycleService.onResuming).toHaveBeenCalledOnce();
    });
});
