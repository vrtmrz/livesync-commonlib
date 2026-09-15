import { P2PConnectionPaths } from "@lib/common/models/setting.const.ts";
import {
    hasValidP2PTurnServerUrl,
    hasManagedP2PIceServerSource,
    normaliseP2PConnectionPath,
    normaliseP2PMaxWirePayloadBytes,
    splitP2PRelayUrls,
    splitP2PTurnServerUrls,
} from "@lib/common/models/setting.p2p.ts";
import type { RemoteDBSettings } from "@lib/common/types.ts";
import { getIceServerSourceIdentity } from "@lib/p2p/IceServerSource.ts";

/**
 * Project only values which fix the effective P2P transport generation.
 *
 * Persisted profile identifiers, enablement, and room automation or admission
 * policy are deliberately excluded. The returned value can contain
 * credentials and must not be logged, persisted, or displayed.
 */
export function getP2PReplicatorConfigurationIdentity(settings: RemoteDBSettings): string {
    const source = settings.P2P_iceServerSource;
    const managedSourceSelected = hasManagedP2PIceServerSource({ P2P_iceServerSource: source });
    const turnServerValue = settings.P2P_turnServers ?? "";
    const turnServers = splitP2PTurnServerUrls(turnServerValue);
    const configuredPath = normaliseP2PConnectionPath(settings.P2P_connectionPath);
    const effectivePath =
        configuredPath === P2PConnectionPaths.Relay &&
        (managedSourceSelected || hasValidP2PTurnServerUrl(turnServerValue))
            ? P2PConnectionPaths.Relay
            : P2PConnectionPaths.Automatic;
    const turnAuthentication =
        !managedSourceSelected && turnServers.length > 0
            ? [settings.P2P_turnUsername, settings.P2P_turnCredential]
            : undefined;

    return JSON.stringify([
        "p2p",
        settings.P2P_AppID || "self-hosted-livesync",
        settings.P2P_roomID,
        settings.P2P_passphrase,
        splitP2PRelayUrls(settings.P2P_relays),
        managedSourceSelected ? undefined : turnServers,
        turnAuthentication,
        getIceServerSourceIdentity(source),
        normaliseP2PMaxWirePayloadBytes(settings.P2P_maxWirePayloadBytes),
        effectivePath,
        settings.P2P_useDiagRTC ?? false,
    ]);
}
