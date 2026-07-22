import { describe, expect, it, vi } from "vitest";

import type { KeyValueDatabase } from "@lib/interfaces/KeyValueDatabase";
import { createServiceContext } from "./ServiceBase";
import { KeyValueDBService, type KeyValueDBDependencies } from "./KeyValueDBService";

vi.mock("octagonal-wheels/promises", async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
        ...original,
        delay: vi.fn(async () => undefined),
    };
});

class TestKeyValueDBService extends KeyValueDBService {}

describe("KeyValueDBService factory boundary", () => {
    it("creates a namespaced store handle before the backing database is initialised", () => {
        const dependencies = {
            openKeyValueDatabase: vi.fn(),
            vault: { getVaultName: () => "test-vault" },
            appLifecycle: { onSettingLoaded: { addHandler: vi.fn() } },
            databaseEvents: {
                onResetDatabase: { addHandler: vi.fn() },
                onDatabaseInitialisation: { addHandler: vi.fn() },
                onUnloadDatabase: { addHandler: vi.fn() },
                onCloseDatabase: { addHandler: vi.fn() },
            },
        } as unknown as KeyValueDBDependencies;
        const service = new TestKeyValueDBService(createServiceContext(), dependencies);

        expect(() => service.openSimpleStore("early-composition")).not.toThrow();
    });

    it("fails store operations promptly instead of waiting for lifecycle initialisation", async () => {
        const dependencies = {
            openKeyValueDatabase: vi.fn(),
            vault: { getVaultName: () => "test-vault" },
            appLifecycle: { onSettingLoaded: { addHandler: vi.fn() } },
            databaseEvents: {
                onResetDatabase: { addHandler: vi.fn() },
                onDatabaseInitialisation: { addHandler: vi.fn() },
                onUnloadDatabase: { addHandler: vi.fn() },
                onCloseDatabase: { addHandler: vi.fn() },
            },
        } as unknown as KeyValueDBDependencies;
        const service = new TestKeyValueDBService(createServiceContext(), dependencies);
        const store = service.openSimpleStore("early-composition");

        await expect(store.get("key")).rejects.toThrow("KeyValueDB is not initialized yet");
    });

    it("opens the database through the factory supplied by its composition", async () => {
        let onSettingLoaded: (() => Promise<boolean>) | undefined;
        const database = {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn(),
            clear: vi.fn(),
            keys: vi.fn(),
            close: vi.fn(),
            destroy: vi.fn(),
        } as unknown as KeyValueDatabase;
        const openKeyValueDatabase = vi.fn(async () => database);

        const dependencies = {
            openKeyValueDatabase,
            vault: { getVaultName: () => "test-vault" },
            appLifecycle: {
                onSettingLoaded: {
                    addHandler: (handler: () => Promise<boolean>) => {
                        onSettingLoaded = handler;
                    },
                },
            },
            databaseEvents: {
                onResetDatabase: { addHandler: vi.fn() },
                onDatabaseInitialisation: { addHandler: vi.fn() },
                onUnloadDatabase: { addHandler: vi.fn() },
                onCloseDatabase: { addHandler: vi.fn() },
            },
        } as unknown as KeyValueDBDependencies;
        const service = new TestKeyValueDBService(createServiceContext(), dependencies);
        const store = service.openSimpleStore<string>("composed-before-open");

        expect(onSettingLoaded).toBeDefined();
        await expect(onSettingLoaded!()).resolves.toBe(true);
        expect(openKeyValueDatabase).toHaveBeenCalledWith("test-vault-livesync-kv");
        await store.set("key", "value");
        expect(database.set).toHaveBeenCalledWith("composed-before-open-key", "value");
    });
});
