import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, type LOG_LEVEL, type ObsidianLiveSyncSettings } from "@lib/common/types";
import {
    CENTRAL_REMOTE_REPLICATION_READINESS,
    type ReplicationReadinessRequirements,
} from "@lib/replication/ReplicatorProvider.ts";
import { MARK_LOG_NETWORK_ERROR, type LogFunction } from "@lib/services/lib/logUtils";
import type { MessageTranslator } from "./MessageTranslator.ts";
import { evaluateReadiness, type ReadinessCondition, type ReadinessEvaluationResult } from "./ReadinessEvaluator.ts";

/** Collaborators required to evaluate the common replication readiness sequence. */
export interface ReplicationReadinessDependencies {
    readonly isApplicationReady: () => boolean;
    readonly runPolicyChecks: (showMessage: boolean) => Promise<boolean>;
    readonly currentSettings: () => Pick<ObsidianLiveSyncSettings, "versionUpFlash">;
    readonly isCleanupRunning: () => boolean;
    readonly commitPendingFileEvents: () => Promise<boolean>;
    readonly isOnline: () => boolean;
    readonly prepareCentralRemote: (showMessage: boolean) => Promise<boolean>;
    readonly runBeforeReplicate: (showMessage: boolean) => Promise<boolean>;
    readonly getUnresolvedMessages: () => Promise<(string | Error)[][]>;
    readonly translate: MessageTranslator;
    readonly log: LogFunction;
    readonly showError: (message: string, maxLogLevel?: LOG_LEVEL) => void;
    readonly clearErrors: () => void;
}

export interface ReplicationReadinessContext {
    readonly showMessage: boolean;
    readonly requirements: ReplicationReadinessRequirements;
}

/** Optional inputs accepted by the host-facing replication readiness evaluator. */
export interface ReplicationReadinessRequest {
    readonly showMessage?: boolean;
    readonly requirements?: ReplicationReadinessRequirements;
}

export type ReplicationReadinessEvaluator = (
    context?: ReplicationReadinessRequest
) => Promise<ReadinessEvaluationResult>;

/**
 * Compose the ordered readiness conditions shared by replication entry points.
 *
 * The returned evaluator owns readiness decisions and their diagnostics only.
 * It does not acquire a Replicator, run provider capabilities, or account for
 * remote activity. Provider-specific preparation is selected by the supplied
 * requirements while the common conditions retain their declaration order.
 */
export function createReplicationReadinessEvaluator(
    dependencies: ReplicationReadinessDependencies
): ReplicationReadinessEvaluator {
    const reportPreparationFailure = async (): Promise<void> => {
        // A tagged network error already carries its specific diagnostic. Keep
        // the generic module-failure message informational in that case.
        const hasNetworkError = (await dependencies.getUnresolvedMessages())
            .flat()
            .some((entry) => typeof entry == "string" && entry.includes(MARK_LOG_NETWORK_ERROR));
        const message = dependencies.translate("Replicator.Message.SomeModuleFailed");
        if (hasNetworkError) {
            dependencies.log(message, LOG_LEVEL_INFO);
        } else {
            dependencies.showError(message, LOG_LEVEL_NOTICE);
        }
    };

    const conditions: readonly ReadinessCondition<ReplicationReadinessContext>[] = [
        {
            name: "application-ready",
            evaluate: () => {
                if (dependencies.isApplicationReady()) return true;
                dependencies.log("Not ready");
                return false;
            },
        },
        {
            name: "replication-policy-approved",
            evaluate: ({ showMessage }) => dependencies.runPolicyChecks(showMessage),
        },
        {
            name: "local-replication-state-ready",
            evaluate: () => {
                // Preserve the established settings-read position: after host
                // policy approval and before cleanup-state evaluation.
                const currentSettings = dependencies.currentSettings();
                if (dependencies.isCleanupRunning()) {
                    dependencies.log(dependencies.translate("Replicator.Message.Cleaned"), LOG_LEVEL_NOTICE);
                    return false;
                }
                if (currentSettings.versionUpFlash != "") {
                    dependencies.log(dependencies.translate("Replicator.Message.VersionUpFlash"), LOG_LEVEL_NOTICE);
                    return false;
                }
                return true;
            },
        },
        {
            name: "pending-file-events-committed",
            evaluate: () => dependencies.commitPendingFileEvents(),
            onRejected: () => {
                dependencies.showError(dependencies.translate("Replicator.Message.Pending"), LOG_LEVEL_NOTICE);
            },
        },
        {
            name: "network-online",
            evaluate: () => dependencies.isOnline(),
            onRejected: ({ showMessage }) => {
                dependencies.showError("Network is offline", showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
            },
        },
        {
            name: "central-remote-prepared",
            appliesTo: ({ requirements }) => requirements.centralRemotePreparation === "required",
            evaluate: ({ showMessage }) => dependencies.prepareCentralRemote(showMessage),
            onRejected: reportPreparationFailure,
        },
        {
            name: "general-replication-prepared",
            evaluate: ({ showMessage }) => dependencies.runBeforeReplicate(showMessage),
            onRejected: reportPreparationFailure,
        },
    ];

    return async (context = {}) => {
        const result = await evaluateReadiness({
            purpose: "replication",
            context: {
                showMessage: context.showMessage ?? false,
                requirements: context.requirements ?? CENTRAL_REMOTE_REPLICATION_READINESS,
            },
            conditions,
        });
        if (result.ready) dependencies.clearErrors();
        return result;
    };
}
