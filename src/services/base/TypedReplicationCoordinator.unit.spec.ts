import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    NO_INTERACTION,
    REPLICATION_COMPLETED,
    REPLACE_SAME_KIND_REPLICATOR,
    USER_INITIATED_REPLICATION_AUTHORITY,
    replicationFailed,
    type ActiveReplicatorContext,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "@lib/replication/RemoteResource.ts";
import {
    TypedReplicationCoordinator,
    type TypedReplicationCoordinatorDependencies,
} from "./TypedReplicationCoordinator.ts";

function createHarness() {
    const replicator = {} as ActiveReplicatorContext["replicator"];
    const userInitiated = vi.fn(async () => REPLICATION_COMPLETED);
    const unattended = vi.fn(async () => REPLICATION_COMPLETED);
    const continuous = vi.fn(async () => REPLICATION_COMPLETED);
    const stop = vi.fn(async () => REPLICATION_COMPLETED);
    const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
        kind: REMOTE_COUCHDB,
        diagnosticName: "CouchDB",
        readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
        isConfigured: () => true,
        configurationIdentity: () => "configuration-a",
        sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
        create: async () => replicator,
        remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
        remoteAdministration: CAPABILITY_NOT_APPLICABLE,
        userInitiatedOneShot: { kind: "supported", run: userInitiated },
        unattendedOneShot: { kind: "supported", run: unattended },
        continuous: { kind: "supported", run: continuous },
        stopActiveTransfer: { kind: "supported", run: stop },
    };
    const context: ActiveReplicatorContext = { provider, replicator };
    const activityEvents: string[] = [];
    const dependencies = {
        replicatorService: {
            acquireActiveReplicatorContext: vi.fn(async () => context),
            getActiveReplicator: vi.fn(() => replicator),
            runFiniteReplicationActivity: vi.fn(async (task: () => Promise<unknown>) => {
                activityEvents.push("activity-started");
                try {
                    return await task();
                } finally {
                    activityEvents.push("activity-ended");
                }
            }),
        },
        currentSettings: vi.fn(() => {
            activityEvents.push("settings-read");
            return { remoteType: REMOTE_COUCHDB };
        }),
        checkReadiness: vi.fn(async () => true),
        handleFailure: vi.fn(async () => {
            activityEvents.push("failure-handled");
            return false;
        }),
        recordFiniteAttempt: vi.fn(() => {
            activityEvents.push("finite-attempt-recorded");
        }),
    } as unknown as TypedReplicationCoordinatorDependencies;
    return {
        activityEvents,
        context,
        continuous,
        coordinator: new TypedReplicationCoordinator(dependencies),
        dependencies,
        provider,
        replicator,
        stop,
        unattended,
        userInitiated,
    };
}

