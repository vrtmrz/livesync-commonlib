import type { RemoteDBSettings } from "@lib/common/types.ts";
import {
    CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS,
    centralRemoteAdministrationVerificationFailed,
    type CentralRemoteAdministrationRequest,
    type CentralRemoteAdministrationResult,
} from "@lib/replication/CentralRemoteAdministration.ts";
import { CAPABILITY_SUPPORT_KINDS } from "@lib/replication/ProviderCapability.ts";
import type { ActiveReplicatorContext } from "@lib/replication/ReplicatorProvider.ts";

/** Dispatch central-remote administration through the atomically captured provider. */
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

    const capability = context.provider.centralRemoteAdministration;
    if (!capability) {
        return centralRemoteAdministrationVerificationFailed(
            CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_APPLICABLE
        );
    }
    if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
        return centralRemoteAdministrationVerificationFailed(capability.reason);
    }
    const replicator = context.replicator as typeof context.replicator & {
        readonly nodeid?: unknown;
        markRemoteResolved?: unknown;
        markRemoteLocked?: unknown;
    };
    if (
        typeof replicator.nodeid !== "string" ||
        typeof replicator.markRemoteResolved !== "function" ||
        typeof replicator.markRemoteLocked !== "function"
    ) {
        return centralRemoteAdministrationVerificationFailed(
            CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_APPLICABLE
        );
    }
    return await capability.run(replicator as Parameters<typeof capability.run>[0], setting, request);
}
