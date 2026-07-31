import { describe, expect, it, vi } from "vitest";
import { promiseWithResolvers } from "octagonal-wheels/promises";

import type { HeadlessDatabaseService } from "@lib/services/implements/headless/HeadlessDatabaseService.ts";
import { ServiceContext } from "@lib/services/base/ServiceBase.ts";

const pouchDBCalls = vi.hoisted(
    () => [] as Array<{ name: string; options: PouchDB.Configuration.DatabaseConfiguration }>
);

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

    it("keeps its watch callback contained when a changed document cannot be decrypted", async () => {
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
            getByMeta: vi.fn().mockRejectedValue(new Error("decryption failed")),
        } as unknown as DirectFileManipulator;

        DirectFileManipulator.prototype.beginWatch.call(manipulator, callback);
        const changeHandler = changes.on.mock.calls.find(([event]) => event === "change")?.[1] as
            | ((change: { doc: { type: "plain"; path: string }; seq: number }) => Promise<void>)
            | undefined;
        if (!changeHandler) throw new Error("DirectFileManipulator change handler was not registered");

        await expect(
            changeHandler({ doc: { type: "plain", path: "encrypted.md" }, seq: 1 })
        ).resolves.toBeUndefined();
        expect(callback).not.toHaveBeenCalled();
    });
});
