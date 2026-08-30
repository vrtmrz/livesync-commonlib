import type { BaseRoomConfig, RelayConfig } from "@trystero-p2p/nostr";
import type { P2PConnectionInfo } from "@lib/common/models/setting.type";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import {
    hasValidP2PTurnServerUrl,
    normaliseP2PConnectionPath,
    splitP2PRelayUrls,
    splitP2PTurnServerUrls,
} from "@lib/common/models/setting.p2p";
import { mixedHash } from "octagonal-wheels/hash/purejs";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { createDiagRTCPeerConnectionConstructor } from "./DiagRTCPeerConnections";
export function generateJoinRoomOptions(settings: P2PConnectionInfo): BaseRoomConfig {
    const passphraseNumbers = mixedHash(settings.P2P_passphrase, 0);
    const passphrase = passphraseNumbers[0].toString(36) + passphraseNumbers[1].toString(36);

    const relays = splitP2PRelayUrls(settings.P2P_relays);

    const turnServers = splitP2PTurnServerUrls(settings.P2P_turnServers);
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
    if (turnServers.length > 0) {
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
        hasValidP2PTurnServerUrl(settings.P2P_turnServers)
    ) {
        options.rtcConfig = {
            iceTransportPolicy: "relay",
        };
    }
    return options;
}
