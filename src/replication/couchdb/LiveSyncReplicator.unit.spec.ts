import { describe, expect, it, vi } from "vitest";
import type { RemoteDBSettings } from "@lib/common/types.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import { checkRemoteVersion } from "@lib/pouchdb/negotiation.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";

vi.mock("@lib/pouchdb/negotiation.ts", () => ({
    checkRemoteVersion: vi.fn(),
    countCompromisedChunks: vi.fn(),
}));

describe("LiveSyncCouchDBReplicator continuous catch-up", () => {
    it("exposes the initial pull-only catch-up as finite replication activity", async () => {
        const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                context: createServiceContext(),
                database: {
                    localDatabase: {
                        localDatabase: {},
                    },
                },
                replicator: {
                    runFiniteReplicationActivity,
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        const catchUp = vi.spyOn(replicator, "openOneShotReplication").mockResolvedValue(false);
        const setting = {} as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledOnce();
        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), { label: "replication" });
        expect(catchUp).toHaveBeenCalledWith(setting, false, false, "pullOnly");
    });

    it("starts another finite catch-up when the live channel retries with smaller batches", async () => {
        const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                context: createServiceContext(),
                database: {
                    localDatabase: { localDatabase },
                },
                replicator: { runFiniteReplicationActivity },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        const catchUp = vi
            .spyOn(replicator, "openOneShotReplication")
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
            db: {},
            info: { update_seq: 9 },
            syncOption: {},
        } as never);
        vi.spyOn(replicator, "processSync").mockResolvedValue("NEED_RETRY");
        const setting = {
            batch_size: 20,
            batches_limit: 20,
        } as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledTimes(2);
        expect(catchUp).toHaveBeenNthCalledWith(1, setting, false, false, "pullOnly");
        expect(catchUp).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ batch_size: 12, batches_limit: 12 }),
            false,
            false,
            "pullOnly"
        );
    });
});

function createOneShotReplicator(remoteDatabase: { close: () => Promise<void> }) {
    const localDatabase = {
        info: vi.fn().mockResolvedValue({ update_seq: 7 }),
        sync: vi.fn(() => ({})),
    };
    const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
    replicator.env = {
        services: {
            context: createServiceContext(),
            database: { localDatabase: { localDatabase } },
        },
    } as unknown as LiveSyncCouchDBReplicator["env"];
    replicator.docArrived = 0;
    replicator.docSent = 0;
    replicator.updateInfo = vi.fn();
    replicator.terminateSync = vi.fn();
    vi.spyOn(replicator, "ensurePBKDF2Salt").mockResolvedValue(true);
    vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
        db: remoteDatabase,
        info: { update_seq: 9 },
        syncOptionBase: {},
    } as never);
    return replicator;
}

describe("LiveSyncCouchDBReplicator one-shot connection ownership", () => {
    it.each([
        ["DONE", true],
        ["FAILED", false],
    ] as const)("closes the remote database after %s", async (syncResult, expected) => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(replicator, "processSync").mockResolvedValue(syncResult);

        await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
            expected
        );

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it("closes a connection when connectivity checks cannot transfer ownership", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.translate = vi.fn((key) => key);
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
        } as never);
        vi.mocked(checkRemoteVersion).mockResolvedValueOnce(false);

        await expect(
            replicator.checkReplicationConnectivity(
                { versionUpFlash: "", couchDB_URI: "https://example.test", couchDB_DBNAME: "db" } as RemoteDBSettings,
                false,
                false,
                false
            )
        ).resolves.toBe(false);

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it.each(["NEED_RETRY", "NEED_RESURRECT"] as const)("waits for close before %s starts", async (syncResult) => {
        const events: string[] = [];
        const remoteDatabase = {
            close: vi.fn(async () => {
                await Promise.resolve();
                events.push("closed");
            }),
        };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(replicator, "processSync").mockResolvedValue(syncResult);
        vi.mocked(replicator.checkReplicationConnectivity)
            .mockResolvedValueOnce({
                db: remoteDatabase,
                info: { update_seq: 9 },
                syncOptionBase: {},
            } as never)
            .mockImplementationOnce(async () => {
                events.push("restarted");
                return false;
            });
        const setting = { batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

        await replicator.openOneShotReplication(setting, false, false, "sync");

        expect(events).toEqual(["closed", "restarted"]);
    });

    it("logs a close failure without replacing the replication result", async () => {
        const closeError = new Error("close failed");
        const remoteDatabase = { close: vi.fn().mockRejectedValue(closeError) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(replicator, "processSync").mockResolvedValue("DONE");
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
                true
            );
            expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
            expect(logger).toHaveBeenCalledWith(closeError, expect.anything(), "sync");
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("logs a close failure without preventing retry", async () => {
        const remoteDatabase = { close: vi.fn().mockRejectedValue(new Error("close failed")) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(replicator, "processSync").mockResolvedValue("NEED_RETRY");
        vi.mocked(replicator.checkReplicationConnectivity)
            .mockResolvedValueOnce({
                db: remoteDatabase,
                info: { update_seq: 9 },
                syncOptionBase: {},
            } as never)
            .mockResolvedValueOnce(false);
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await replicator.openOneShotReplication(
                { batch_size: 20, batches_limit: 20 } as RemoteDBSettings,
                false,
                false,
                "sync"
            );
            expect(replicator.checkReplicationConnectivity).toHaveBeenCalledTimes(2);
            expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });
});
