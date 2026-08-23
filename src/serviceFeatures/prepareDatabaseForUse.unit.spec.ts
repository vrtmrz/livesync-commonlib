import { describe, expect, it, vi } from "vitest";
import { prepareDatabaseForUse, usePrepareDatabaseForUse } from "./prepareDatabaseForUse";
import { createServiceContext } from "@lib/services/base/ServiceBase";

const APIServiceMock = {
    addLog(message: string, level?: any) {
        console.log(`${message}`);
    },
};

describe("usePrepareDatabaseForUse", () => {
    // let logger: LogFunction;

    // beforeAll(() => {
    //     logger = createLogger("TestLogger");
    // });

    it("should bind handlers to lifecycle events", () => {
        const addHandlerMock1 = vi.fn();

        const host = {
            services: {
                context: createServiceContext(),
                API: APIServiceMock,
                appLifecycle: {
                    getUnresolvedMessages: {
                        addHandler: vi.fn(),
                    },
                },
                databaseEvents: {
                    initialiseDatabase: {
                        addHandler: addHandlerMock1,
                    },
                },
                vault: {
                    scanVault: {
                        addHandler: vi.fn(),
                    },
                },
            },
            serviceModules: {},
        } as any;

        usePrepareDatabaseForUse(host);
        expect(addHandlerMock1).toHaveBeenCalledWith(expect.any(Function));
    });
});

describe("prepareDatabaseForUse readiness", () => {
    function createPreparation({ scan = true, initialised = true, commit = true, physicalReady = true } = {}) {
        const timeline: string[] = [];
        let ready = true;
        const host = {
            services: {
                context: createServiceContext(),
                appLifecycle: {
                    resetIsReady: vi.fn(() => {
                        timeline.push("reset-ready");
                        ready = false;
                    }),
                    markIsReady: vi.fn(() => {
                        timeline.push("mark-ready");
                        ready = true;
                    }),
                },
                database: {
                    localDatabase: { isReady: physicalReady },
                    isDatabaseReady: vi.fn(() => physicalReady),
                    openDatabase: vi.fn(async () => {
                        timeline.push("open-database");
                        return true;
                    }),
                },
                vault: {
                    scanVault: vi.fn(async () => {
                        timeline.push("scan-vault");
                        return scan;
                    }),
                },
                databaseEvents: {
                    onDatabaseInitialised: vi.fn(async () => {
                        timeline.push("database-initialised");
                        return initialised;
                    }),
                },
                fileProcessing: {
                    commitPendingFileEvents: vi.fn(async () => {
                        timeline.push("commit-pending-events");
                        return commit;
                    }),
                },
            },
            serviceModules: {},
        } as any;
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };
        return { errorManager, host, isReady: () => ready, timeline };
    }

    it("marks the application ready only after the scan, post-scan hook, and current event batch succeed", async () => {
        const { errorManager, host, isReady, timeline } = createPreparation();

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).resolves.toBe(true);

        expect(isReady()).toBe(true);
        expect(timeline).toEqual([
            "reset-ready",
            "open-database",
            "scan-vault",
            "database-initialised",
            "commit-pending-events",
            "mark-ready",
        ]);
    });

    it("keeps the application unready when the Vault scan fails", async () => {
        const { errorManager, host, isReady } = createPreparation({ scan: false });

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).resolves.toBe(false);

        expect(isReady()).toBe(false);
        expect(host.services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(host.services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("keeps the application unready when the post-scan initialisation hook reports failure", async () => {
        const { errorManager, host, isReady } = createPreparation({ initialised: false });

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).resolves.toBe(false);

        expect(isReady()).toBe(false);
        expect(errorManager.showError).toHaveBeenCalled();
        expect(host.services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("keeps the application unready when the post-scan initialisation hook throws", async () => {
        const { errorManager, host, isReady } = createPreparation();
        const error = new Error("post-scan initialisation failed");
        host.services.databaseEvents.onDatabaseInitialised.mockRejectedValueOnce(error);

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).rejects.toBe(error);

        expect(isReady()).toBe(false);
        expect(host.services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("does not bypass a rejected physical database transition when reopening is skipped", async () => {
        const { errorManager, host, isReady } = createPreparation({ physicalReady: false });

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any, false, false)).resolves.toBe(false);

        expect(isReady()).toBe(false);
        expect(host.services.database.openDatabase).not.toHaveBeenCalled();
        expect(host.services.vault.scanVault).not.toHaveBeenCalled();
        expect(host.services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(host.services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("keeps the application unready when the current event batch cannot be released", async () => {
        const { errorManager, host, isReady } = createPreparation({ commit: false });

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).resolves.toBe(false);

        expect(isReady()).toBe(false);
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("keeps the application unready when releasing the current event batch throws", async () => {
        const { errorManager, host, isReady } = createPreparation();
        const error = new Error("queued event release failed");
        host.services.fileProcessing.commitPendingFileEvents.mockRejectedValueOnce(error);

        await expect(prepareDatabaseForUse(host, vi.fn(), errorManager as any)).rejects.toBe(error);

        expect(isReady()).toBe(false);
        expect(host.services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });
});
