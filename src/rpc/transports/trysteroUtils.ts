import type { BaseRoomConfig, RelayConfig } from "@trystero-p2p/nostr";
import type { P2PConnectionInfo } from "@lib/common/models/setting.type";
import { mixedHash } from "octagonal-wheels/hash/purejs";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
export function generateJoinRoomOptions(settings: P2PConnectionInfo): BaseRoomConfig {
    const passphraseNumbers = mixedHash(settings.P2P_passphrase, 0);
    const passphrase = passphraseNumbers[0].toString(36) + passphraseNumbers[1].toString(36);

    const relays = settings.P2P_relays.split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);

    const turnServers = settings.P2P_turnServers.split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
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
    if (typeof compatGlobal.RTCPeerConnection !== "undefined") {
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
    return options;
}
