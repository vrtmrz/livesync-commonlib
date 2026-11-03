import { describe, expect, it, vi } from "vitest";
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

    it("rejects a malformed remote feature declaration", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const db = {
            get: vi.fn(async () => ({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: "nfc-path-identity-v1",
            })),
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
        expect(db.put).not.toHaveBeenCalled();
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it.each([undefined, 0] as const)("rejects an NFC remote when path identity is legacy (%s)", async (version) => {
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
            settings: { encryptInternalMetadata: false, pathNormalizationVersion: version },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: db,
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);

        await expect(ready.promise).rejects.toThrow(
            "The database and settings use different path identity versions. Rebuild from the authoritative Vault or Fetch with matching settings before synchronising."
        );
        expect(db.get).toHaveBeenCalledOnce();
        expect(db.put).not.toHaveBeenCalled();
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it("accepts an NFC remote when path identity is configured", async () => {
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
            settings: { encryptInternalMetadata: false, pathNormalizationVersion: 1 },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: db,
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);

        await expect(ready.promise).resolves.toBeUndefined();
        expect(db.put).not.toHaveBeenCalled();
        expect(refreshSettings).toHaveBeenCalledOnce();
    });

    it("rejects NFC over populated legacy Metadata without changing the remote", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const legacyVersion = {
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: [],
        };
        const metadata = { _id: "note.md", type: "plain", path: "note.md" };
        const db = {
            get: vi.fn(async () => legacyVersion),
            allDocs: vi.fn(async () => ({ rows: [{ id: metadata._id, doc: metadata }] })),
            put: vi.fn(),
        };
        const manipulator = {
            services: { appLifecycle: { onReady: vi.fn().mockResolvedValue(undefined) } },
            options: { encryptInternalMetadata: false },
            settings: { encryptInternalMetadata: false, pathNormalizationVersion: 1 },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: db,
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);

        await expect(ready.promise).rejects.toThrow(
            "The database and settings use different path identity versions. Rebuild from the authoritative Vault or Fetch with matching settings before synchronising."
        );
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.allDocs).toHaveBeenCalledOnce();
        expect(db.put).not.toHaveBeenCalled();
        expect(legacyVersion.used_features).toEqual([]);
        expect(metadata).toEqual({ _id: "note.md", type: "plain", path: "note.md" });
        expect(refreshSettings).not.toHaveBeenCalled();
    });

    it("declares NFC during negotiation for a confirmed empty remote", async () => {
        const ready = promiseWithResolvers<void>();
        const refreshSettings = vi.fn();
        const missing = { status: 404, name: "not_found" };
        const db = {
            get: vi.fn(async () => {
                throw missing;
            }),
            allDocs: vi.fn(async () => ({ rows: [] })),
            info: vi.fn(async () => ({ doc_count: 0 })),
            put: vi.fn(async () => ({ ok: true })),
        };
        const manipulator = {
            services: { appLifecycle: { onReady: vi.fn().mockResolvedValue(undefined) } },
            options: { encryptInternalMetadata: false },
            settings: { encryptInternalMetadata: false, pathNormalizationVersion: 1 },
            liveSyncLocalDB: {
                initializeDatabase: vi.fn().mockResolvedValue(true),
                localDatabase: db,
                refreshSettings,
            },
            ready,
        } as unknown as DirectFileManipulator;

        await DirectFileManipulator.prototype.init.call(manipulator);

        await expect(ready.promise).resolves.toBeUndefined();
        expect(db.put).toHaveBeenCalledOnce();
        expect(db.put).toHaveBeenCalledWith({
            _id: VERSIONING_DOCID,
            version: 13,
            type: "versioninfo",
            used_features: ["nfc-path-identity-v1"],
        });
        expect(refreshSettings).toHaveBeenCalledOnce();
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

    it.each([
        { version: undefined, expected: 0 },
        { version: 0, expected: 0 },
        { version: 1, expected: 1 },
    ])("maps pathNormalizationVersion $version to settings", ({ version, expected }) => {
        const options: DirectFileManipulatorOptions = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: undefined,
            obfuscatePassphrase: undefined,
            ...(version === undefined ? {} : { pathNormalizationVersion: version as 0 | 1 }),
        };
        const getSettings = Object.getOwnPropertyDescriptor(DirectFileManipulator.prototype, "settings")?.get;
        if (!getSettings) throw new Error("DirectFileManipulator.settings getter is unavailable");

        expect(getSettings.call({ options } as DirectFileManipulator).pathNormalizationVersion).toBe(expected);
    });

    it("rejects an unsupported runtime pathNormalizationVersion option", () => {
        const options = {
            url: "https://example.com/couchdb",
            database: "vault",
            username: "alice",
            password: "secret",
            passphrase: undefined,
            obfuscatePassphrase: undefined,
            pathNormalizationVersion: 2,
        } as unknown as DirectFileManipulatorOptions;
        const getSettings = Object.getOwnPropertyDescriptor(DirectFileManipulator.prototype, "settings")?.get;
        if (!getSettings) throw new Error("DirectFileManipulator.settings getter is unavailable");

        expect(() => getSettings.call({ options } as DirectFileManipulator)).toThrow(
            "Unsupported path normalisation version: 2"
        );
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

describe("DirectFileManipulator watch facade", () => {
    const createManipulator = () => {
        const feed = { on: vi.fn().mockReturnThis(), cancel: vi.fn() };
        const changes = vi.fn(() => feed);
        const getByMeta = vi.fn(async (doc: MetaEntry) => ({ ...doc, data: ["body"] }));
        const close = vi.fn().mockResolvedValue(undefined);
        const onunload = vi.fn().mockResolvedValue(undefined);
        const manipulator = Object.assign(Object.create(DirectFileManipulator.prototype), {
            watching: false,
            since: "saved",
            getByMeta,
            liveSyncLocalDB: { localDatabase: { changes }, close, onunload },
        }) as DirectFileManipulator;
        const emit = (event: string, value?: unknown) => {
            const handler = feed.on.mock.calls.find(([name]) => name === event)?.[1];
            if (!handler) throw new Error(`Missing ${event} handler`);
            return handler(value);
        };
        return { manipulator, feed, changes, getByMeta, close, onunload, emit };
    };
    const note = { _id: "file.md", path: "file.md", type: "plain", children: [], ctime: 1, mtime: 2, size: 4 };

    it("preserves public watch state and waits for host checkpoint persistence", async () => {
        vi.useFakeTimers();
        const f = createManipulator();
        const persistence = promiseWithResolvers<void>();
        const callback = vi.fn();
        try {
            f.manipulator.beginWatch(callback, undefined, () => persistence.promise);
            expect(f.changes).toHaveBeenCalledWith({
                include_docs: true,
                since: "saved",
                selector: { type: { $ne: "leaf" } },
                live: true,
            });
            expect(f.manipulator.changes).toBe(f.feed);
            expect(f.manipulator.watching).toBe(true);
            await f.emit("change", { id: note._id, doc: note, seq: 7 });
            expect(callback).toHaveBeenCalledWith({ ...note, data: ["body"] }, 7);
            expect(f.manipulator.since).toBe("saved");
            persistence.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.manipulator.since).toBe("7");
            f.manipulator.endWatch();
            expect(f.feed.cancel).toHaveBeenCalledOnce();
            expect(f.manipulator.changes).toBeUndefined();
            expect(f.manipulator.watching).toBe(false);
            f.manipulator.since = "restored";
            f.manipulator.beginWatch(callback);
            expect(f.changes).toHaveBeenLastCalledWith(expect.objectContaining({ since: "restored" }));
        } finally {
            persistence.resolve();
            f.manipulator.endWatch();
            vi.useRealTimers();
        }
    });

    it("cancels owned watch work before closing its database", async () => {
        vi.useFakeTimers();
        const f = createManipulator();
        f.getByMeta.mockRejectedValue(new Error("chunk unavailable"));
        try {
            f.manipulator.beginWatch(vi.fn());
            await f.emit("change", { id: note._id, doc: note, seq: "gap" });
            f.emit("error", new Error("connection lost"));
            await f.manipulator.close();
            expect(f.close).toHaveBeenCalledOnce();
            expect(f.onunload).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(f.changes).toHaveBeenCalledOnce();
            expect(f.getByMeta).toHaveBeenCalledOnce();
        } finally {
            f.manipulator.endWatch();
            vi.useRealTimers();
        }
    });
});
