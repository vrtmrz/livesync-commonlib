import type { RemoteDBSettings } from "@lib/common/types.ts";
import {
    REMOTE_ADMINISTRATION_FAILURE_REASONS,
    remoteAdministrationVerificationFailed,
    type RemoteAdministrationRequest,
    type RemoteAdministrationResult,
} from "@lib/replication/RemoteAdministration.ts";
import { CAPABILITY_SUPPORT_KINDS } from "@lib/replication/ProviderCapability.ts";
import type { ActiveReplicatorContext } from "@lib/replication/ReplicatorProvider.ts";

/** Dispatch remote administration through the atomically captured provider. */
export async function runRemoteAdministrationWithContext(
    context: ActiveReplicatorContext | undefined,
    setting: RemoteDBSettings,
    request: RemoteAdministrationRequest
): Promise<RemoteAdministrationResult> {
    if (!context) {
        return remoteAdministrationVerificationFailed(REMOTE_ADMINISTRATION_FAILURE_REASONS.NO_ACTIVE_REPLICATOR);
    }

    const capability = context.provider.remoteAdministration;
    if (capability.kind === CAPABILITY_SUPPORT_KINDS.NOT_IMPLEMENTED) {
        return remoteAdministrationVerificationFailed(REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_IMPLEMENTED);
    }
    if (capability.kind === CAPABILITY_SUPPORT_KINDS.NOT_APPLICABLE) {
        return remoteAdministrationVerificationFailed(REMOTE_ADMINISTRATION_FAILURE_REASONS.CAPABILITY_NOT_APPLICABLE);
    }
    return await capability.run(context.replicator, setting, request);
}
