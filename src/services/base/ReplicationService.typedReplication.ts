import type { ObsidianLiveSyncSettings } from "@lib/common/types.ts";
import {
    CAPABILITY_SUPPORT_KINDS,
    NO_INTERACTION,
    REPLICATION_PROGRESS_PRESENTATIONS,
    isActiveReplicatorContextBoundToSetting,
    replicationBlocked,
    replicationFailed,
    type ActiveReplicatorContext,
    type ContinuousReplicationRequest,
    type InteractionAuthority,
    type ReplicationFailureRequest,
    type ReplicationOutcome,
    type ReplicationProgressPresentation,
    type ReplicationReadinessRequirements,
    type UnattendedOneShotRequest,
    type UserInitiatedOneShotRequest,
} from "@lib/replication/ReplicatorProvider.ts";
import type { IReplicatorService } from "./IService.ts";
import { asCopy } from "@lib/common/utils.object.ts";

/** ReplicationService collaborators required to execute typed provider roles. */
export interface TypedReplicationCoordinatorDependencies {
    readonly replicatorService: Pick<
        IReplicatorService,
        | "acquireActiveReplicatorContext"
        | "hasActiveReplicator"
        | "runWithActiveReplicatorContext"
        | "runFiniteReplicationActivity"
    >;
    readonly currentSettings: () => ObsidianLiveSyncSettings;
    readonly checkReadiness: (showMessage: boolean, readiness: ReplicationReadinessRequirements) => Promise<boolean>;
    readonly handleFailure: (request: ReplicationFailureRequest) => Promise<boolean>;
    /**
     * Advance the host's finite-attempt clock after readiness admits dispatch.
     *
     * This includes a provider-declared blocked capability, because the legacy
     * service advanced its event rate-limit clock at the same boundary.
     */
    readonly recordFiniteAttempt: () => void;
}

/**
 * Execute typed provider capabilities against one captured active context.
 *
 * The coordinator owns capability selection, readiness dispatch, finite
 * activity accounting, and failure notification. It does not own event rate
 * limiting, legacy Replicator calls, or the active Replicator lifecycle.
 *
 * Each role is deliberately expressed as a separate control flow. Readiness,
 * interaction authority, activity accounting, and failure handling differ by
 * role, so a flag-driven capability table would conceal lifecycle decisions
 * which callers and reviewers need to see explicitly.
 */
export class TypedReplicationCoordinator {
    private oneShotInProgress = false;

    constructor(private readonly dependencies: TypedReplicationCoordinatorDependencies) {}

