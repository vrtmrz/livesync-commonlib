import { describe, it, expect, beforeAll, vi } from "vitest";
import { checkAndReconcileEfficiencySettings, askImportedSettingsStrategy, useAutoConfig } from "./autoConfig";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import { eventHub } from "@lib/hub/hub";
import { EVENT_AUTO_CONFIG_KEYS_CHANGED, EVENT_SETTINGS_IMPORTED } from "@lib/events/coreEvents";
import { AutoConfigEfficiencyTemplate } from "@lib/common/models/tweak.definition";
import {
    TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE,
    TWEAK_OVERWRITE_STRATEGY_ASK,
    TWEAK_OVERWRITE_STRATEGY_OVERWRITE_REMOTE,
} from "@lib/common/models/setting.type";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const APIServiceMock = {
    addLog(message: string, _level?: unknown) {
        console.log(message);
    },
};

function createLogger(name: string): LogFunction {
    return createInstanceLogFunction(name, APIServiceMock as any);
}

/** Baseline local settings – all efficiency keys at default, caseSensitive = false */
const BASE_LOCAL_SETTINGS = {
    ...AutoConfigEfficiencyTemplate,
    handleFilenameCaseSensitive: false,
    tweakOverwriteStrategy: undefined as
        | typeof TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE
        | typeof TWEAK_OVERWRITE_STRATEGY_ASK
        | typeof TWEAK_OVERWRITE_STRATEGY_OVERWRITE_REMOTE
        | undefined,
};

/** Remote PREFERRED that matches local */
const REMOTE_MATCHING = { ...BASE_LOCAL_SETTINGS };

/** Remote PREFERRED with a differing efficiency key */
const REMOTE_DIFFERING = { ...BASE_LOCAL_SETTINGS, minimumChunkSize: 40 };

/** Remote PREFERRED with a differing case-sensitivity setting */
const REMOTE_CASE_MISMATCH = { ...BASE_LOCAL_SETTINGS, handleFilenameCaseSensitive: true };

function makeHost({
    localSettings = { ...BASE_LOCAL_SETTINGS },
    activeReplicator = null as object | null,
    applyPartialImpl = vi.fn().mockResolvedValue(undefined),
    confirmDialogue = vi.fn().mockResolvedValue(undefined as string | undefined),
} = {}) {
    const settings = { ...localSettings };

    const host = {
        services: {
            API: {
                addLog: APIServiceMock.addLog,
                confirm: {
                    askSelectStringDialogue: confirmDialogue,
                },
            },
            setting: {
                currentSettings: () => settings,
                applyPartial: applyPartialImpl,
            },
            replicator: {
                getActiveReplicator: () => activeReplicator,
            },
            replication: {
                onBeforeReplicate: {
                    addHandler: vi.fn(),
                },
            },
            appLifecycle: {
                onInitialise: {
                    addHandler: vi.fn(),
                },
            },
        },
        serviceModules: {},
    } as any;
    return { host, settings, applyPartialImpl, confirmDialogue };
}

function makeReplicator({
    remotePREFERRED = null as object | null,
    setPreferredImpl = vi.fn().mockResolvedValue(undefined),
} = {}) {
    return {
        getRemotePreferredTweakValues: vi.fn().mockResolvedValue(remotePREFERRED),
        setPreferredRemoteTweakSettings: setPreferredImpl,
    };
}

