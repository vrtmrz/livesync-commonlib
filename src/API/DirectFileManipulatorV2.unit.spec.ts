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
});
