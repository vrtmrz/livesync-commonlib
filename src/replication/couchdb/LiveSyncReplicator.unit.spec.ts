import { describe, expect, it, vi } from "vitest";
import type { RemoteDBSettings } from "@lib/common/types.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";

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