// ---------------------------------------------------------------------------
// checkAndReconcileEfficiencySettings
// ---------------------------------------------------------------------------
describe("checkAndReconcileEfficiencySettings", () => {
    let log: LogFunction;
    beforeAll(() => {
        log = createLogger("Test:autoConfig");
    });

    it("returns true and skips when there is no active replicator", async () => {
        const { host } = makeHost({ activeReplicator: null });
        const result = await checkAndReconcileEfficiencySettings(host, log, true);
        expect(result).toBe(true);
    });

    describe("no remote PREFERRED", () => {
        it("writes local as master and clears flag when flag is undefined", async () => {
            const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: null, setPreferredImpl });
            const { host } = makeHost({ activeReplicator: replicator, applyPartialImpl });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(setPreferredImpl).toHaveBeenCalled();
            // flag was undefined (not 0), so applyPartial should clear it
            expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: 0 }, true);
        });

        it("writes local as master and clears flag when flag is 1", async () => {
            const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: null, setPreferredImpl });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(setPreferredImpl).toHaveBeenCalled();
            expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: 0 }, true);
        });

        it("writes local as master but skips applyPartial when flag is already 0", async () => {
            const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: null, setPreferredImpl });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 0 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(setPreferredImpl).toHaveBeenCalled();
            expect(applyPartialImpl).not.toHaveBeenCalled();
        });
    });

    describe("remote PREFERRED exists — no diff", () => {
        it("clears a non-zero flag silently when settings are in sync", async () => {
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: REMOTE_MATCHING });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: 0 }, true);
        });

        it("does not call applyPartial when flag is already 0 and settings are in sync", async () => {
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: REMOTE_MATCHING });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 0 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(applyPartialImpl).not.toHaveBeenCalled();
        });
    });

    describe("remote PREFERRED exists — diff present", () => {
        it("flag=127: overwrites remote unconditionally and clears flag", async () => {
            const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING, setPreferredImpl });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 127 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            expect(setPreferredImpl).toHaveBeenCalled();
            expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: 0 }, true);
        });

        it("flag=0: accepts remote settings and clears flag", async () => {
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 0 },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            const call = applyPartialImpl.mock.calls[0][0];
            expect(call.tweakOverwriteStrategy).toBe(0);
            expect(call.minimumChunkSize).toBe(40); // remote value applied
        });

        it("flag=undefined: accepts remote settings (same as flag=0)", async () => {
            const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
            const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING });
            const { host } = makeHost({
                localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: undefined },
                activeReplicator: replicator,
                applyPartialImpl,
            });

            const result = await checkAndReconcileEfficiencySettings(host, log, true);

            expect(result).toBe(true);
            const call = applyPartialImpl.mock.calls[0][0];
            expect(call.tweakOverwriteStrategy).toBe(0);
            expect(call.minimumChunkSize).toBe(40);
        });

        describe("flag=1 — showMessage=false (quiet mode)", () => {
            it("keeps flag=1 and returns true without showing a dialogue", async () => {
                const confirmDialogue = vi.fn();
                const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
                const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING });
                const { host } = makeHost({
                    localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                    activeReplicator: replicator,
                    applyPartialImpl,
                    confirmDialogue,
                });

                const result = await checkAndReconcileEfficiencySettings(host, log, false);

                expect(result).toBe(true);
                expect(confirmDialogue).not.toHaveBeenCalled();
                expect(applyPartialImpl).not.toHaveBeenCalled();
            });
        });

        describe("flag=1 — showMessage=true (interactive)", () => {
            it("user selects USE_LOCAL: writes remote and clears flag", async () => {
                const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
                const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
                const CHOICE_USE_LOCAL = "Update remote with this device's settings";
                const confirmDialogue = vi.fn().mockResolvedValue(CHOICE_USE_LOCAL);
                const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING, setPreferredImpl });
                const { host } = makeHost({
                    localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                    activeReplicator: replicator,
                    applyPartialImpl,
                    confirmDialogue,
                });

                const result = await checkAndReconcileEfficiencySettings(host, log, true);

                expect(result).toBe(true);
                expect(setPreferredImpl).toHaveBeenCalled();
                expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: 0 }, true);
            });

            it("user selects USE_REMOTE: applies remote settings and clears flag", async () => {
                const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
                const CHOICE_USE_REMOTE = "Accept remote settings";
                const confirmDialogue = vi.fn().mockResolvedValue(CHOICE_USE_REMOTE);
                const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING });
                const { host } = makeHost({
                    localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                    activeReplicator: replicator,
                    applyPartialImpl,
                    confirmDialogue,
                });

                const result = await checkAndReconcileEfficiencySettings(host, log, true);

                expect(result).toBe(true);
                const call = applyPartialImpl.mock.calls[0][0];
                expect(call.tweakOverwriteStrategy).toBe(0);
                expect(call.minimumChunkSize).toBe(40);
            });

            it("dialogue times out or is cancelled (offline): keeps flag=1 and returns true", async () => {
                const setPreferredImpl = vi.fn();
                const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
                // undefined simulates timeout / no selection
                const confirmDialogue = vi.fn().mockResolvedValue(undefined);
                const replicator = makeReplicator({ remotePREFERRED: REMOTE_DIFFERING, setPreferredImpl });
                const { host } = makeHost({
                    localSettings: { ...BASE_LOCAL_SETTINGS, tweakOverwriteStrategy: 1 },
                    activeReplicator: replicator,
                    applyPartialImpl,
                    confirmDialogue,
                });

                const result = await checkAndReconcileEfficiencySettings(host, log, true);

                expect(result).toBe(true);
                expect(setPreferredImpl).not.toHaveBeenCalled();
                expect(applyPartialImpl).not.toHaveBeenCalled();
            });
        });
    });
});

