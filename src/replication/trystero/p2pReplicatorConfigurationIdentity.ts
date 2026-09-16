import { P2PConnectionPaths } from "@lib/common/models/setting.const.ts";
import {
    hasValidP2PTurnServerUrl,
    hasManagedP2PTurnConfiguration,
    normaliseP2PConnectionPath,
    normaliseP2PMaxWirePayloadBytes,
    splitP2PRelayUrls,
    splitP2PTurnServerUrls,
} from "@lib/common/models/setting.p2p.ts";
import type { RemoteDBSettings } from "@lib/common/types.ts";

/**
 * Project only values which fix the effective P2P transport generation.
 *
 * Persisted profile identifiers, enablement, and room automation or admission
 * policy are deliberately excluded. The returned value can contain
 * credentials and must not be logged, persisted, or displayed.
 */
export function getP2PReplicatorConfigurationIdentity(settings: RemoteDBSettings): string {
    const managedTurnSelected = hasManagedP2PTurnConfiguration(settings);
    const turnServerValue = settings.P2P_turnServers ?? "";
    const turnServers = splitP2PTurnServerUrls(turnServerValue);
    const configuredPath = normaliseP2PConnectionPath(settings.P2P_connectionPath);
    const effectivePath =
        configuredPath === P2PConnectionPaths.Relay &&
        (managedTurnSelected || hasValidP2PTurnServerUrl(turnServerValue))
            ? P2PConnectionPaths.Relay
            : P2PConnectionPaths.Automatic;
    const turnAuthentication =
        !managedTurnSelected && turnServers.length > 0
            ? [settings.P2P_turnUsername, settings.P2P_turnCredential]
            : undefined;

    return JSON.stringify([
        "p2p",
        settings.P2P_AppID || "self-hosted-livesync",
        settings.P2P_roomID,
        settings.P2P_passphrase,
        splitP2PRelayUrls(settings.P2P_relays),
        managedTurnSelected ? undefined : turnServers,
        turnAuthentication,
        managedTurnSelected
            ? [settings.P2P_managedType, settings.P2P_managedId, settings.P2P_managedToken]
            : undefined,
        normaliseP2PMaxWirePayloadBytes(settings.P2P_maxWirePayloadBytes),
        effectivePath,
        settings.P2P_useDiagRTC ?? false,
    ]);
}