    /**
     * Execute a user-initiated finite role with the request's interaction authority.
     *
     * The active context is acquired atomically, readiness runs before
     * capability dispatch, and the settings snapshot is captured before the
     * finite activity begins. A failed result invokes recovery only after that
     * activity has settled.
     */
    async runUserInitiated(request: UserInitiatedOneShotRequest): Promise<ReplicationOutcome> {
        return await this.runOneShot(async () => {
            const showProgress = request.progressPresentation === REPLICATION_PROGRESS_PRESENTATIONS.NOTICE;
            const ready = await this.acquireReadyContext(showProgress);
            if ("status" in ready) return ready;

            const capability = ready.provider.userInitiatedOneShot;
            if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
                return this.finishFiniteAttempt(replicationBlocked(capability.reason));
            }
            const settings = Object.freeze(asCopy(this.dependencies.currentSettings()));
            return this.finishFiniteAttempt(
                await this.runAdmittedFiniteActivity(
                    ready,
                    (context) => capability.run(context.replicator, settings, request),
                    settings,
                    request.interaction,
                    request.progressPresentation
                )
            );
        });
    }

    /**
     * Execute an unattended finite role without granting interaction authority.
     *
     * Requests carrying interaction authority are rejected before context
     * acquisition. Accepted requests otherwise retain the same readiness,
     * settings-snapshot, activity, and recovery ordering as user work.
     */
    async runUnattended(request: UnattendedOneShotRequest): Promise<ReplicationOutcome> {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        return await this.runOneShot(async () => {
            const ready = await this.acquireReadyContext(false);
            if ("status" in ready) return ready;

            const capability = ready.provider.unattendedOneShot;
            if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
                return this.finishFiniteAttempt(replicationBlocked(capability.reason));
            }
            const settings = Object.freeze(asCopy(this.dependencies.currentSettings()));
            return this.finishFiniteAttempt(
                await this.runAdmittedFiniteActivity(
                    ready,
                    (context) => capability.run(context.replicator, settings, request),
                    settings,
                    NO_INTERACTION,
                    REPLICATION_PROGRESS_PRESENTATIONS.QUIET
                )
            );
        });
    }

    /**
     * Start the provider's continuous role outside finite activity accounting.
     *
     * Capability applicability is established before readiness, because an
     * inapplicable long-lived role must not trigger unrelated preparation or
     * diagnostics. After readiness, the short startup call is admitted against
     * that exact publication. The provider owns the registered long-lived task
     * after startup settles; it does not retain this admission for its lifetime.
     * Startup failures become typed outcomes without invoking the finite-operation
     * recovery handler.
     */
    async startContinuous(request: ContinuousReplicationRequest): Promise<ReplicationOutcome> {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        const context = await this.acquireContext();
        if ("status" in context) return context;

        // Capability support is checked before readiness so an inapplicable
        // role does not trigger unrelated probes or user-facing diagnostics.
        const capability = context.provider.continuous;
        if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
            return replicationBlocked(capability.reason);
        }
        const ready = await this.acquireReadyContext(false, context);
        if ("status" in ready) return ready;
        const setting = Object.freeze(asCopy(this.dependencies.currentSettings()));
        const admitted = await this.dependencies.replicatorService.runWithActiveReplicatorContext(
            async (activeContext) => {
                if (activeContext !== ready || !isActiveReplicatorContextBoundToSetting(activeContext, setting)) {
                    return replicationBlocked("not-ready");
                }
                try {
                    return await capability.run(activeContext.replicator, setting, request);
                } catch (error) {
                    return replicationFailed(error);
                }
            }
        );
        return admitted ?? replicationBlocked("no-active-replicator");
    }

    /**
     * Request transfer cancellation on one atomically acquired active context.
     *
     * Cancellation deliberately bypasses readiness, activity accounting, and
     * failure-recovery handlers: it is an operator control over existing work,
     * not a request to begin new remote work.
     */
    async stopActiveTransfer(): Promise<ReplicationOutcome> {
        const context = await this.acquireContext();
        if ("status" in context) return context;

        const capability = context.provider.stopActiveTransfer;
        if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
            return replicationBlocked(capability.reason);
        }
        const admitted = await this.dependencies.replicatorService.runWithActiveReplicatorContext(
            async (activeContext) => {
                if (activeContext !== context) return replicationBlocked("not-ready");
                try {
                    return await capability.run(activeContext.replicator);
                } catch (error) {
                    return replicationFailed(error);
                }
            }
        );
        return admitted ?? replicationBlocked("no-active-replicator");
    }

    /**
     * Admit one complete typed OneShot attempt for this service instance.
     *
     * Ownership is recorded before the operation reaches its first await and is
     * retained through readiness, provider work, activity settlement, and
     * failure handling. Later requests are neither queued nor joined: they
     * settle immediately so repeated UI actions cannot replay after the owner.
     */
    private async runOneShot(run: () => Promise<ReplicationOutcome>): Promise<ReplicationOutcome> {
        if (this.oneShotInProgress) return replicationBlocked("replication-in-progress");
        this.oneShotInProgress = true;
        try {
            return await run();
        } finally {
            this.oneShotInProgress = false;
        }
    }

    private finishFiniteAttempt(outcome: ReplicationOutcome): ReplicationOutcome {
        // The attempt clock advances after readiness even when the provider
        // declares the role unavailable; this preserves event-rate semantics.
        this.dependencies.recordFiniteAttempt();
        return outcome;
    }

    private async acquireContext(): Promise<ActiveReplicatorContext | ReplicationOutcome> {
        // Acquire the provider and Replicator atomically after queued ownership
        // transitions. Never combine a capability with a later Replicator.
        const context = await this.dependencies.replicatorService.acquireActiveReplicatorContext();
        if (context) return context;
        return this.dependencies.replicatorService.hasActiveReplicator()
            ? replicationBlocked("provider-not-composed")
            : replicationBlocked("no-active-replicator");
    }

    private async acquireReadyContext(
        showMessage: boolean,
        contextOverride?: ActiveReplicatorContext
    ): Promise<ActiveReplicatorContext | ReplicationOutcome> {
        const context = contextOverride ?? (await this.acquireContext());
        if ("status" in context) return context;
        if (!(await this.dependencies.checkReadiness(showMessage, context.provider.readiness))) {
            return replicationBlocked("not-ready");
        }
        return context;
    }

    private async runFiniteActivity(run: () => Promise<ReplicationOutcome>): Promise<ReplicationOutcome> {
        try {
            return await this.dependencies.replicatorService.runFiniteReplicationActivity(run, {
                label: "replication",
            });
        } catch (error) {
            return replicationFailed(error);
        }
    }

    /**
     * Reserve the readiness-tested publication for provider dispatch.
     *
     * Readiness and settings capture intentionally happen before admission. If
     * an ownership transition completes in between, the newly admitted context
     * is rejected instead of running work prepared for an older publication.
     * Failure recovery runs only after the reservation has been released.
     */
    private async runAdmittedFiniteActivity(
        expectedContext: ActiveReplicatorContext,
        run: (context: ActiveReplicatorContext) => Promise<ReplicationOutcome>,
        setting: ObsidianLiveSyncSettings,
        interaction: InteractionAuthority,
        progressPresentation: ReplicationProgressPresentation
    ): Promise<ReplicationOutcome> {
        const admitted = await this.dependencies.replicatorService.runWithActiveReplicatorContext((context) => {
            if (context !== expectedContext || !isActiveReplicatorContextBoundToSetting(context, setting)) {
                return replicationBlocked("not-ready");
            }
            return this.runFiniteActivity(() => run(context));
        });
        const result = admitted ?? replicationBlocked("no-active-replicator");
        // Failure recovery starts only after both finite activity accounting
        // and publication admission have settled. It may queue lifecycle work
        // which must never wait on its own reservation.
        if (result.status === "failed") {
            await this.dependencies.handleFailure(
                Object.freeze({
                    context: expectedContext,
                    setting,
                    outcome: result,
                    progressPresentation,
                    interaction,
                })
            );
        }
        return result;
    }
}
