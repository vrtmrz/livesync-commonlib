import { describe, it, expect, beforeAll, vi } from "vitest";

import {
    onNotifyRemoteSizeNotConfiguredFactory,
    onNotifyRemoteSizeExceedFactory,
    scanAllStat,
    useCheckRemoteSize,
} from "./checkRemoteSize";
import { type LogFunction, createInstanceLogFunction } from "@lib/services/lib/logUtils";
import { $msg } from "../common/i18n";
import { eventHub } from "../hub/hub";
import { EVENT_REQUEST_CHECK_REMOTE_SIZE } from "../events/coreEvents";

const APIServiceMock = {
    addLog(message: string, level?: any) {
        console.log(`${message}`);
    },
};

function createLogger(name: string): LogFunction {
    return createInstanceLogFunction(name, APIServiceMock as any);
}

describe("onNotifyRemoteSizeNotConfigured", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should return true if threshold is already configured", async () => {
        const mockAPI = {
            isOnline: true,
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800,
                };
            },
        };

        const host = {
            services: {
                API: mockAPI,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeNotConfiguredFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
    });

    const ANSWER_0 = $msg("moduleCheckRemoteSize.optionNoWarn");
    const ANSWER_800 = $msg("moduleCheckRemoteSize.option800MB");
    const ANSWER_2000 = $msg("moduleCheckRemoteSize.option2GB");
    const ASK_ME_NEXT_TIME = $msg("moduleCheckRemoteSize.optionAskMeLater");
    const expectedResults = {
        [ANSWER_0]: 0,
        [ANSWER_800]: 800,
        [ANSWER_2000]: 2000,
        [ASK_ME_NEXT_TIME]: -1, // Assuming ASK_ME_NEXT_TIME does not change the setting
    };
    const initialSettings = {
        notifyThresholdOfRemoteStorageSize: -1,
    };
    it.each([ANSWER_0, ANSWER_800, ANSWER_2000, ASK_ME_NEXT_TIME])(
        "should show dialogue and apply settings when user selects option %s",
        async (selectedOption) => {
            const mockAPI = {
                isOnline: true,
                confirm: {
                    askSelectStringDialogue: vi.fn().mockResolvedValue(selectedOption),
                },
            };

            let appliedSettings = {
                ...initialSettings,
            };

            const mockSetting = {
                currentSettings() {
                    return appliedSettings;
                },
                applyPartial: vi.fn(async (settings) => {
                    appliedSettings = settings;
                    return await Promise.resolve(true);
                }),
            };

            const host = {
                services: {
                    API: mockAPI,
                    setting: mockSetting,
                },
                serviceModules: {},
            } as any;

            // We need to mock the actual dialogue call to return a value that matches one of the options
            // Since $msg is called inside the handler, we need to match the actual implementation
            // In this case, we just verify that the handler completes successfully
            const handler = onNotifyRemoteSizeNotConfiguredFactory(host, logger);
            const result = await handler();

            expect(result).toBe(true);
            expect(mockAPI.confirm.askSelectStringDialogue).toHaveBeenCalled();
            expect(appliedSettings.notifyThresholdOfRemoteStorageSize).toBe(expectedResults[selectedOption]);
        }
    );
});