// ---------------------------------------------------------------------------
// handleFilenameCaseSensitive block — tested via the onBeforeReplicate handler
// registered by useAutoConfig
// ---------------------------------------------------------------------------
describe("handleFilenameCaseSensitive mismatch via useAutoConfig handler", () => {
    function makeHostWithHandler(replicator: object | null) {
        const onBeforeReplicateHandlers: Array<(showMessage: boolean) => Promise<boolean>> = [];
        const onInitialiseHandlers: Array<() => Promise<boolean>> = [];
        const host = {
            services: {
                API: { addLog: APIServiceMock.addLog, confirm: { askSelectStringDialogue: vi.fn() } },
                setting: {
                    currentSettings: () => ({ ...BASE_LOCAL_SETTINGS }),
                    applyPartial: vi.fn().mockResolvedValue(undefined),
                },
                replicator: { getActiveReplicator: () => replicator },
                replication: {
                    onBeforeReplicate: {
                        addHandler: vi.fn((handler) => onBeforeReplicateHandlers.push(handler)),
                    },
                },
                appLifecycle: {
                    onInitialise: {
                        addHandler: vi.fn((handler) => onInitialiseHandlers.push(handler)),
                    },
                },
            },
            serviceModules: {},
        } as any;
        return { host, onBeforeReplicateHandlers, onInitialiseHandlers };
    }

    it("returns false when case-sensitivity settings differ", async () => {
        const replicator = makeReplicator({ remotePREFERRED: REMOTE_CASE_MISMATCH });
        const { host, onBeforeReplicateHandlers, onInitialiseHandlers } = makeHostWithHandler(replicator);

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        expect(onBeforeReplicateHandlers.length).toBeGreaterThan(0);
        const result = await onBeforeReplicateHandlers[0](true);
        expect(result).toBe(false);
    });

    it("returns true when case-sensitivity settings match", async () => {
        const replicator = makeReplicator({ remotePREFERRED: REMOTE_MATCHING });
        const { host, onBeforeReplicateHandlers, onInitialiseHandlers } = makeHostWithHandler(replicator);

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        const result = await onBeforeReplicateHandlers[0](true);
        expect(result).toBe(true);
    });

    it("returns true when active replicator is null (checkCaseSensitivityMismatch skips)", async () => {
        const { host, onBeforeReplicateHandlers, onInitialiseHandlers } = makeHostWithHandler(null);

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        const result = await onBeforeReplicateHandlers[0](true);
        expect(result).toBe(true);
    });

    it("returns true when remote PREFERRED is absent (checkCaseSensitivityMismatch defers)", async () => {
        // remotePREFERRED = false means no PREFERRED written yet
        const setPreferredImpl = vi.fn().mockResolvedValue(undefined);
        const replicator = makeReplicator({ remotePREFERRED: null, setPreferredImpl });
        const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
        const onBeforeReplicateHandlers: Array<(showMessage: boolean) => Promise<boolean>> = [];
        const onInitialiseHandlers: Array<() => Promise<boolean>> = [];
        const host = {
            services: {
                API: { addLog: APIServiceMock.addLog, confirm: { askSelectStringDialogue: vi.fn() } },
                setting: {
                    currentSettings: () => ({ ...BASE_LOCAL_SETTINGS }),
                    applyPartial: applyPartialImpl,
                },
                replicator: { getActiveReplicator: () => replicator },
                replication: {
                    onBeforeReplicate: {
                        addHandler: vi.fn((handler) => onBeforeReplicateHandlers.push(handler)),
                    },
                },
                appLifecycle: {
                    onInitialise: {
                        addHandler: vi.fn((handler) => onInitialiseHandlers.push(handler)),
                    },
                },
            },
            serviceModules: {},
        } as any;

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        const result = await onBeforeReplicateHandlers[0](true);
        // checkCaseSensitivityMismatch: remotePREFERRED absent → return true
        // checkAndReconcileEfficiencySettings: no PREFERRED → writes local as master
        expect(result).toBe(true);
        expect(setPreferredImpl).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// askImportedSettingsStrategy
// ---------------------------------------------------------------------------
describe("askImportedSettingsStrategy", () => {
    let log: LogFunction;
    beforeAll(() => {
        log = createLogger("Test:autoConfig:import");
    });

    const CHOICE_LOCAL_MASTER = "Overwrite remote with these settings";
    const CHOICE_CHECK = "Check consistency with remote";
    const CHOICE_REMOTE_WINS = "Accept remote settings";

    it.each([
        [CHOICE_LOCAL_MASTER, 127],
        [CHOICE_CHECK, 1],
        [CHOICE_REMOTE_WINS, 0],
        [undefined, 0], // timeout → same as REMOTE_WINS
    ])("dialogue answer %s → tweakOverwriteStrategy=%s", async (answer, expectedFlag) => {
        const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
        const confirmDialogue = vi.fn().mockResolvedValue(answer);
        const { host } = makeHost({ applyPartialImpl, confirmDialogue });

        await askImportedSettingsStrategy(host, log);

        expect(applyPartialImpl).toHaveBeenCalledWith({ tweakOverwriteStrategy: expectedFlag }, true);
    });
});

// ---------------------------------------------------------------------------
// useAutoConfig — event listener registration
// ---------------------------------------------------------------------------
describe("useAutoConfig — event listeners", () => {
    it("registers onBeforeReplicate and appLifecycle.onInitialise handlers", () => {
        const onInitialiseHandlers: unknown[] = [];
        const host = {
            services: {
                API: { addLog: APIServiceMock.addLog, confirm: { askSelectStringDialogue: vi.fn() } },
                setting: { currentSettings: () => ({ ...BASE_LOCAL_SETTINGS }), applyPartial: vi.fn() },
                replicator: { getActiveReplicator: () => null },
                replication: {
                    onBeforeReplicate: {
                        addHandler: vi.fn(),
                    },
                },
                appLifecycle: {
                    onInitialise: {
                        addHandler: vi.fn((h) => onInitialiseHandlers.push(h)),
                    },
                },
            },
            serviceModules: {},
        } as any;

        useAutoConfig(host);

        expect(host.services.appLifecycle.onInitialise.addHandler).toHaveBeenCalled();
    });

    it("EVENT_AUTO_CONFIG_KEYS_CHANGED sets tweakOverwriteStrategy=1", async () => {
        const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
        const onInitialiseHandlers: Array<() => Promise<boolean>> = [];

        const host = {
            services: {
                API: { addLog: APIServiceMock.addLog, confirm: { askSelectStringDialogue: vi.fn() } },
                setting: { currentSettings: () => ({ ...BASE_LOCAL_SETTINGS }), applyPartial: applyPartialImpl },
                replicator: { getActiveReplicator: () => null },
                replication: { onBeforeReplicate: { addHandler: vi.fn() } },
                appLifecycle: {
                    onInitialise: {
                        addHandler: vi.fn((h) => onInitialiseHandlers.push(h)),
                    },
                },
            },
            serviceModules: {},
        } as any;

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        const prevCallCount = applyPartialImpl.mock.calls.length;

        eventHub.emitEvent(EVENT_AUTO_CONFIG_KEYS_CHANGED, ["minimumChunkSize"] as any);
        await new Promise((r) => setTimeout(r, 20));

        expect(applyPartialImpl.mock.calls.length).toBeGreaterThan(prevCallCount);
        const lastCall = applyPartialImpl.mock.calls[applyPartialImpl.mock.calls.length - 1][0];
        expect(lastCall).toMatchObject({ tweakOverwriteStrategy: 1 });
    });

    it("EVENT_SETTINGS_IMPORTED triggers askImportedSettingsStrategy (shows dialogue)", async () => {
        const confirmDialogue = vi.fn().mockResolvedValue("Accept remote settings");
        const applyPartialImpl = vi.fn().mockResolvedValue(undefined);
        const onInitialiseHandlers: Array<() => Promise<boolean>> = [];

        const host = {
            services: {
                API: { addLog: APIServiceMock.addLog, confirm: { askSelectStringDialogue: confirmDialogue } },
                setting: { currentSettings: () => ({ ...BASE_LOCAL_SETTINGS }), applyPartial: applyPartialImpl },
                replicator: { getActiveReplicator: () => null },
                replication: { onBeforeReplicate: { addHandler: vi.fn() } },
                appLifecycle: {
                    onInitialise: {
                        addHandler: vi.fn((h) => onInitialiseHandlers.push(h)),
                    },
                },
            },
            serviceModules: {},
        } as any;

        useAutoConfig(host);
        for (const h of onInitialiseHandlers) await h();

        eventHub.emitEvent(EVENT_SETTINGS_IMPORTED);
        await new Promise((r) => setTimeout(r, 30));

        expect(confirmDialogue).toHaveBeenCalled();
    });
});
