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
            appLifecycle: { onSettingLoaded: { addHandler: onSettingLoaded }, onUnload: { addHandler: vi.fn() } },
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
            appLifecycle: { onSettingLoaded: { addHandler: vi.fn() }, onUnload: { addHandler: vi.fn() } },
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
            appLifecycle: { onSettingLoaded: { addHandler: vi.fn() }, onUnload: { addHandler: vi.fn() } },
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
                onUnload: { addHandler: vi.fn() },
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
                onUnload: { addHandler: vi.fn() },
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

it("keeps pending records through Pouch replacement and closes KV at application unload", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<boolean>> = {};
    const event = (name: string) => ({
        addHandler: (handler: (typeof handlers)[string]) => {
            handlers[name] = handler;
        },
    });
    const close = vi.fn(async () => undefined);
    const set = vi.fn(async () => undefined);
    const openKeyValueDatabase = vi.fn(async () => ({ close, set }));
    const service = new TestKeyValueDBService(createServiceContext(), {
        openKeyValueDatabase,
        vault: { getVaultName: () => "test-vault" },
        appLifecycle: { onSettingLoaded: event("loaded"), onUnload: event("appUnload") },
        databaseEvents: {
            onResetDatabase: event("reset"),
            onDatabaseInitialisation: event("initialise"),
            onUnloadDatabase: event("unload"),
            onCloseDatabase: event("close"),
        },
    } as unknown as KeyValueDBDependencies);
    await handlers.loaded();
    await handlers.close?.({});
    await service.openSimpleStore("pending").set("edit", { operation: "create" });
    await handlers.unload?.({});
    await handlers.initialise({});
    expect(openKeyValueDatabase).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledOnce();
    await handlers.appUnload();
    expect(close).toHaveBeenCalledOnce();
});

it("keeps KV operations available when the independently owned Pouch connection closes", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<boolean>> = {};
    const event = (name: string) => ({
        addHandler: (handler: (typeof handlers)[string]) => {
            handlers[name] = handler;
        },
    });
    let closed = false;
    const set = vi.fn(async () => {
        if (closed) throw new Error("closed KV connection");
    });
    const close = vi.fn(async () => {
        closed = true;
    });
    const service = new TestKeyValueDBService(createServiceContext(), {
        openKeyValueDatabase: vi.fn(async () => ({ set, close })),
        vault: { getVaultName: () => "test-vault" },
        appLifecycle: { onSettingLoaded: event("loaded"), onUnload: event("appUnload") },
        databaseEvents: {
            onResetDatabase: event("reset"),
            onDatabaseInitialisation: event("initialise"),
            onUnloadDatabase: event("unload"),
            onCloseDatabase: event("close"),
        },
    } as unknown as KeyValueDBDependencies);
    await handlers.loaded();
    await handlers.close?.({});
    await handlers.unload?.({});
    await expect(service.openSimpleStore("pending").set("edit", "retained")).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
});

it("preserves same-store records, changes the logical store explicitly, and discards records only on reset", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<boolean>> = {};
    const event = (name: string) => ({
        addHandler: (handler: (typeof handlers)[string]) => {
            handlers[name] = handler;
        },
    });
    let vaultName = `kv-owner-${crypto.randomUUID()}`;
    const originalName = vaultName;
    const factory = createIndexedDBKeyValueDatabaseFactory();
    const service = new TestKeyValueDBService(createServiceContext(), {
        openKeyValueDatabase: factory,
        vault: { getVaultName: () => vaultName },
        appLifecycle: { onSettingLoaded: event("loaded"), onUnload: event("appUnload") },
        databaseEvents: { onResetDatabase: event("reset"), onDatabaseInitialisation: event("initialise") },
    } as unknown as KeyValueDBDependencies);
    const store = service.openSimpleStore<{ automaticAttempted: boolean }>("pending");
    await handlers.loaded();
    await store.set("record", { automaticAttempted: true });
    await handlers.initialise({});
    expect(await store.get("record")).toEqual({ automaticAttempted: true });
    await handlers.appUnload();
    await expect(store.get("record")).rejects.toThrow("not initialized");
    await handlers.loaded();
    expect(await store.get("record")).toEqual({ automaticAttempted: true });
    vaultName += "-other";
    await handlers.initialise({});
    expect(await store.get("record")).toBeUndefined();
    await service.kvDB.destroy();
    vaultName = originalName;
    await handlers.initialise({});
    expect(await store.get("record")).toEqual({ automaticAttempted: true });
    await handlers.reset({});
    expect(await store.get("record")).toBeUndefined();
    await service.kvDB.destroy();
});

it("propagates a failed pending write even when the selected KV handle already exists", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<boolean>> = {};
    const event = (name: string) => ({
        addHandler: (handler: (typeof handlers)[string]) => {
            handlers[name] = handler;
        },
    });
    const failure = new Error("KV is unavailable");
    const service = new TestKeyValueDBService(createServiceContext(), {
        openKeyValueDatabase: async () => ({
            set: async () => {
                throw failure;
            },
            close: async () => {},
        }),
        vault: { getVaultName: () => "same-key" },
        appLifecycle: { onSettingLoaded: event("loaded"), onUnload: event("appUnload") },
        databaseEvents: { onResetDatabase: event("reset"), onDatabaseInitialisation: event("initialise") },
    } as unknown as KeyValueDBDependencies);
    await handlers.loaded();
    await handlers.initialise({});
    await expect(service.openSimpleStore("pending").set("record", true)).rejects.toBe(failure);
});