describe("onNotifyRemoteSizeExceed", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should skip check when network is offline", async () => {
        const mockAPI = {
            isOnline: false,
        };

        const mockReplicator = {
            getActiveReplicator: () => null,
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800,
                };
            },
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
    });

    it("should return true if remote status cannot be obtained", async () => {
        const mockAPI = {
            isOnline: true,
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue(null),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800,
                };
            },
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
    });

    it("should return true if size is within threshold", async () => {
        const mockAPI = {
            isOnline: true,
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: 500 * 1024 * 1024, // 500 MB
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800, // 800 MB
                };
            },
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
    });

    const testEstimatedSize = 1000 * 1024 * 1024; // 1000 MB
    const newMax = ~~(testEstimatedSize / 1024 / 1024) + 100; // Same calculation as in the handler
    const ANSWER_ENLARGE_LIMIT = $msg("moduleCheckRemoteSize.optionIncreaseLimit", {
        newMax: newMax.toString(),
    });
    const ANSWER_REBUILD = $msg("moduleCheckRemoteSize.optionRebuildAll");
    const ANSWER_IGNORE = $msg("moduleCheckRemoteSize.optionDismiss");
    const expectedResults = {
        [ANSWER_ENLARGE_LIMIT]: {
            notifyThresholdOfRemoteStorageSize: newMax,
            result: true,
        },
        [ANSWER_IGNORE]: {
            notifyThresholdOfRemoteStorageSize: 800, // Assuming it does not change the setting immediately
            result: true,
        },
        // [ANSWER_REBUILD]: {
        //     notifyThresholdOfRemoteStorageSize: 800, // Assuming it does not change the setting immediately
        //     result: true,
        // }
    };
    it.each(Object.keys(expectedResults))("should show dialogue when size exceeds threshold:%s", async (key) => {
        const mockAPI = {
            isOnline: true,
            confirm: {
                askSelectStringDialogue: vi.fn().mockResolvedValue(key),
            },
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: testEstimatedSize, // 1000 MB - exceeds threshold
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };
        const initialSettings = {
            notifyThresholdOfRemoteStorageSize: 800,
        };

        let appliedSettings = {
            ...initialSettings,
        };

        const mockSetting = {
            currentSettings() {
                return appliedSettings;
            },
            applyPartial: vi.fn(async (settings) => {
                appliedSettings = settings;
                return await Promise.resolve(true);
            }),
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        // The API confirm method should be called when size exceeds threshold
        expect(mockAPI.confirm.askSelectStringDialogue).toHaveBeenCalled();
        expect(result).toBe(true);
        expect(appliedSettings.notifyThresholdOfRemoteStorageSize).toBe(
            expectedResults[key].notifyThresholdOfRemoteStorageSize
        );
    });
    const rebuildExpectedResults = {
        yes: {
            notifyThresholdOfRemoteStorageSize: -1,
            result: false, // Assuming the handler returns false after scheduling rebuild
        },
        no: {
            notifyThresholdOfRemoteStorageSize: 800, // Assuming it does not change the setting immediately
            result: true,
        },
    };
    it.each(["yes", "no"])("should handle user selecting rebuild option:%s", async (answer) => {
        const mockAPI = {
            isOnline: true,
            confirm: {
                askSelectStringDialogue: vi.fn().mockResolvedValue(ANSWER_REBUILD),
                askYesNoDialog: vi.fn().mockResolvedValue(answer),
            },
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: testEstimatedSize, // 1000 MB - exceeds threshold
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };
        const initialSettings = {
            notifyThresholdOfRemoteStorageSize: 800,
        };

        let appliedSettings = {
            ...initialSettings,
        };

        const mockSetting = {
            currentSettings() {
                return appliedSettings;
            },
            applyPartial: vi.fn(async (settings) => {
                appliedSettings = settings;
                return await Promise.resolve(true);
            }),
        };
        const rebuilderMock = {
            scheduleRebuild: vi.fn().mockResolvedValue(true),
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {
                rebuilder: rebuilderMock,
            },
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        // The API confirm method should be called when size exceeds threshold
        expect(mockAPI.confirm.askSelectStringDialogue).toHaveBeenCalled();
        expect(result).toBe(rebuildExpectedResults[answer as keyof typeof rebuildExpectedResults].result);
        if (result === false) {
            expect(rebuilderMock.scheduleRebuild).toHaveBeenCalled();
        }
        expect(appliedSettings.notifyThresholdOfRemoteStorageSize).toBe(
            rebuildExpectedResults[answer as keyof typeof rebuildExpectedResults].notifyThresholdOfRemoteStorageSize
        );
    });
    it("should handle user dialogue responses correctly", async () => {
        // Since the implementation uses $msg() to create the answer values,
        // and we cannot easily mock $msg in the test, we verify that the dialogue is called
        // and the handler completes successfully
        const mockAPI = {
            isOnline: true,
            confirm: {
                askSelectStringDialogue: vi.fn().mockResolvedValue("ignored_value"), // Any value will trigger the Dismiss/Close path
            },
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: 1000 * 1024 * 1024, // 1000 MB
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800, // 800 MB
                };
            },
            applyPartial: vi.fn().mockResolvedValue(true),
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {},
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
        expect(mockAPI.confirm.askSelectStringDialogue).toHaveBeenCalled();
    });

    it("should verify rebuild path is handled", async () => {
        // To properly test rebuild path, we would need to mock $msg()
        // For now, we just verify that the handler processes the scenario correctly
        const mockAPI = {
            isOnline: true,
            confirm: {
                askSelectStringDialogue: vi.fn().mockResolvedValue("unknown"),
                askYesNoDialog: vi.fn().mockResolvedValue("no"),
            },
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: 1000 * 1024 * 1024, // 1000 MB - exceeds threshold
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };

        const mockRebuilder = {
            scheduleRebuild: vi.fn().mockResolvedValue(true),
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800, // 800 MB
                };
            },
            applyPartial: vi.fn().mockResolvedValue(true),
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {
                rebuilder: mockRebuilder,
            },
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
        expect(mockAPI.confirm.askSelectStringDialogue).toHaveBeenCalled();
    });

    it("should not trigger rebuild when user cancels", async () => {
        const mockAPI = {
            isOnline: true,
            confirm: {
                askSelectStringDialogue: vi.fn().mockResolvedValue("some_other_value"),
            },
        };

        const mockActiveReplicator = {
            getRemoteStatus: vi.fn().mockResolvedValue({
                estimatedSize: 1000 * 1024 * 1024, // 1000 MB
            }),
        };

        const mockReplicator = {
            getActiveReplicator: () => mockActiveReplicator,
        };

        const mockRebuilder = {
            scheduleRebuild: vi.fn(),
        };

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800, // 800 MB
                };
            },
            applyPartial: vi.fn().mockResolvedValue(true),
        };

        const host = {
            services: {
                API: mockAPI,
                replicator: mockReplicator,
                setting: mockSetting,
            },
            serviceModules: {
                rebuilder: mockRebuilder,
            },
        } as any;

        const handler = onNotifyRemoteSizeExceedFactory(host, logger);
        const result = await handler();

        expect(result).toBe(true);
        expect(mockRebuilder.scheduleRebuild).not.toHaveBeenCalled();
    });
});

