import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_SUPPORT_KINDS,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    NO_INTERACTION,
    REPLICATION_COMPLETED,
    REPLICATION_PROGRESS_PRESENTATIONS,
    USER_INITIATED_REPLICATION_AUTHORITY,
    replicationFailed,
    type ActiveReplicatorContext,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "@lib/replication/RemoteResource.ts";
import {
    TypedReplicationCoordinator,
    type TypedReplicationCoordinatorDependencies,
} from "./ReplicationService.typedReplication.ts";

function createHarness() {
    const replicator = {} as ActiveReplicatorContext["replicator"];
    const setting = { remoteType: REMOTE_COUCHDB } as const;
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
        create: async () => replicator,
        remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
        userInitiatedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: userInitiated },
        unattendedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: unattended },
        continuous: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: continuous },
        stopActiveTransfer: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: stop },
    };
    const context: ActiveReplicatorContext = {
        provider,
        replicator,
        configurationIdentity: "configuration-a",
    };
    const activityEvents: string[] = [];
    const getActiveReplicator = vi.fn(() => replicator);
    const runWithActiveReplicatorContext = vi.fn(async (task: (context: ActiveReplicatorContext) => unknown) =>
        task(context)
    );
    const dependencies = {
        replicatorService: {
            acquireActiveReplicatorContext: vi.fn(async () => context),
            getActiveReplicator,
            hasActiveReplicator: vi.fn(() => true),
            runWithActiveReplicatorContext,
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
            return setting;
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
        getActiveReplicator,
        provider,
        replicator,
        runWithActiveReplicatorContext,
        setting,
        stop,
        unattended,
        userInitiated,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

describe("TypedReplicationCoordinator", () => {
    it("admits both finite provider roles through their exact active publication", async () => {
        const { coordinator, runWithActiveReplicatorContext, unattended, userInitiated } = createHarness();

        await expect(
            coordinator.runUserInitiated({
                trigger: "manual",
                progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
                interaction: USER_INITIATED_REPLICATION_AUTHORITY,
            })
        ).resolves.toBe(REPLICATION_COMPLETED);
        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toBe(
            REPLICATION_COMPLETED
        );

        expect(runWithActiveReplicatorContext).toHaveBeenCalledTimes(2);
        expect(userInitiated).toHaveBeenCalledOnce();
        expect(unattended).toHaveBeenCalledOnce();
    });

    it.each([
        { owner: "user", contender: "user" },
        { owner: "user", contender: "unattended" },
        { owner: "unattended", contender: "user" },
        { owner: "unattended", contender: "unattended" },
    ] as const)(
        "blocks a later $contender OneShot request while another $owner request owns the attempt",
        async ({ owner, contender }) => {
            const { coordinator, dependencies, unattended, userInitiated } = createHarness();
            const ownerEntered = createDeferred<void>();
            const releaseOwner = createDeferred<void>();
            const ownerRunner = owner === "user" ? userInitiated : unattended;
            ownerRunner.mockImplementationOnce(async () => {
                ownerEntered.resolve();
                await releaseOwner.promise;
                return REPLICATION_COMPLETED;
            });
            const run = (role: "user" | "unattended") =>
                role === "user"
                    ? coordinator.runUserInitiated({
                          trigger: "manual",
                          progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
                          interaction: USER_INITIATED_REPLICATION_AUTHORITY,
                      })
                    : coordinator.runUnattended({ trigger: "periodic", interaction: NO_INTERACTION });

            const ownerAttempt = run(owner);
            await ownerEntered.promise;
            try {
                await expect(run(contender)).resolves.toEqual({
                    status: "blocked",
                    reason: "replication-in-progress",
                });
                expect(dependencies.checkReadiness).toHaveBeenCalledOnce();
                expect(userInitiated).toHaveBeenCalledTimes(owner === "user" ? 1 : 0);
                expect(unattended).toHaveBeenCalledTimes(owner === "unattended" ? 1 : 0);
            } finally {
                releaseOwner.resolve();
                await ownerAttempt;
            }
        }
    );

    it("releases a finite publication before invoking failure recovery", async () => {
        const { activityEvents, context, coordinator, dependencies, provider, runWithActiveReplicatorContext } =
            createHarness();
        const failure = replicationFailed(new Error("remote failed"));
        Object.assign(provider, {
            unattendedOneShot: {
                kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED,
                run: vi.fn(async () => {
                    activityEvents.push("provider-dispatch");
                    return failure;
                }),
            },
        });
        vi.mocked(dependencies.checkReadiness).mockImplementation(async () => {
            activityEvents.push("readiness");
            return true;
        });
        runWithActiveReplicatorContext.mockImplementation(async (task) => {
            activityEvents.push("publication-admitted");
            try {
                return await task(context);
            } finally {
                activityEvents.push("publication-released");
            }
        });

        await expect(coordinator.runUnattended({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toBe(
            failure
        );

        expect(activityEvents).toEqual([
            "readiness",
            "settings-read",
            "publication-admitted",
            "activity-started",
            "provider-dispatch",
            "activity-ended",
            "publication-released",
            "failure-handled",
            "finite-attempt-recorded",
        ]);
    });

    it("carries the exact failed attempt into recovery after its publication is replaced", async () => {
        const { context, coordinator, dependencies, provider, setting } = createHarness();
        const failure = Object.freeze(replicationFailed(new Error("remote failed")));
        const replacementContext: ActiveReplicatorContext = {
            provider,
            replicator: { replacement: true } as never,
            configurationIdentity: "configuration-a",
        };
        let activeContext = context;
        Object.assign(provider, {
            unattendedOneShot: {
                kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED,
                run: vi.fn(async () => {
                    activeContext = replacementContext;
                    return failure;
                }),
            },
        });
        vi.mocked(dependencies.replicatorService.hasActiveReplicator).mockImplementation(
            () => activeContext === context
        );
        vi.mocked(dependencies.handleFailure).mockImplementation(async (request: unknown) => {
            if (typeof request === "object" && request !== null && "context" in request) {
                const source = (request as { context: ActiveReplicatorContext }).context.replicator as {
                    recoveryTouched?: boolean;
                };
                source.recoveryTouched = true;
            }
            return false;
        });

        await expect(coordinator.runUnattended({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toBe(
            failure
        );

        expect(activeContext).toBe(replacementContext);
        // Recovery must receive the immutable provider result and its source
        // publication; it cannot reconstruct either from the replacement.
        expect(dependencies.handleFailure).toHaveBeenCalledWith({
            context,
            setting,
            outcome: failure,
            progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
            interaction: NO_INTERACTION,
        });
        expect((context.replicator as { recoveryTouched?: boolean }).recoveryTouched).toBe(true);
        expect((replacementContext.replicator as { recoveryTouched?: boolean }).recoveryTouched).toBeUndefined();
    });

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

    it("does not dispatch work prepared for a publication replaced after readiness", async () => {
        const { context, coordinator, dependencies, runWithActiveReplicatorContext, unattended } = createHarness();
        const replacementContext: ActiveReplicatorContext = {
            ...context,
            replicator: { replacement: true } as never,
        };
        runWithActiveReplicatorContext.mockImplementation(async (task) => await task(replacementContext));

        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "not-ready",
        });

        expect(dependencies.checkReadiness).toHaveBeenCalledOnce();
        expect(unattended).not.toHaveBeenCalled();
        expect(dependencies.replicatorService.runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(dependencies.recordFiniteAttempt).toHaveBeenCalledOnce();
    });

    it("does not dispatch continuous work prepared for a publication replaced after readiness", async () => {
        const { context, continuous, coordinator, dependencies, runWithActiveReplicatorContext } = createHarness();
        const replacementContext: ActiveReplicatorContext = {
            ...context,
            replicator: { replacement: true } as never,
        };
        let markReadinessStarted!: () => void;
        const readinessStarted = new Promise<void>((resolve) => {
            markReadinessStarted = resolve;
        });
        let releaseReadiness!: () => void;
        const readinessGate = new Promise<void>((resolve) => {
            releaseReadiness = resolve;
        });
        vi.mocked(dependencies.checkReadiness).mockImplementation(async () => {
            markReadinessStarted();
            await readinessGate;
            return true;
        });
        runWithActiveReplicatorContext.mockImplementation(async (task) => await task(replacementContext));

        const start = coordinator.startContinuous({ trigger: "daemon", interaction: NO_INTERACTION });
        await readinessStarted;
        releaseReadiness();

        await expect(start).resolves.toEqual({
            status: "blocked",
            reason: "not-ready",
        });
        expect(dependencies.checkReadiness).toHaveBeenCalledWith(false, context.provider.readiness);
        expect(runWithActiveReplicatorContext).toHaveBeenCalledOnce();
        expect(continuous).not.toHaveBeenCalled();
    });

    it("finishes finite activity before notifying failure recovery", async () => {
        const { activityEvents, coordinator, dependencies, provider } = createHarness();
        const failure = replicationFailed(new Error("remote failed"));
        Object.assign(provider, {
            unattendedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: vi.fn(async () => failure) },
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
        expect(dependencies.handleFailure).toHaveBeenCalledWith({
            context: expect.anything(),
            setting: expect.objectContaining({ remoteType: REMOTE_COUCHDB }),
            outcome: failure,
            progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
            interaction: NO_INTERACTION,
        });
        expect(dependencies.recordFiniteAttempt).toHaveBeenCalledOnce();
    });

    it("passes narrowed user authority and independent presentation to the provider and failure boundary", async () => {
        const { coordinator, dependencies, provider } = createHarness();
        const interaction = {
            kind: "permitted" as const,
            permissions: { ...USER_INITIATED_REPLICATION_AUTHORITY.permissions, failureRecovery: false },
        };
        const failure = replicationFailed(new Error("remote failed"));
        const userInitiated = vi.fn(async () => failure);
        Object.assign(provider, {
            userInitiatedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: userInitiated },
        });

        await expect(
            coordinator.runUserInitiated({
                trigger: "manual",
                progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
                interaction,
            })
        ).resolves.toBe(failure);

        expect(userInitiated).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
            trigger: "manual",
            progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
            interaction,
        });
        expect(dependencies.handleFailure).toHaveBeenCalledWith({
            context: expect.anything(),
            setting: expect.objectContaining({ remoteType: REMOTE_COUCHDB }),
            outcome: failure,
            progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
            interaction,
        });
        expect(provider.userInitiatedOneShot.kind).toBe(CAPABILITY_SUPPORT_KINDS.SUPPORTED);
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
        vi.mocked(absent.dependencies.replicatorService.hasActiveReplicator).mockReturnValue(false);
        await expect(
            absent.coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })
        ).resolves.toEqual({ status: "blocked", reason: "no-active-replicator" });
        expect(absent.dependencies.recordFiniteAttempt).not.toHaveBeenCalled();
    });

    it("returns a silent no-active result when typed acquisition has no provider or Replicator", async () => {
        const { coordinator, dependencies, getActiveReplicator } = createHarness();
        vi.mocked(dependencies.replicatorService.acquireActiveReplicatorContext).mockResolvedValue(undefined);
        const hasActiveReplicator = vi.mocked(dependencies.replicatorService.hasActiveReplicator);
        hasActiveReplicator.mockReturnValue(false);

        await expect(coordinator.runUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "no-active-replicator",
        });
        expect(hasActiveReplicator).toHaveBeenCalledOnce();
        expect(getActiveReplicator).not.toHaveBeenCalled();
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

    it("does not invoke explicit stop on a context retired after capture", async () => {
        const { context, coordinator, dependencies, replicator, runWithActiveReplicatorContext, stop } =
            createHarness();
        const replacementContext: ActiveReplicatorContext = {
            ...context,
            replicator: { replacement: true } as never,
        };
        runWithActiveReplicatorContext.mockImplementation(async (task) => await task(replacementContext));

        await expect(coordinator.stopActiveTransfer()).resolves.toEqual({
            status: "blocked",
            reason: "not-ready",
        });

        expect(runWithActiveReplicatorContext).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalledWith(replicator);
    });
});
