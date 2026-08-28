import type { ObsidianLiveSyncSettings } from "@lib/common/types.ts";
import {
    NO_INTERACTION,
    replicationBlocked,
    replicationFailed,
    type ActiveReplicatorContext,
    type CapabilitySupport,
    type ContinuousReplicationRequest,
    type InteractionAuthority,
    type ReplicationOutcome,
    type ReplicationReadinessRequirements,
    type UnattendedOneShotRequest,
    type UserInitiatedOneShotRequest,
} from "@lib/replication/ReplicatorProvider.ts";
import type { IReplicatorService } from "./IService.ts";

/** Collaborators required to execute roles declared by a typed Replicator provider. */
export interface TypedReplicationCoordinatorDependencies {
    readonly replicatorService: Pick<
        IReplicatorService,
        "acquireActiveReplicatorContext" | "getActiveReplicator" | "runFiniteReplicationActivity"
    >;
    readonly currentSettings: () => ObsidianLiveSyncSettings;
    readonly checkReadiness: (showMessage: boolean, readiness: ReplicationReadinessRequirements) => Promise<boolean>;
    readonly handleFailure: (showMessage: boolean, interaction: InteractionAuthority) => Promise<boolean>;
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
        const showMessage = request.interaction.kind === "permitted" && request.interaction.permissions.failureRecovery;
        const ready = await this.acquireReadyContext(showMessage);
        if ("status" in ready) return ready;

        const capability = ready.provider.userInitiatedOneShot;
        if (capability.kind !== "supported") {
            return this.finishFiniteAttempt(replicationBlocked(capability.reason));
        }
        const settings = this.dependencies.currentSettings();
        return this.finishFiniteAttempt(
            await this.runFiniteActivity(
                () => capability.run(ready.replicator, settings, request),
                request.interaction,
                showMessage
            )
        );
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
        const ready = await this.acquireReadyContext(false);
        if ("status" in ready) return ready;

        const capability = ready.provider.unattendedOneShot;
        if (capability.kind !== "supported") {
            return this.finishFiniteAttempt(replicationBlocked(capability.reason));
        }
        const settings = this.dependencies.currentSettings();
        return this.finishFiniteAttempt(
            await this.runFiniteActivity(
                () => capability.run(ready.replicator, settings, request),
                NO_INTERACTION,
                false
            )
        );
    }

    /**
     * Start the provider's continuous role outside finite activity accounting.
     *
     * Capability applicability is established before readiness, because an
     * inapplicable long-lived role must not trigger unrelated preparation or
     * diagnostics. Startup failures become typed outcomes without invoking the
     * finite-operation recovery handler.
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
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        const ready = await this.acquireReadyContext(false, context);
        if ("status" in ready) return ready;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        try {
            return await capability.run(ready.replicator, this.dependencies.currentSettings(), request);
        } catch (error) {
            return replicationFailed(error);
        }
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
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        try {
            return await capability.run(context.replicator);
        } catch (error) {
            return replicationFailed(error);
        }
    }

    private capabilityBlocked<TRole>(capability: CapabilitySupport<TRole>): ReplicationOutcome | undefined {
        return capability.kind === "supported" ? undefined : replicationBlocked(capability.reason);
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
        return this.dependencies.replicatorService.getActiveReplicator()
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

    private async runFiniteActivity(
        run: () => Promise<ReplicationOutcome>,
        interaction: InteractionAuthority,
        showMessage: boolean
    ): Promise<ReplicationOutcome> {
        try {
            const result = await this.dependencies.replicatorService.runFiniteReplicationActivity(run, {
                label: "replication",
            });
            // Failure recovery starts only after the finite activity boundary
            // has settled, so the host does not count a recovery dialogue as
            // remote document-delivery work.
            if (result.status === "failed") {
                await this.dependencies.handleFailure(showMessage, interaction);
            }
            return result;
        } catch (error) {
            const result = replicationFailed(error);
            await this.dependencies.handleFailure(showMessage, interaction);
            return result;
        }
    }
}
