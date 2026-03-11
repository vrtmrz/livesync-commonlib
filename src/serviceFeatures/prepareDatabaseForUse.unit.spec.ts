import { describe, expect, it, vi } from "vitest";
import { usePrepareDatabaseForUse } from "./prepareDatabaseForUse";

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
