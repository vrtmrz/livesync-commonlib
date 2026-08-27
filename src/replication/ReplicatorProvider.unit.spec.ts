import { describe, expect, it, vi } from "vitest";
import {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_NOT_IMPLEMENTED,
    NO_INTERACTION,
    REPLICATION_COMPLETED,
    USER_INITIATED_REPLICATION_AUTHORITY,
    defineReplicatorProviderDefinitions,
    isReplicationCompleted,
    outcomeFromContinuousOpenReplication,
    outcomeFromFiniteOpenReplication,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    type ReplicatorProviderDefinition,
} from "./index.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "./LiveSyncAbstractReplicator.ts";

function createReplicator(result: void | boolean) {
    return {
        openReplication: vi.fn().mockResolvedValue(result),
    } as unknown as LiveSyncAbstractReplicator & {
        openReplication: ReturnType<typeof vi.fn>;
    };
}

describe("replicator provider contract", () => {
    it("keeps finite false and void results as failures", () => {
        expect(outcomeFromFiniteOpenReplication(false).status).toBe("failed");
        expect(outcomeFromFiniteOpenReplication(undefined).status).toBe("failed");
        expect(outcomeFromFiniteOpenReplication(true)).toBe(REPLICATION_COMPLETED);
        expect(isReplicationCompleted(REPLICATION_COMPLETED)).toBe(true);
        expect(isReplicationCompleted(outcomeFromFiniteOpenReplication(false))).toBe(false);
    });

    it("accepts a continuous void result as an accepted start", () => {
        expect(outcomeFromContinuousOpenReplication(undefined)).toBe(REPLICATION_COMPLETED);
        expect(outcomeFromContinuousOpenReplication(true)).toBe(REPLICATION_COMPLETED);
        expect(outcomeFromContinuousOpenReplication(false).status).toBe("failed");
    });

    it("passes manual and unattended interaction boundaries to the open adapter", async () => {
        const manualReplicator = createReplicator(true);
        const manual = supportedOpenReplicationOneShot();
        if (manual.kind !== "supported") throw new Error("manual role should be supported");
        const narrowedAuthority = {
            kind: "permitted" as const,
            permissions: { ...USER_INITIATED_REPLICATION_AUTHORITY.permissions, failureRecovery: false },
        };
        await manual.run(manualReplicator, {} as never, {
            trigger: "manual",
            interaction: narrowedAuthority,
        });
        expect(manualReplicator.openReplication).toHaveBeenCalledWith({}, false, false, false);

        const unattendedReplicator = createReplicator(true);
        const unattended = supportedOpenReplicationUnattended();
        if (unattended.kind !== "supported") throw new Error("unattended role should be supported");
        await unattended.run(unattendedReplicator, {} as never, {
            trigger: "resume",
            interaction: NO_INTERACTION,
        });
        expect(unattendedReplicator.openReplication).toHaveBeenCalledWith({}, false, false, false);
    });

    it("does not authorise interaction for an unattended role", async () => {
        const replicator = createReplicator(true);
        const unattended = supportedOpenReplicationUnattended();
        if (unattended.kind !== "supported") throw new Error("unattended role should be supported");
        const result = await unattended.run(replicator, {} as never, {
            trigger: "daemon",
            interaction: USER_INITIATED_REPLICATION_AUTHORITY as never,
        });
        expect(result).toEqual({ status: "blocked", reason: "interaction-required" });
        expect(replicator.openReplication).not.toHaveBeenCalled();
    });

    it("declares explicit unsupported capability states", () => {
        expect(CAPABILITY_NOT_IMPLEMENTED).toEqual({
            kind: "not-implemented",
            reason: "capability-not-implemented",
        });
        expect(CAPABILITY_NOT_APPLICABLE).toEqual({
            kind: "not-applicable",
            reason: "capability-not-applicable",
        });
    });

    it("requires and validates the selected provider definition subset", () => {
        const couch: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            isConfigured: () => true,
            create: async () => false,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
        };
        const minio: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            isConfigured: () => true,
            create: async () => false,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
        };

        const definitions = defineReplicatorProviderDefinitions([REMOTE_COUCHDB, REMOTE_MINIO] as const, {
            [REMOTE_COUCHDB]: couch,
            [REMOTE_MINIO]: minio,
        });
        expect(definitions.get(REMOTE_COUCHDB)).toBe(couch);
        expect(definitions.get(REMOTE_MINIO)).toBe(minio);
        expect(() =>
            defineReplicatorProviderDefinitions(
                [REMOTE_COUCHDB] as const,
                {
                    [REMOTE_COUCHDB]: { ...couch, kind: REMOTE_MINIO },
                } as never
            )
        ).toThrow("does not match");
    });
});
