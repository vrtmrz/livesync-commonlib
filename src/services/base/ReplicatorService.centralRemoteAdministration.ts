import type { RemoteDBSettings } from "@lib/common/types.ts";
import {
    CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS,
    centralRemoteAdministrationVerificationFailed,
    type CentralRemoteAdministrationRequest,
    type CentralRemoteAdministrationResult,
} from "@lib/replication/CentralRemoteAdministration.ts";
import { CAPABILITY_SUPPORT_KINDS } from "@lib/replication/ProviderCapability.ts";
import {
    isActiveReplicatorContextBoundToSetting,
    type ActiveReplicatorContext,
} from "@lib/replication/ReplicatorProvider.ts";

/** Stop the captured publication before an exclusive central-remote mutation. */
async function stopActiveTransfer(context: ActiveReplicatorContext): Promise<void> {
    const capability = context.provider.stopActiveTransfer;
    if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
        throw new Error("The active Replicator does not support the stop required for central remote administration.");
    }
    const outcome = await capability.run(context.replicator);
    if (outcome.status === "completed") return;
    if (outcome.status === "failed") throw outcome.error;
    throw new Error("The active Replicator transfer did not stop before central remote administration.");
}

/** Stop, then dispatch central-remote administration through the atomically captured provider. */
export async function runCentralRemoteAdministrationWithContext(
    context: ActiveReplicatorContext | undefined,
    setting: RemoteDBSettings,
    request: CentralRemoteAdministrationRequest
): Promise<CentralRemoteAdministrationResult> {
    if (!context) {
        return centralRemoteAdministrationVerificationFailed(
            CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.NO_ACTIVE_REPLICATOR
        );
    }
    if (!isActiveReplicatorContextBoundToSetting(context, setting)) {
        return centralRemoteAdministrationVerificationFailed(
            CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.ACTIVE_CONFIGURATION_MISMATCH
        );
    }

    const capability = context.provider.centralRemoteAdministration;
    if (!capability) {
        return centralRemoteAdministrationVerificationFailed(
            CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_APPLICABLE
        );
    }
    if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
        return centralRemoteAdministrationVerificationFailed(capability.reason);
    }
    // The enclosing service reservation keeps this exact publication active
    // while its transfer settles and the provider-specific mutation runs.
    await stopActiveTransfer(context);
    // The selected provider owns validation of its concrete Replicator shape.
    return await capability.run(context.replicator, setting, request);
}
