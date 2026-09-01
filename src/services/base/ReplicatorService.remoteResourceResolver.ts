import type { RemoteDBSettings } from "@lib/common/types.ts";
import { CAPABILITY_SUPPORT_KINDS } from "@lib/replication/ProviderCapability.ts";
import type {
    RemoteResourceCapabilities,
    RemoteResourceKind,
    RemoteResourceMap,
} from "@lib/replication/RemoteResource.ts";

/** Resolve one ReplicatorService-owned finite resource without adding a method per role. */
export async function resolveRemoteResource<TKind extends RemoteResourceKind>(
    capabilities: RemoteResourceCapabilities,
    kind: TKind,
    setting: RemoteDBSettings
): Promise<RemoteResourceMap[TKind] | undefined> {
    const capability = capabilities[kind];
    if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
        return undefined;
    }
    return await capability.run(setting);
}
