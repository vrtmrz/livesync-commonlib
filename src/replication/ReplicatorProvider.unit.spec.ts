import { describe, expect, it, vi } from "vitest";
import {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_NOT_IMPLEMENTED,
    CAPABILITY_SUPPORT_KINDS,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    NO_INTERACTION,
    REPLICATION_COMPLETED,
    USER_INITIATED_REPLICATION_AUTHORITY,
    defineReplicatorProviderDefinitions,
    isReplicationCompleted,
    outcomeFromContinuousOpenReplication,
    outcomeFromFiniteOpenReplication,
    replicationFailed,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    supportedStopActiveTransfer,
    type ReplicatorProviderDefinition,
} from "./index.ts";
import { isActiveReplicatorContextBoundToSetting } from "./ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "./RemoteResource.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
import type { ReplicatorInstance } from "./ReplicatorInstance.ts";
import { CENTRAL_COMPATIBILITY_REJECTION_REASONS } from "./CentralCompatibility.ts";

function createReplicator(result: void | boolean) {
    return {
        initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
        openReplication: vi.fn().mockResolvedValue(result),
        terminateSync: vi.fn(),
        closeReplication: vi.fn(),
    } as unknown as ReplicatorInstance & {
        initializeDatabaseForReplication: ReturnType<typeof vi.fn>;
        openReplication: ReturnType<typeof vi.fn>;
        terminateSync: ReturnType<typeof vi.fn>;
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

    it("attaches a central compatibility recovery hint only to failed finite outcomes", () => {
        const recoveryHint = {
            reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED,
        } as const;

        expect(outcomeFromFiniteOpenReplication(false, recoveryHint)).toEqual({
            status: "failed",
            error: expect.any(Error),
            recoveryHint,
        });
        expect(replicationFailed("failed", recoveryHint)).toEqual({
            status: "failed",
            error: "failed",
            recoveryHint,
        });
        expect(outcomeFromFiniteOpenReplication(true, recoveryHint)).toBe(REPLICATION_COMPLETED);
    });

    it("accepts a continuous void result as an accepted start", () => {
        expect(outcomeFromContinuousOpenReplication(undefined)).toBe(REPLICATION_COMPLETED);
        expect(outcomeFromContinuousOpenReplication(true)).toBe(REPLICATION_COMPLETED);
        expect(outcomeFromContinuousOpenReplication(false).status).toBe("failed");
    });

    it("stops only the captured replicator and reports completion", async () => {
        const capturedReplicator = createReplicator(true);
        const otherReplicator = createReplicator(true);
        const stop = supportedStopActiveTransfer();
        if (stop.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) throw new Error("stop role should be supported");

        await expect(stop.run(capturedReplicator)).resolves.toBe(REPLICATION_COMPLETED);

        expect(capturedReplicator.terminateSync).toHaveBeenCalledOnce();
        expect(otherReplicator.terminateSync).not.toHaveBeenCalled();
    });

    it("reports a legacy termination failure", async () => {
        const replicator = createReplicator(true);
        const error = new Error("stop failed");
        replicator.terminateSync.mockImplementation(() => {
            throw error;
        });
        const stop = supportedStopActiveTransfer();
        if (stop.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) throw new Error("stop role should be supported");

        await expect(stop.run(replicator)).resolves.toEqual({ status: "failed", error });
    });

    it("passes manual and unattended interaction boundaries to the open adapter", async () => {
        const manualReplicator = createReplicator(true);
        const manual = supportedOpenReplicationOneShot();
        if (manual.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) throw new Error("manual role should be supported");
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
        if (unattended.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED)
            throw new Error("unattended role should be supported");
        await unattended.run(unattendedReplicator, {} as never, {
            trigger: "resume",
            interaction: NO_INTERACTION,
        });
        expect(unattendedReplicator.openReplication).toHaveBeenCalledWith({}, false, false, false);
    });

    it("does not authorise interaction for an unattended role", async () => {
        const replicator = createReplicator(true);
        const unattended = supportedOpenReplicationUnattended();
        if (unattended.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED)
            throw new Error("unattended role should be supported");
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

    it("fails closed when a detached setting no longer belongs to the active binding", () => {
        const isConfigured = vi.fn(() => true);
        const configurationIdentity = vi.fn(
            (setting: { activeConfigurationId?: string; remoteType: string }) =>
                setting.activeConfigurationId || setting.remoteType
        );
        const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured,
            configurationIdentity,
            create: async () => false,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const context = {
            provider,
            replicator: createReplicator(true),
            configurationIdentity: "profile-a",
        };

        expect(
            isActiveReplicatorContextBoundToSetting(context, {
                remoteType: REMOTE_COUCHDB,
                activeConfigurationId: "profile-a",
            } as never)
        ).toBe(true);
        expect(
            isActiveReplicatorContextBoundToSetting(context, {
                remoteType: REMOTE_COUCHDB,
                activeConfigurationId: "profile-b",
            } as never)
        ).toBe(false);
        expect(
            isActiveReplicatorContextBoundToSetting(context, {
                remoteType: REMOTE_MINIO,
                activeConfigurationId: "profile-a",
            } as never)
        ).toBe(false);

        configurationIdentity.mockImplementationOnce(() => {
            throw new Error("invalid edited setting");
        });
        expect(
            isActiveReplicatorContextBoundToSetting(context, {
                remoteType: REMOTE_COUCHDB,
                activeConfigurationId: "profile-a",
            } as never)
        ).toBe(false);
    });

    it("requires and validates the selected provider definition subset", () => {
        const couch: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: (setting) => setting.activeConfigurationId || setting.remoteType,
            create: async () => false,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: supportedOpenReplicationContinuous(),
            stopActiveTransfer: supportedStopActiveTransfer(),
        };
        const minio: ReplicatorProviderDefinition<typeof REMOTE_MINIO> = {
            kind: REMOTE_MINIO,
            diagnosticName: "Object Storage",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: (setting) => setting.activeConfigurationId || setting.remoteType,
            create: async () => false,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
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
