import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import type { KeyValueDatabase } from "@lib/interfaces/KeyValueDatabase";
import { createIndexedDBKeyValueDatabaseFactory } from "@lib/databases/IndexedDBKeyValueDatabase";
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
    it("does not register application database lifecycle handlers for direct access", () => {
        const onSettingLoaded = vi.fn();
        const onResetDatabase = vi.fn();
        const onDatabaseInitialisation = vi.fn();
        const onUnloadDatabase = vi.fn();
        const onCloseDatabase = vi.fn();
        const dependencies = {
            openKeyValueDatabase: vi.fn(),
            vault: { getVaultName: () => "test-vault" },
            appLifecycle: { onSettingLoaded: { addHandler: onSettingLoaded } },
            databaseEvents: {
                onResetDatabase: { addHandler: onResetDatabase },
                onDatabaseInitialisation: { addHandler: onDatabaseInitialisation },
                onUnloadDatabase: { addHandler: onUnloadDatabase },
                onCloseDatabase: { addHandler: onCloseDatabase },
            },
            registerLifecycleHandlers: false,
        } as unknown as KeyValueDBDependencies;

        new TestKeyValueDBService(createServiceContext(), dependencies);

        expect(onSettingLoaded).not.toHaveBeenCalled();
        expect(onResetDatabase).not.toHaveBeenCalled();
        expect(onDatabaseInitialisation).not.toHaveBeenCalled();
        expect(onUnloadDatabase).not.toHaveBeenCalled();
        expect(onCloseDatabase).not.toHaveBeenCalled();
    });

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
        await expect(store.keys(undefined, undefined)).rejects.toThrow("KeyValueDB is not initialized yet");
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

    it("enumerates all keys in a namespace without reading values", async () => {
        const vaultName = `test-vault-${crypto.randomUUID()}`;
        const databaseKey = `${vaultName}-livesync-kv`;
        const openKeyValueDatabase = createIndexedDBKeyValueDatabaseFactory();
        const database = await openKeyValueDatabase(databaseKey);
        const get = vi.spyOn(database, "get");
        let onSettingLoaded: (() => Promise<boolean>) | undefined;
        const dependencies = {
            openKeyValueDatabase,
            vault: { getVaultName: () => vaultName },
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
        const store = service.openSimpleStore<string>("provenance");
        const adjacentNamespace = service.openSimpleStore<string>("provenance.");
        const astralPath = "\u{10000}.md";

        try {
            await expect(onSettingLoaded!()).resolves.toBe(true);
            await store.set("a.md", "a");
            await store.set("b.md", "b");
            await store.set(astralPath, "astral");
            await store.set("\uffff/end.md", "beyond a sentinel prefix");
            await adjacentNamespace.set("other.md", "other namespace");

            await expect(store.keys(undefined, undefined)).resolves.toEqual([
                "a.md",
                "b.md",
                astralPath,
                "\uffff/end.md",
            ]);
            await expect(store.keys("a.md", astralPath)).resolves.toEqual(["a.md", "b.md", astralPath]);
            await expect(store.keys("a.md", astralPath, 2)).resolves.toEqual(["a.md", "b.md"]);
            await expect(store.keys("b.md", undefined)).resolves.toEqual(["b.md", astralPath, "\uffff/end.md"]);
            await store.set("", "empty key");
            await expect(store.keys(undefined, "")).resolves.toEqual([""]);
            await expect(store.keys(undefined, undefined)).resolves.toEqual([
                "",
                "a.md",
                "b.md",
                astralPath,
                "\uffff/end.md",
            ]);
            expect(get).not.toHaveBeenCalled();
        } finally {
            await database.destroy();
        }
    });
});