describe("scanAllStat", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should reset threshold when resetThreshold is true", async () => {
        const mockAPI = {
            isOnline: true,
        };

        // let appliedSettings: any = null;

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800,
                };
            },
            applyPartial: vi.fn(async (settings) => {
                // appliedSettings = settings;
                return await Promise.resolve(true);
            }),
            onSettingRealised: {
                addHandler: () => {},
            },
        };

        const mockAppLifecycle = {
            onScanningStartupIssues: {
                addHandler: () => {},
            },
        };

        const mockReplicator = {
            getActiveReplicator: () => ({
                getRemoteStatus: vi.fn().mockResolvedValue(null),
            }),
        };

        const host = {
            services: {
                API: mockAPI,
                setting: mockSetting,
                appLifecycle: mockAppLifecycle,
                replicator: mockReplicator,
            },
            serviceModules: {},
        } as any;

        await scanAllStat(host, logger, true);

        expect(mockSetting.applyPartial).toHaveBeenCalledWith({ notifyThresholdOfRemoteStorageSize: -1 }, true);
    });

    it("should not reset threshold when resetThreshold is false", async () => {
        const mockAPI = {
            isOnline: true,
        };

        let applyCallCount = 0;

        const mockSetting = {
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 800,
                };
            },
            applyPartial: vi.fn(async (settings) => {
                applyCallCount++;
                return await Promise.resolve(true);
            }),
            onSettingRealised: {
                addHandler: () => {},
            },
        };

        const mockAppLifecycle = {
            onScanningStartupIssues: {
                addHandler: () => {},
            },
        };

        const mockReplicator = {
            getActiveReplicator: () => ({
                getRemoteStatus: vi.fn().mockResolvedValue(null),
            }),
        };

        const host = {
            services: {
                API: mockAPI,
                setting: mockSetting,
                appLifecycle: mockAppLifecycle,
                replicator: mockReplicator,
            },
            serviceModules: {},
        } as any;

        applyCallCount = 0;
        await scanAllStat(host, logger, false);

        // applyPartial should not be called when resetThreshold is false
        expect(applyCallCount).toBe(0);
    });
});

describe("useCheckRemoteSize", () => {
    it("should register event handlers on app lifecycle events", async () => {
        const commandCallbacks = [] as any[];
        const logs = [] as string[];
        const mockAPI = {
            addCommand: vi.fn((command) => {
                commandCallbacks.push(command.callback);
            }),
            addLog(message: string, level?: any) {
                console.log(`${message}`);
                logs.push(message);
            },
            isOnline: false, // Prevent actual logic from running during this test
        };
        const settingMock = {
            applyPartial: vi.fn().mockResolvedValue(true),
            currentSettings() {
                return {
                    notifyThresholdOfRemoteStorageSize: 10,
                };
            },
        };
        const onScanningStartupIssuesHandlers = [] as any[];
        const onInitialisedHandlers = [] as any[];
        const mockAppLifecycle = {
            onScanningStartupIssues: {
                addHandler: vi.fn((handler) => onScanningStartupIssuesHandlers.push(handler)),
            },
            onInitialise: {
                addHandler: vi.fn((handler) => onInitialisedHandlers.push(handler)),
            },
        };
        const host = {
            services: {
                API: mockAPI,
                setting: settingMock,
                appLifecycle: mockAppLifecycle,
            },
            serviceModules: {},
        } as any;

        useCheckRemoteSize(host);
        expect(mockAppLifecycle.onScanningStartupIssues.addHandler).toHaveBeenCalled();
        expect(mockAppLifecycle.onInitialise.addHandler).toHaveBeenCalled();
        for (const handler of onInitialisedHandlers) {
            await handler();
        }
        expect(mockAPI.addCommand).toHaveBeenCalled();
        const preOfflineLogs = logs.filter((e) => e.includes("offline")).length;
        for (const handler of onScanningStartupIssuesHandlers) {
            await handler();
        }
        const offlineLogs = logs.filter((e) => e.includes("offline")).length;
        expect(offlineLogs).toBe(preOfflineLogs + 1); // The handler should log about being offline
        const previousApplyPartialCallCount = settingMock.applyPartial.mock.calls.length;
        eventHub.emitEvent(EVENT_REQUEST_CHECK_REMOTE_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 20)); // Wait for async handlers to complete
        // Since the actual logic of the handlers is tested in their respective unit tests, here we just verify that the event triggers without errors
        expect(settingMock.applyPartial.mock.calls.length).toBe(previousApplyPartialCallCount + 1);

        // Simulate command execution which should also trigger the check
        for (const handler of commandCallbacks) {
            await handler();
        }
        // After running the command callback, applyPartial should be called again to reset the threshold
        expect(settingMock.applyPartial.mock.calls.length).toBe(previousApplyPartialCallCount + 2);
    });
});
