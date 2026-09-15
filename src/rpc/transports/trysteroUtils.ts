import type { BaseRoomConfig, RelayConfig } from "@trystero-p2p/nostr";
import type { P2PConnectionInfo } from "@lib/common/models/setting.type";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import {
    hasManagedP2PIceServerSource,
    hasValidP2PTurnServerUrl,
    normaliseP2PConnectionPath,
    splitP2PRelayUrls,
    splitP2PTurnServerUrls,
} from "@lib/common/models/setting.p2p";
import { IceServerSourceError } from "@lib/p2p/IceServerSource";
import { mixedHash } from "octagonal-wheels/hash/purejs";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { createDiagRTCPeerConnectionConstructor } from "./DiagRTCPeerConnections";
function containsTurnUrl(iceServers: readonly RTCIceServer[]): boolean {
    return iceServers.some((server) => {
        const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
        return urls.some((url) => /^turns?:/iu.test(url));
    });
}

function copyIceServers(iceServers: readonly RTCIceServer[]): RTCIceServer[] {
    return iceServers.map((server) => ({
        urls: typeof server.urls === "string" ? server.urls : [...server.urls],
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined ? {} : { credential: server.credential }),
    }));
}

export function generateJoinRoomOptions(
    settings: P2PConnectionInfo,
    resolvedIceServers?: readonly RTCIceServer[]
): BaseRoomConfig {
    const passphraseNumbers = mixedHash(settings.P2P_passphrase, 0);
    const passphrase = passphraseNumbers[0].toString(36) + passphraseNumbers[1].toString(36);

    const relays = splitP2PRelayUrls(settings.P2P_relays);

    const turnServers = splitP2PTurnServerUrls(settings.P2P_turnServers);
    const managedSourceSelected = hasManagedP2PIceServerSource({
        P2P_iceServerSource: settings.P2P_iceServerSource,
        encryptedP2PIceServerSource: settings.encryptedP2PIceServerSource,
    });
    if (managedSourceSelected && resolvedIceServers === undefined) {
        throw new IceServerSourceError(
            "configuration",
            "The selected ICE server source requires resolved credentials.",
            false
        );
    }
    const relayConfig: RelayConfig = {
        manualReconnection: true,
        urls: relays,
        // ...(typeof rtcPolyfill === "function" ? { rtcPolyfill } : {}),
    };
    const options: BaseRoomConfig = {
        appId: settings.P2P_AppID || "self-hosted-livesync",
        password: passphrase,
        relayConfig: relayConfig,
    };
    if (settings.P2P_useDiagRTC) {
        options.rtcPolyfill = createDiagRTCPeerConnectionConstructor();
    } else if (typeof compatGlobal.RTCPeerConnection !== "undefined") {
        options.rtcPolyfill = compatGlobal.RTCPeerConnection;
    }
    if (resolvedIceServers !== undefined) {
        options.turnConfig = copyIceServers(resolvedIceServers);
    } else if (!managedSourceSelected && turnServers.length > 0) {
        options.turnConfig = [
            {
                urls: turnServers,
                username: settings.P2P_turnUsername,
                credential: settings.P2P_turnCredential,
            },
        ];
    }
    if (
        normaliseP2PConnectionPath(settings.P2P_connectionPath) === P2PConnectionPaths.Relay &&
        (resolvedIceServers !== undefined
            ? containsTurnUrl(resolvedIceServers)
            : !managedSourceSelected && hasValidP2PTurnServerUrl(settings.P2P_turnServers))
    ) {
        options.rtcConfig = {
            iceTransportPolicy: "relay",
        };
    }
    return options;
}
