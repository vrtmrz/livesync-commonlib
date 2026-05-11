import { describe, expect, it, vi } from "vitest";

vi.mock("octagonal-wheels/promises", () => ({
    delay: vi.fn(async () => await Promise.resolve()),
}));

import { ServiceRebuilder } from "./Rebuilder";

function createServices(userHashSalt: string) {
    const setting = {
        suspendExtraSync: vi.fn(async () => await Promise.resolve()),
        currentSettings: vi.fn(() => ({ userHashSalt })),
        applyPartial: vi.fn(async () => await Promise.resolve()),
        suspendAllSync: { addHandler: vi.fn() },
    };

    const services = {
        appLifecycle: {
            performRestart: vi.fn(),
        },
        API: {
            addLog: vi.fn(),
            getAppID: vi.fn(() => "app-id"),
        },
        UI: {
            showMarkdownDialog: vi.fn(async () => await Promise.resolve()),
            confirm: { askYesNoDialog: vi.fn(async () => await Promise.resolve("no")) },
        },
        setting,
        remote: {},
        databaseEvents: {
            initialiseDatabase: vi.fn(async () => await Promise.resolve()),
        },
        storageAccess: {
            writeFileAuto: vi.fn(async () => await Promise.resolve()),
        },
        replicator: {
            getActiveReplicator: vi.fn(() => ({
                tryResetRemoteDatabase: vi.fn(async () => await Promise.resolve()),
            })),
        },
        vault: {},
        replication: {
            markLocked: vi.fn(async () => await Promise.resolve()),
            replicateAllToRemote: vi.fn(async () => await Promise.resolve()),
            openReplication: vi.fn(async () => await Promise.resolve()),
        },
        database: {
            onDatabaseReset: { addHandler: vi.fn() },
            resetDatabase: vi.fn(async () => await Promise.resolve()),
            close: vi.fn(async () => await Promise.resolve()),
            initialiseDatabase: vi.fn(async () => await Promise.resolve()),
            resetAllDatabase: vi.fn(async () => await Promise.resolve()),
            closeDatabase: vi.fn(async () => await Promise.resolve()),
            getDBEntry: vi.fn(() => ({ db: { close: vi.fn(async () => await Promise.resolve()) } })),
        },
        fileHandler: {
            clearQueue: vi.fn(async () => await Promise.resolve()),
        },
        control: {
            applySettings: vi.fn(async () => await Promise.resolve()),
        },
    } as any;

    return { services, setting };
}

describe("ServiceRebuilder userHashSalt", () => {
    it("rebuildEverything should generate userHashSalt when absent", async () => {
        const { services, setting } = createServices("");
        const randomSpy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
            const target = array as Uint8Array;
            for (let i = 0; i < target.length; i++) {
                target[i] = 0xcd;
            }
            return array;
        });

        const rebuilder = new ServiceRebuilder(services);
        await rebuilder.rebuildEverything();

        expect(setting.applyPartial).toHaveBeenCalledWith({ userHashSalt: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" });
        randomSpy.mockRestore();
    });

    it("rebuildEverything should not generate userHashSalt when already present", async () => {
        const { services, setting } = createServices("00112233445566778899aabbccddeeff");
        const rebuilder = new ServiceRebuilder(services);
        const randomSpy = vi.spyOn(globalThis.crypto, "getRandomValues");

        await rebuilder.rebuildEverything();

        expect(setting.applyPartial).not.toHaveBeenCalledWith(
            expect.objectContaining({ userHashSalt: expect.any(String) })
        );
        expect(randomSpy).not.toHaveBeenCalled();
        randomSpy.mockRestore();
    });
});
