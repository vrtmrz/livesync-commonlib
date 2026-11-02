import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promiseWithResolvers } from "octagonal-wheels/promises";

import { VERSIONING_DOCID, type FilePath, type RemoteDBSettings } from "@lib/common/types.ts";
import { path2id_base } from "@lib/string_and_binary/path.ts";
import type { HeadlessDatabaseService } from "@lib/services/implements/headless/HeadlessDatabaseService.ts";
import { ServiceContext } from "@lib/services/base/ServiceBase.ts";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService.ts";
import type { ISettingService } from "@lib/services/base/IService.ts";

const loggerCalls = vi.hoisted(() => vi.fn());
const pouchDBCalls = vi.hoisted(
    () => [] as Array<{ name: string; options: PouchDB.Configuration.DatabaseConfiguration }>
);

vi.mock("octagonal-wheels/common/logger", async (importOriginal) => ({
    ...(await importOriginal<typeof import("octagonal-wheels/common/logger")>()),
    Logger: loggerCalls,
}));

vi.mock("@lib/pouchdb/pouchdb-http.ts", () => ({
    PouchDB: class {
        constructor(name: string, options: PouchDB.Configuration.DatabaseConfiguration) {
            pouchDBCalls.push({ name, options });
        }
    },
}));

import {
    DirectFileManipulator,
    type DirectFileManipulatorOptions,
    type DirectFileManipulatorRuntimeOptions,
    type MetaEntry,
} from "./DirectFileManipulatorV2.ts";

type GetBoundDatabaseService = (
    options: () => DirectFileManipulatorOptions,
    runtime: DirectFileManipulatorRuntimeOptions
) => typeof HeadlessDatabaseService;

