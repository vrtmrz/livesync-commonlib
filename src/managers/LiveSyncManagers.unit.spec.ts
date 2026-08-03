import { describe, expect, it, vi } from "vitest";

vi.mock("@lib/managers/ChangeManager.ts", () => ({ ChangeManager: class {} }));
vi.mock("@lib/managers/ChunkFetcher.ts", () => ({ ChunkFetcher: class {} }));
vi.mock("@lib/managers/ChunkManager.ts", () => ({ ChunkManager: class {} }));
vi.mock("@lib/managers/ConflictManager.ts", () => ({ ConflictManager: class {} }));
vi.mock("@lib/managers/EntryManager/EntryManager.ts", () => ({ EntryManager: class {} }));
vi.mock("@lib/managers/HashManager/HashManager.ts", () => ({ HashManager: class {} }));
vi.mock("@lib/ContentSplitter/ContentSplitters.ts", () => ({ ContentSplitter: class {} }));

import { LiveSyncManagers } from "./LiveSyncManagers";

describe("LiveSyncManagers", () => {
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
