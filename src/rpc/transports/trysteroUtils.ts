import type { BaseRoomConfig, RelayConfig } from "@trystero-p2p/nostr";
import type { P2PConnectionInfo, P2PSyncSetting } from "@lib/common/models/setting.type";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import {
    hasManagedP2PTurnConfiguration,
    hasValidP2PTurnServerUrl,
    normaliseP2PConnectionPath,
    splitP2PRelayUrls,
    splitP2PTurnServerUrls,
} from "@lib/common/models/setting.p2p";
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
    settings: P2PConnectionInfo &
        Partial<Pick<P2PSyncSetting, "P2P_iceServers" | "P2P_iceServersExpiresAt">>
): BaseRoomConfig {
    const passphraseNumbers = mixedHash(settings.P2P_passphrase, 0);
    const passphrase = passphraseNumbers[0].toString(36) + passphraseNumbers[1].toString(36);

    const relays = splitP2PRelayUrls(settings.P2P_relays);

    const turnServers = splitP2PTurnServerUrls(settings.P2P_turnServers);
    const managedTurnSelected = hasManagedP2PTurnConfiguration(settings);
    const preparedIceServers = settings.P2P_iceServers;
    if (preparedIceServers !== undefined && preparedIceServers.length === 0) {
        throw new Error("Prepared ICE servers must not be empty.");
    }
    if (managedTurnSelected && preparedIceServers === undefined) {
        throw new Error("The selected managed TURN configuration requires prepared ICE servers.");
    }
    if (managedTurnSelected && preparedIceServers && !containsTurnUrl(preparedIceServers)) {
        throw new Error("The prepared ICE servers do not contain a TURN route.");
    }
    if (
        preparedIceServers !== undefined &&
        normaliseP2PConnectionPath(settings.P2P_connectionPath) === P2PConnectionPaths.Relay &&
        !containsTurnUrl(preparedIceServers)
    ) {
        throw new Error("Relay-only P2P requires a prepared TURN route.");
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
    if (preparedIceServers !== undefined) {
        options.turnConfig = copyIceServers(preparedIceServers);
    } else if (!managedTurnSelected && turnServers.length > 0) {
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
        (preparedIceServers !== undefined
            ? containsTurnUrl(preparedIceServers)
            : !managedTurnSelected && hasValidP2PTurnServerUrl(settings.P2P_turnServers))
    ) {
        options.rtcConfig = {
            iceTransportPolicy: "relay",
        };
    }
    return options;
}