describe("DirectFileManipulator", () => {
    it("rejects direct access to a remote with an unknown used feature", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const manipulator = {
            services: { appLifecycle: { onReady: vi.fn().mockResolvedValue(undefined) } },
            options: { encryptInternalMetadata: false },
            settings: { encryptInternalMetadata: false },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: {
                    get: vi.fn(async () => ({
                        _id: VERSIONING_DOCID,
                        type: "versioninfo",
                        version: 13,
                        used_features: ["future-format-v2"],
                    })),
                },
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);
        await expect(ready.promise).rejects.toThrow("Direct database version or features are not compatible.");
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it("rejects direct access to a remote using NFC path identity", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const db = {
            get: vi.fn(async () => ({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: ["nfc-path-identity-v1"],
            })),
            allDocs: vi.fn(),
            put: vi.fn(),
        };
        const manipulator = {
            services: { appLifecycle: { onReady: vi.fn().mockResolvedValue(undefined) } },
            options: { encryptInternalMetadata: false },
            settings: { encryptInternalMetadata: false },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: db,
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);

        await expect(ready.promise).rejects.toThrow("Direct database version or features are not compatible.");
        expect(db.get).toHaveBeenCalledOnce();
        expect(db.put).not.toHaveBeenCalled();
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it.each([
        { idDerivationVersion: 1 as const, idDerivationKey: "ab".repeat(32) },
        { idDerivationVersion: 0 as const, idDerivationKey: "" },
    ])(
        "rejects a different remote document ID before declaring the feature (local version: $idDerivationVersion)",
        async (idSettings) => {
            const ready = promiseWithResolvers<void>();
            const refreshSettings = vi.fn();
            const wrongId = await path2id_base("note.md" as FilePath, "secret", true, "cd".repeat(32));
            const db = {
                allDocs: vi.fn().mockResolvedValue({ rows: [{ id: wrongId }] }),
                get: vi.fn(async (id: string) =>
                    id === VERSIONING_DOCID
                        ? {
                              _id: VERSIONING_DOCID,
                              type: "versioninfo",
                              version: 13,
                              used_features: ["independent-id-derivation-v1"],
                          }
                        : { _id: wrongId, type: "plain", path: "note.md" }
                ),
                put: vi.fn(),
            };
            const settings = {
                encrypt: true,
                passphrase: "secret",
                usePathObfuscation: true,
                handleFilenameCaseSensitive: false,
                ...idSettings,
            } as RemoteDBSettings;
            const path = new PathServiceCompat(new ServiceContext(), {
                settingService: { currentSettings: () => settings } as ISettingService,
            });
            const manipulator = {
                services: { appLifecycle: { onReady: vi.fn().mockResolvedValue(undefined) }, path },
                options: { obfuscatePassphrase: "secret" },
                settings,
                liveSyncLocalDB: {
                    initializeDatabase: vi.fn().mockResolvedValue(true),
                    localDatabase: db,
                    refreshSettings,
                },
                ready,
            } as unknown as DirectFileManipulator;

            await DirectFileManipulator.prototype.init.call(manipulator);
            await expect(ready.promise).rejects.toThrow(
                "Direct database document IDs do not match the configured ID key."
            );
            expect(db.put).not.toHaveBeenCalled();
            expect(refreshSettings).not.toHaveBeenCalled();
        }
    );

    it("reports initialisation failures through the ready promise", async () => {
        const failure = new Error("CouchDB initialisation failed");
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const manipulator = {
            services: {
                appLifecycle: {
                    onReady: vi.fn().mockResolvedValue(undefined),
                },
            },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockRejectedValue(failure),
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await expect(DirectFileManipulator.prototype.init.call(manipulator)).resolves.toBeUndefined();
        await expect(ready.promise).rejects.toBe(failure);
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it("reports a rejected database initialisation through the ready promise", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const manipulator = {
            services: {
                appLifecycle: {
                    onReady: vi.fn().mockResolvedValue(undefined),
                },
            },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(false),
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await expect(DirectFileManipulator.prototype.init.call(manipulator)).resolves.toBeUndefined();
        await expect(ready.promise).rejects.toThrow("Direct database initialisation was rejected.");
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it("passes the host fetch implementation to its direct CouchDB connection", () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const options: DirectFileManipulatorOptions = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: undefined,
            obfuscatePassphrase: undefined,
        };
        const getBoundDatabaseService = DirectFileManipulator.prototype
            .getBoundDatabaseService as unknown as GetBoundDatabaseService;
        const BoundDatabaseService = getBoundDatabaseService(() => options, { fetch });
        const database = new BoundDatabaseService(new ServiceContext(), {} as never);

        database.createPouchDBInstance();

        expect(pouchDBCalls).toEqual([
            {
                name: "https://example.com/couchdb/vault",
                options: {
                    auth: { username: "alice", password: "secret" },
                    fetch,
                },
            },
        ]);
    });

    it("yields metadata entries when metadata-only enumeration is requested", async () => {
        const entries = [{ type: "plain", path: "note.md" }] as unknown as MetaEntry[];
        const getByMeta = vi.fn();
        const manipulator = {
            liveSyncLocalDB: {
                async *findEntries() {
                    yield* entries;
                },
            },
            getByMeta,
        } as unknown as DirectFileManipulator;
        const received: MetaEntry[] = [];

        for await (const entry of DirectFileManipulator.prototype._enumerate.call(manipulator, "", "z", {
            metaOnly: true,
        })) {
            received.push(entry);
        }

        expect(received).toEqual(entries);
        expect(getByMeta).not.toHaveBeenCalled();
    });

    it("enables path obfuscation when an obfuscation passphrase is supplied", () => {
        const options: DirectFileManipulatorOptions = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: undefined,
            obfuscatePassphrase: "obfuscation-secret",
        };
        const getSettings = Object.getOwnPropertyDescriptor(DirectFileManipulator.prototype, "settings")?.get;
        if (!getSettings) throw new Error("DirectFileManipulator.settings getter is unavailable");

        const settings = getSettings.call({ options } as DirectFileManipulator);

        expect(settings.usePathObfuscation).toBe(true);
    });

    it.each([
        { syncInternalFiles: true, expected: true },
        { syncInternalFiles: false, expected: false },
        { syncInternalFiles: undefined, expected: false },
    ])("propagates syncInternalFiles option $syncInternalFiles to settings", ({ syncInternalFiles, expected }) => {
        const options: DirectFileManipulatorOptions = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: undefined,
            obfuscatePassphrase: undefined,
            ...(syncInternalFiles === undefined ? {} : { syncInternalFiles }),
        };
        const getSettings = Object.getOwnPropertyDescriptor(DirectFileManipulator.prototype, "settings")?.get;
        if (!getSettings) throw new Error("DirectFileManipulator.settings getter is unavailable");

        expect(getSettings.call({ options } as DirectFileManipulator).syncInternalFiles).toBe(expected);
    });

    it("uses the dedicated path-obfuscation passphrase when it differs from the encryption passphrase", async () => {
        const options: DirectFileManipulatorOptions = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: "encryption-secret",
            obfuscatePassphrase: "path-secret",
            handleFilenameCaseSensitive: true,
        };
        const path = "note.md" as FilePath;
        const manipulator = new DirectFileManipulator(options);
        const expected = await path2id_base(path, "path-secret", false);
        const encryptionDerived = await path2id_base(path, "encryption-secret", false);

        await expect(manipulator.path2id(path)).resolves.toBe(expected);
        expect(expected).not.toBe(encryptionDerived);
    });

    it("delivers a file after its initially missing chunks become readable", async () => {
        vi.useFakeTimers();
        const changes = { on: vi.fn().mockReturnThis(), cancel: vi.fn() };
        const entry = {
            _id: "late.md",
            path: "late.md",
            type: "plain",
            children: ["h:late"],
            ctime: 1,
            mtime: 2,
            size: 4,
        };
        const ready = { ...entry, data: ["late"] };
        const getByMeta = vi.fn().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValue(ready);
        const callback = vi.fn();
        const manipulator = Object.assign(Object.create(DirectFileManipulator.prototype), {
            watching: false,
            since: "40",
            liveSyncLocalDB: { localDatabase: { changes: vi.fn(() => changes) } },
            getByMeta,
        }) as DirectFileManipulator;
        try {
            manipulator.beginWatch(callback);
            const handler = changes.on.mock.calls.find(([event]) => event === "change")?.[1];
            expect(handler).toBeTypeOf("function");
            void handler({ doc: entry, seq: "41" });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(callback).toHaveBeenCalledWith(ready, "41");
        } finally {
            manipulator.endWatch();
            vi.useRealTimers();
        }
    });

    it.each([
        { description: "a deletion", path: "old.md", deleted: true, selected: true },
        { description: "a same-ID rename", path: "Old.md", deleted: false, selected: true },
        { description: "an excluded same-ID rename", path: "excluded.md", deleted: false, selected: false },
    ])("does not deliver an older pending read after $description", async ({ path, deleted, selected }) => {
        const changes = { on: vi.fn().mockReturnThis(), cancel: vi.fn() };
        const firstRead = promiseWithResolvers<unknown>();
        const old = {
            _id: "same-id",
            _rev: "1-first",
            path: "old.md",
            type: "plain",
            children: ["h:old"],
            ctime: 1,
            mtime: 2,
            size: 4,
        };
        const latest = { ...old, _rev: "2-latest", path, deleted, data: deleted ? [] : ["next"] };
        const callback = vi.fn();
        const manipulator = Object.assign(Object.create(DirectFileManipulator.prototype), {
            watching: false,
            since: "40",
            liveSyncLocalDB: { localDatabase: { changes: vi.fn(() => changes) } },
            getByMeta: vi.fn((doc) => (doc._rev === old._rev ? firstRead.promise : Promise.resolve(latest))),
        }) as DirectFileManipulator;
        try {
            manipulator.beginWatch(callback, (doc) => doc.path !== "excluded.md");
            const handler = changes.on.mock.calls.find(([event]) => event === "change")?.[1];
            expect(handler).toBeTypeOf("function");
            const pending = handler({ doc: old, seq: "41" });
            const newer = handler({ doc: latest, seq: "42" });
            firstRead.resolve({ ...old, data: ["past"] });
            await Promise.all([pending, newer]);
            expect(callback.mock.calls.map(([doc]) => doc._rev)).toEqual(selected ? ["2-latest"] : []);
        } finally {
            await manipulator.endWatch();
        }
    });

    it("keeps its watch callback contained and reports a generic document-load failure", async () => {
        const changes = {
            on: vi.fn().mockReturnThis(),
            cancel: vi.fn(),
        };
        const callback = vi.fn();
        const manipulator = {
            watching: false,
            since: "0",
            liveSyncLocalDB: {
                localDatabase: {
                    changes: vi.fn(() => changes),
                },
            },
            getByMeta: vi.fn().mockRejectedValue(new Error("chunk unavailable")),
        } as unknown as DirectFileManipulator;

        loggerCalls.mockClear();
        DirectFileManipulator.prototype.beginWatch.call(manipulator, callback);
        const changeHandler = changes.on.mock.calls.find(([event]) => event === "change")?.[1] as
            | ((change: { doc: { type: "plain"; path: string }; seq: number }) => Promise<void>)
            | undefined;
        if (!changeHandler) throw new Error("DirectFileManipulator change handler was not registered");

        await expect(changeHandler({ doc: { type: "plain", path: "encrypted.md" }, seq: 1 })).resolves.toBeUndefined();
        expect(callback).not.toHaveBeenCalled();
        expect(loggerCalls).toHaveBeenCalledWith(
            "WATCH: DOCUMENT LOAD FAILED: encrypted.md",
            expect.anything(),
            "watch"
        );
        DirectFileManipulator.prototype.endWatch.call(manipulator);
    });
});

describe("DirectFileManipulator watch acknowledgement", () => {
    const watchers: DirectFileManipulator[] = [];
    const note = (id: string, extra: Record<string, unknown> = {}) =>
        ({
            _id: id,
            _rev: "1-first",
            path: id,
            type: "plain",
            children: ["h:body"],
            ctime: 1,
            mtime: 2,
            size: 4,
            ...extra,
        }) as MetaEntry;
    const fixture = (getByMeta = vi.fn(async (doc: MetaEntry) => ({ ...doc, data: ["body"] }))) => {
        const feeds: Array<{ on: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = [];
        const changes = vi.fn(() => {
            const feed = { on: vi.fn().mockReturnThis(), cancel: vi.fn() };
            feeds.push(feed);
            return feed;
        });
        const manipulator = Object.assign(Object.create(DirectFileManipulator.prototype), {
            watching: false,
            since: "start",
            getByMeta,
            liveSyncLocalDB: { localDatabase: { changes } },
        }) as DirectFileManipulator;
        watchers.push(manipulator);
        const emit = (event: string, value?: unknown) => {
            const handler = feeds.at(-1)?.on.mock.calls.find(([name]) => name === event)?.[1];
            if (!handler) throw new Error(`Missing ${event} handler`);
            return handler(value);
        };
        return {
            manipulator,
            changes,
            getByMeta,
            feeds,
            emit,
            change: (doc: MetaEntry, seq: string | number) => emit("change", { id: doc._id, doc, seq }),
        };
    };
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        for (const watcher of watchers.splice(0)) watcher.endWatch();
        vi.useRealTimers();
    });

    it("keeps an opaque checkpoint before an unreadable file while unrelated files continue", async () => {
        const first = note("late.md");
        let readable = false;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc._id === first._id && !readable) throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.manipulator.beginWatch(callback, undefined, checkpoint);
        await f.change(first, "z-opaque");
        await f.change(note("available.md"), "a-opaque");
        expect(callback.mock.calls.map(([doc]) => doc.path)).toEqual(["available.md"]);
        expect(f.manipulator.since).toBe("start");
        expect(checkpoint).not.toHaveBeenCalled();
        readable = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(callback.mock.calls.map(([doc]) => doc.path)).toEqual(["available.md", "late.md"]);
        expect(checkpoint).toHaveBeenLastCalledWith("a-opaque");
        expect(f.manipulator.since).toBe("a-opaque");
    });

    it("retries a rejected consumer acknowledgement without blocking unrelated files", async () => {
        const f = fixture();
        const callback = vi.fn().mockRejectedValueOnce(new Error("consumer unavailable"));
        const checkpoint = vi.fn();
        f.manipulator.beginWatch(callback, undefined, checkpoint);
        await f.change(note("retry.md"), 7);
        await f.change(note("other.md"), "later-token");
        expect(callback).toHaveBeenCalledTimes(2);
        expect(f.manipulator.since).toBe("start");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(callback).toHaveBeenCalledTimes(3);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ path: "retry.md" }), 7);
        expect(f.manipulator.since).toBe("later-token");
    });

    it("retries failed checkpoint persistence before advancing since", async () => {
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn().mockRejectedValueOnce(new Error("storage unavailable"));
        f.manipulator.beginWatch(callback, undefined, checkpoint);
        await f.change(note("one.md"), 9);
        expect(callback).toHaveBeenCalledOnce();
        expect(f.manipulator.since).toBe("start");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(checkpoint.mock.calls).toEqual([[9], [9]]);
        expect(f.manipulator.since).toBe("9");
        expect(callback).toHaveBeenCalledOnce();
    });

    it("retains a superseded file's original gap until its replacement is acknowledged", async () => {
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc._rev === "1-missing") throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        let acceptReplacement = false;
        const callback = vi.fn(async (doc: MetaEntry) => {
            if (doc._rev === "2-replacement" && !acceptReplacement) throw new Error("consumer unavailable");
        });
        f.manipulator.beginWatch(callback);
        await f.change(note("same.md", { _rev: "1-missing" }), "gap");
        await f.change(note("other.md"), "between");
        await f.change(note("same.md", { _rev: "2-replacement" }), "replacement");
        expect(f.manipulator.since).toBe("start");
        acceptReplacement = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.manipulator.since).toBe("replacement");
        expect(callback.mock.calls.filter(([doc]) => doc._rev === "1-missing")).toEqual([]);
    });

    it.each([{ deleted: true }, { _deleted: true }])(
        "delivers deletion metadata without loading chunks: %j",
        async (deleted) => {
            const f = fixture(vi.fn().mockRejectedValue(new Error("missing deleted chunks")));
            const callback = vi.fn();
            f.manipulator.beginWatch(callback);
            await f.change(note("deleted.md", deleted), "deleted");
            expect(f.getByMeta).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ...deleted, data: [] }), "deleted");
            expect(f.manipulator.since).toBe("deleted");
        }
    );

    it("uses pending metadata to deliver a bare tombstone and fences the old read", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(vi.fn(() => oldRead.promise));
        const callback = vi.fn();
        f.manipulator.beginWatch(callback);
        const old = note("deleted.md");
        void f.change(old, "old");
        await f.change({ _id: old._id, _rev: "2-deleted", _deleted: true } as MetaEntry, "deleted");
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({ path: "deleted.md", _deleted: true, data: [] }),
            "deleted"
        );
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback).toHaveBeenCalledOnce();
        expect(f.manipulator.since).toBe("deleted");
    });

    it("acknowledges ignored rows without loading their bodies", async () => {
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.manipulator.beginWatch(callback, (doc) => doc.path !== "excluded.md", checkpoint);
        await f.change(note("control", { type: "versioninfo" }), "control-token");
        await f.change(note("excluded.md"), "excluded-token");
        expect(f.getByMeta).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(checkpoint).toHaveBeenLastCalledWith("excluded-token");
        expect(f.manipulator.since).toBe("excluded-token");
    });

    it("bounds simultaneous body loads and eventually processes every queued document", async () => {
        const loads: Array<() => void> = [];
        let active = 0;
        let maximum = 0;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                active++;
                maximum = Math.max(maximum, active);
                await new Promise<void>((resolve) => loads.push(resolve));
                active--;
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        f.manipulator.beginWatch(callback);
        for (let i = 0; i < 40; i++) void f.change(note(`note-${i}.md`), `token-${i}`);
        expect(maximum).toBeLessThanOrEqual(4);
        for (let i = 0; i < 40; i++) {
            const release = loads.shift();
            expect(release).toBeTypeOf("function");
            release!();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(callback).toHaveBeenCalledTimes(40);
        expect(f.manipulator.since).toBe("token-39");
    });

    it("continues through many completed rows behind one gap and checkpoints their final position", async () => {
        let readable = false;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc.path === "gap.md" && !readable) throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.manipulator.beginWatch(callback, undefined, checkpoint);
        await f.change(note("gap.md"), "gap");
        for (let i = 0; i < 5_000; i++) await f.change(note(`note-${i}.md`), `token-${i}`);
        expect(callback).toHaveBeenCalledTimes(5_000);
        expect(checkpoint).not.toHaveBeenCalled();
        readable = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(checkpoint.mock.calls).toEqual([["token-4999"]]);
        expect(f.manipulator.since).toBe("token-4999");
    });

    it("cancels retry and reconnect timers when stopped", async () => {
        const f = fixture(vi.fn().mockRejectedValue(new Error("chunk unavailable")));
        f.manipulator.beginWatch(vi.fn());
        await f.change(note("gap.md"), "gap");
        f.emit("error", new Error("connection lost"));
        f.manipulator.endWatch();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.changes).toHaveBeenCalledOnce();
        expect(f.getByMeta).toHaveBeenCalledOnce();
        expect(f.manipulator.watching).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("fences a stopped session's late read after a new watch starts", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(
            vi
                .fn()
                .mockImplementationOnce(() => oldRead.promise)
                .mockImplementation(async (doc: MetaEntry) => ({ ...doc, data: ["current"] }))
        );
        const oldCallback = vi.fn();
        const currentCallback = vi.fn();
        f.manipulator.beginWatch(oldCallback);
        const old = note("old.md");
        void f.change(old, "old");
        f.manipulator.endWatch();
        f.manipulator.beginWatch(currentCallback);
        await f.change(note("current.md"), "current");
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).not.toHaveBeenCalled();
        expect(currentCallback).toHaveBeenCalledOnce();
        expect(f.manipulator.since).toBe("current");
    });

    it("reconnects from the persisted checkpoint and fences reads from the failed connection", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(
            vi
                .fn()
                .mockImplementationOnce(() => oldRead.promise)
                .mockImplementation(async (doc: MetaEntry) => ({ ...doc, data: ["current"] }))
        );
        const callback = vi.fn();
        f.manipulator.beginWatch(callback);
        const old = note("old.md");
        void f.change(old, "gap");
        await f.change(note("other.md"), "later");
        f.emit("error", new Error("connection lost"));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.changes).toHaveBeenLastCalledWith(expect.objectContaining({ since: "start" }));
        await f.change(note("old.md", { _rev: "2-current" }), "replayed");
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback.mock.calls.map(([doc]) => doc._rev)).toEqual(["1-first", "2-current"]);
        expect(f.manipulator.since).toBe("replayed");
    });

    it("advances only to the completed prefix before the earliest unresolved document", async () => {
        const gap = promiseWithResolvers<any>();
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc.path === "gap.md") return gap.promise;
                return { ...doc, data: ["body"] };
            })
        );
        const checkpoint = vi.fn();
        f.manipulator.beginWatch(vi.fn(), undefined, checkpoint);
        await f.change(note("prefix.md"), "z-prefix");
        void f.change(note("gap.md"), "m-gap");
        await f.change(note("suffix.md"), "a-suffix");
        expect(checkpoint.mock.calls).toEqual([["z-prefix"]]);
        expect(f.manipulator.since).toBe("z-prefix");
        gap.resolve({ ...note("gap.md"), data: ["ready"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(checkpoint.mock.calls).toEqual([["z-prefix"], ["a-suffix"]]);
    });

    it("caps exponential retry delays while the file stays unavailable", async () => {
        const attempts: number[] = [];
        const f = fixture(
            vi.fn(async () => {
                attempts.push(Date.now());
                throw new Error("chunk unavailable");
            })
        );
        f.manipulator.beginWatch(vi.fn());
        await f.change(note("gap.md"), "gap");
        await vi.advanceTimersByTimeAsync(121_000);
        expect(attempts.slice(1).map((time, i) => time - attempts[i])).toEqual([
            1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
        ]);
        expect(f.manipulator.since).toBe("start");
    });

    it("keeps unknown bare tombstones ignored when their file metadata is unavailable", async () => {
        const f = fixture();
        const callback = vi.fn();
        f.manipulator.beginWatch(callback);
        await f.change({ _id: "f:unknown", _rev: "2-deleted", _deleted: true } as MetaEntry, "deleted");
        expect(f.getByMeta).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(f.manipulator.since).toBe("deleted");
    });

    it("serialises checkpoint persistence across stop and restart", async () => {
        const persistence = promiseWithResolvers<void>();
        const f = fixture();
        const oldCheckpoint = vi.fn(() => persistence.promise);
        const nextCheckpoint = vi.fn();
        f.manipulator.beginWatch(vi.fn(), undefined, oldCheckpoint);
        void f.change(note("old.md"), "old");
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCheckpoint).toHaveBeenCalledOnce();
        f.manipulator.endWatch();
        f.manipulator.beginWatch(vi.fn(), undefined, nextCheckpoint);
        void f.change(note("new.md"), "new");
        await vi.advanceTimersByTimeAsync(0);
        expect(nextCheckpoint).not.toHaveBeenCalled();
        persistence.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(nextCheckpoint).toHaveBeenCalledWith("new");
        expect(f.manipulator.since).toBe("new");
    });

    it("keeps body loads bounded when stopped watches still have unresolved reads", async () => {
        const reads: Array<() => void> = [];
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                await new Promise<void>((resolve) => reads.push(resolve));
                return { ...doc, data: ["body"] };
            })
        );
        const oldCallback = vi.fn();
        const callback = vi.fn();
        f.manipulator.beginWatch(oldCallback);
        for (let i = 0; i < 4; i++) void f.change(note(`old-${i}.md`), `old-${i}`);
        expect(f.getByMeta).toHaveBeenCalledTimes(4);
        f.manipulator.endWatch();
        f.manipulator.beginWatch(callback);
        void f.change(note("new.md"), "new");
        expect(f.getByMeta).toHaveBeenCalledTimes(4);
        const oldReads = reads.splice(0);
        oldReads[0]();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.getByMeta).toHaveBeenCalledTimes(5);
        reads.shift()!();
        for (const release of oldReads.slice(1)) release();
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledOnce();
        expect(f.manipulator.since).toBe("new");
    });

    it("serialises same-ID consumer writes across stop and restart", async () => {
        const acknowledgement = promiseWithResolvers<void>();
        const writes: string[] = [];
        const f = fixture();
        const oldCallback = vi.fn(async () => {
            await acknowledgement.promise;
            writes.push("old");
        });
        const currentCallback = vi.fn(() => {
            writes.push("new");
        });
        f.manipulator.beginWatch(oldCallback);
        void f.change(note("same.md"), "old");
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).toHaveBeenCalledOnce();
        f.manipulator.endWatch();
        f.manipulator.beginWatch(currentCallback);
        void f.change(note("same.md", { _rev: "2-current" }), "new");
        await vi.advanceTimersByTimeAsync(0);
        expect(currentCallback).not.toHaveBeenCalled();
        acknowledgement.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(currentCallback).toHaveBeenCalledOnce();
        expect(writes).toEqual(["old", "new"]);
        expect(f.manipulator.since).toBe("new");
    });

    it("owns a reconnect while reporting the feed disconnected and rejecting duplicate watches", async () => {
        const f = fixture();
        f.manipulator.beginWatch(vi.fn());
        f.emit("error", new Error("connection lost"));
        expect(f.manipulator.watching).toBe(false);
        expect(f.manipulator.beginWatch(vi.fn())).toBe(false);
        expect(f.changes).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.changes).toHaveBeenCalledTimes(2);
        expect(f.manipulator.watching).toBe(true);
    });

    it("keeps delivering unrelated documents while checkpoint persistence is pending", async () => {
        const persistence = promiseWithResolvers<void>();
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn(() => persistence.promise);
        f.manipulator.beginWatch(callback, undefined, checkpoint);
        try {
            for (let i = 0; i < 40; i++) void f.change(note(`note-${i}.md`), `token-${i}`);
            await vi.advanceTimersByTimeAsync(0);
            expect(callback).toHaveBeenCalledTimes(40);
            expect(f.manipulator.since).toBe("start");
        } finally {
            persistence.resolve();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(checkpoint).toHaveBeenLastCalledWith("token-39");
        expect(f.manipulator.since).toBe("token-39");
    });

    it("cancels owned watch work before closing its database", async () => {
        const f = fixture(vi.fn().mockRejectedValue(new Error("chunk unavailable")));
        const close = vi.fn().mockResolvedValue(undefined);
        const onunload = vi.fn().mockResolvedValue(undefined);
        Object.assign(f.manipulator.liveSyncLocalDB, { close, onunload });
        f.manipulator.beginWatch(vi.fn());
        await f.change(note("gap.md"), "gap");
        f.emit("error", new Error("connection lost"));
        await f.manipulator.close();
        expect(close).toHaveBeenCalledOnce();
        expect(onunload).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.changes).toHaveBeenCalledOnce();
        expect(f.getByMeta).toHaveBeenCalledOnce();
    });
});
