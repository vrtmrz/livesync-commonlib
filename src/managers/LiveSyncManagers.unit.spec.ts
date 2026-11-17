import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_LEVEL_VERBOSE } from "@lib/common/types";
import type { LogFunction } from "@lib/services/lib/logUtils";

const receivedOptions = vi.hoisted(() => ({
    fetchers: [] as { log?: LogFunction }[],
    chunks: [] as { log?: LogFunction }[],
    entries: [] as { log?: LogFunction }[],
}));

vi.mock("@lib/managers/ChangeManager.ts", () => ({ ChangeManager: class {} }));
vi.mock("@lib/managers/ChunkFetcher.ts", () => ({
    ChunkFetcher: class {
        constructor(options: { log?: LogFunction }) {
            receivedOptions.fetchers.push(options);
        }
    },
}));
vi.mock("@lib/managers/ChunkManager.ts", () => ({
    ChunkManager: class {
        constructor(options: { log?: LogFunction }) {
            receivedOptions.chunks.push(options);
        }
    },
}));
vi.mock("@lib/managers/ConflictManager.ts", () => ({ ConflictManager: class {} }));
vi.mock("@lib/managers/EntryManager/EntryManager.ts", () => ({
    EntryManager: class {
        constructor(options: { log?: LogFunction }) {
            receivedOptions.entries.push(options);
        }
    },
}));
vi.mock("@lib/managers/HashManager/HashManager.ts", () => ({
    HashManager: class {
        clearCaches = vi.fn();
        initialise = vi.fn().mockResolvedValue(true);
    },
}));
vi.mock("@lib/ContentSplitter/ContentSplitters.ts", () => ({ ContentSplitter: class {} }));

import { LiveSyncManagers } from "./LiveSyncManagers";

describe("LiveSyncManagers", () => {
    beforeEach(() => {
        for (const options of Object.values(receivedOptions)) {
            options.length = 0;
        }
    });

    it("routes injected manager loggers to their owning API and retains its receiver", () => {
        const firstAPI = {
            addLog: vi.fn(function (this: unknown) {
                expect(this).toBe(firstAPI);
            }),
        };
        const secondAPI = {
            addLog: vi.fn(function (this: unknown) {
                expect(this).toBe(secondAPI);
            }),
        };
        for (const APIService of [firstAPI, secondAPI]) {
            new LiveSyncManagers({
                database: {} as never,
                databaseService: {} as never,
                settingService: {} as never,
                pathService: {} as never,
                replicatorService: { finiteReplicationActivityCount: 0 } as never,
                APIService: APIService as never,
            });
        }
        firstAPI.addLog.mockClear();
        secondAPI.addLog.mockClear();
        const firstError = new Error("First owner's manager diagnostic");
        const secondError = new Error("Second owner's manager diagnostic");
        for (const [key, options] of Object.entries(receivedOptions)) {
            options[0].log?.(firstError, LOG_LEVEL_VERBOSE, key);
        }
        expect(firstAPI.addLog).toHaveBeenCalledTimes(3);
        expect(secondAPI.addLog).not.toHaveBeenCalled();
        for (const [key, options] of Object.entries(receivedOptions)) {
            expect(firstAPI.addLog).toHaveBeenCalledWith(firstError, LOG_LEVEL_VERBOSE, key);
            options[1].log?.(secondError, LOG_LEVEL_VERBOSE, key);
            expect(secondAPI.addLog).toHaveBeenCalledWith(secondError, LOG_LEVEL_VERBOSE, key);
        }
        expect(secondAPI.addLog).toHaveBeenCalledTimes(3);
        expect(firstAPI.addLog).toHaveBeenCalledTimes(3);
    });
    it("releases ID keys from both the current hash manager and the entry manager when retiring them", async () => {
        const managers = new LiveSyncManagers({
            database: {} as never,
            databaseService: {} as never,
            settingService: {} as never,
            pathService: {} as never,
            replicatorService: { finiteReplicationActivityCount: 0 } as never,
            APIService: { addLog() {} } as never,
        });
        const original = managers.hashManager;
        const entryHashManager = { clearCaches: vi.fn() };
        managers.entryManager = { hashManager: entryHashManager } as never;
        managers.chunkManager = { clearCaches: vi.fn(), destroy: vi.fn() } as never;
        managers.changeManager = undefined!;
        managers.chunkFetcher = undefined!;

        managers.clearCaches();
        expect(original.clearCaches).toHaveBeenCalledTimes(1);
        expect(entryHashManager.clearCaches).toHaveBeenCalledTimes(1);
        await managers.prepareHashFunction();
        expect(original.clearCaches).toHaveBeenCalledTimes(2);
        expect(entryHashManager.clearCaches).toHaveBeenCalledTimes(2);
        expect(managers.hashManager).not.toBe(original);

        await managers.teardownManagers();
        expect(managers.hashManager.clearCaches).toHaveBeenCalledTimes(1);
        expect(entryHashManager.clearCaches).toHaveBeenCalledTimes(3);
    });

    it("uses the database instance supplied by its owner", () => {
        const databaseService = Object.defineProperty({}, "localDatabase", {
            get() {
                throw new Error("The owning DatabaseService has no local database");
            },
        });

        expect(
            () =>
                new LiveSyncManagers({
                    database: {} as never,
                    databaseService: databaseService as never,
                    settingService: {} as never,
                    pathService: {} as never,
                    replicatorService: { finiteReplicationActivityCount: 0 } as never,
                    APIService: { addLog() {} } as never,
                })
        ).not.toThrow();
    });
});