describe("TypedReplicationCoordinator", () => {
    it("uses one captured context for readiness and unattended capability dispatch", async () => {
        const { context, coordinator, dependencies, unattended } = createHarness();

        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toBe(
            REPLICATION_COMPLETED
        );

        expect(dependencies.replicatorService.acquireActiveReplicatorContext).toHaveBeenCalledOnce();
        expect(dependencies.checkReadiness).toHaveBeenCalledWith(false, context.provider.readiness);
        expect(unattended).toHaveBeenCalledWith(
            context.replicator,
            expect.objectContaining({ remoteType: REMOTE_COUCHDB }),
            { trigger: "resume", interaction: NO_INTERACTION }
        );
        expect(dependencies.recordFiniteAttempt).toHaveBeenCalledOnce();
    });

    it("finishes finite activity before notifying failure recovery", async () => {
        const { activityEvents, coordinator, dependencies, provider } = createHarness();
        const failure = replicationFailed(new Error("remote failed"));
        Object.assign(provider, {
            unattendedOneShot: { kind: "supported", run: vi.fn(async () => failure) },
        });

        await expect(coordinator.runUnattended({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toBe(
            failure
        );

        expect(activityEvents).toEqual([
            "settings-read",
            "activity-started",
            "activity-ended",
            "failure-handled",
            "finite-attempt-recorded",
        ]);
        expect(dependencies.handleFailure).toHaveBeenCalledWith(false, NO_INTERACTION);
        expect(dependencies.recordFiniteAttempt).toHaveBeenCalledOnce();
    });

    it("passes narrowed user authority to the provider and failure boundary", async () => {
        const { coordinator, dependencies, provider } = createHarness();
        const interaction = {
            kind: "permitted" as const,
            permissions: { ...USER_INITIATED_REPLICATION_AUTHORITY.permissions, failureRecovery: false },
        };
        const failure = replicationFailed(new Error("remote failed"));
        const userInitiated = vi.fn(async () => failure);
        Object.assign(provider, {
            userInitiatedOneShot: { kind: "supported", run: userInitiated },
        });

        await expect(coordinator.runUserInitiated({ trigger: "manual", interaction })).resolves.toBe(failure);

        expect(userInitiated).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
            trigger: "manual",
            interaction,
        });
        expect(dependencies.handleFailure).toHaveBeenCalledWith(false, interaction);
        expect(provider.userInitiatedOneShot.kind).toBe("supported");
    });

    it("records a provider-declared finite block after readiness admits dispatch", async () => {
        const { coordinator, dependencies, provider } = createHarness();
        Object.assign(provider, { unattendedOneShot: CAPABILITY_NOT_APPLICABLE });

        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "capability-not-applicable",
        });

        expect(dependencies.checkReadiness).toHaveBeenCalledOnce();
        expect(dependencies.replicatorService.runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(dependencies.recordFiniteAttempt).toHaveBeenCalledOnce();
    });

    it("does not record a finite attempt when readiness rejects dispatch", async () => {
        const { coordinator, dependencies } = createHarness();
        vi.mocked(dependencies.checkReadiness).mockResolvedValue(false);

        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "not-ready",
        });

        expect(dependencies.replicatorService.runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(dependencies.recordFiniteAttempt).not.toHaveBeenCalled();
    });

    it("distinguishes an uncomposed legacy Replicator from no active Replicator", async () => {
        const legacy = createHarness();
        vi.mocked(legacy.dependencies.replicatorService.acquireActiveReplicatorContext).mockResolvedValue(undefined);
        await expect(
            legacy.coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })
        ).resolves.toEqual({ status: "blocked", reason: "provider-not-composed" });

        const absent = createHarness();
        vi.mocked(absent.dependencies.replicatorService.acquireActiveReplicatorContext).mockResolvedValue(undefined);
        vi.mocked(absent.dependencies.replicatorService.getActiveReplicator).mockReturnValue(undefined);
        await expect(
            absent.coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })
        ).resolves.toEqual({ status: "blocked", reason: "no-active-replicator" });
        expect(absent.dependencies.recordFiniteAttempt).not.toHaveBeenCalled();
    });

    it("returns an unsupported continuous role before running readiness", async () => {
        const { coordinator, dependencies, provider } = createHarness();
        Object.assign(provider, { continuous: CAPABILITY_NOT_APPLICABLE });

        await expect(coordinator.startContinuous({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "capability-not-applicable",
        });

        expect(dependencies.checkReadiness).not.toHaveBeenCalled();
    });

    it("maps a thrown continuous error without invoking finite activity or recovery", async () => {
        const { continuous, coordinator, dependencies } = createHarness();
        const error = new Error("continuous start failed");
        continuous.mockRejectedValue(error);

        await expect(coordinator.startContinuous({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "failed",
            error,
        });

        expect(dependencies.replicatorService.runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(dependencies.handleFailure).not.toHaveBeenCalled();
    });

    it("stops the captured transfer without readiness, finite activity, or recovery", async () => {
        const { coordinator, dependencies, replicator, stop } = createHarness();

        await expect(coordinator.stopActiveTransfer()).resolves.toBe(REPLICATION_COMPLETED);

        expect(stop).toHaveBeenCalledWith(replicator);
        expect(dependencies.checkReadiness).not.toHaveBeenCalled();
        expect(dependencies.replicatorService.runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(dependencies.handleFailure).not.toHaveBeenCalled();
    });
});
