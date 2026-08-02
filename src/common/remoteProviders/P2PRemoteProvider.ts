import { REMOTE_P2P } from "@lib/common/models/setting.const.ts";
import type { P2PConnectionInfo, RemoteDBSettings } from "@lib/common/models/setting.type.ts";
import type { RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";

function pickP2PSettings(settings: RemoteDBSettings): P2PConnectionInfo {
    return {
        P2P_AppID: settings.P2P_AppID,
        P2P_AutoBroadcast: settings.P2P_AutoBroadcast,
        P2P_AutoStart: settings.P2P_AutoStart,
        P2P_DevicePeerName: settings.P2P_DevicePeerName || "",
        P2P_Enabled: settings.P2P_Enabled,
        P2P_passphrase: settings.P2P_passphrase,
        P2P_relays: settings.P2P_relays,
        P2P_roomID: settings.P2P_roomID,
        P2P_turnCredential: settings.P2P_turnCredential,
        P2P_turnServers: settings.P2P_turnServers,
        P2P_turnUsername: settings.P2P_turnUsername,
    };
}

export const p2pRemoteProvider: RemoteProviderDescriptor<"p2p", P2PConnectionInfo> = {
    activationRoles: ["main", "p2p"],
    family: "p2p",
    legacyProfileId: "legacy-p2p",
    legacyProfileName: "P2P Remote",
    remoteType: REMOTE_P2P,
    schemes: ["p2p"],
    type: "p2p",
    hasConfiguration: (settings) => typeof settings.P2P_roomID === "string" && settings.P2P_roomID.trim() !== "",
    parse(uri) {
        const match = /^sls\+p2p:\/\/([^?#]+)(?:\?([^#]*))?(?:#(.*))?$/u.exec(uri);
        if (!match) throw new Error(`Invalid P2P URI: ${uri}`);
        const authority = match[1];
        const queryString = match[2] || "";
        let userinfo = "";
        let host = authority;
        const lastAtIndex = authority.lastIndexOf("@");
        if (lastAtIndex !== -1) {
            userinfo = authority.slice(0, lastAtIndex);
            host = authority.slice(lastAtIndex + 1);
        }
        let password = "";
        if (userinfo) {
            const colonIndex = userinfo.indexOf(":");
            if (colonIndex !== -1) password = userinfo.slice(colonIndex + 1);
        }
        const searchParams = new URLSearchParams(queryString);
        return {
            P2P_Enabled: searchParams.get("enabled") !== "false",
            P2P_roomID: decodeURIComponent(host),
            P2P_passphrase: decodeURIComponent(password),
            P2P_relays: searchParams.get("relays") || "",
            P2P_AppID: searchParams.get("appId") || "self-hosted-livesync",
            P2P_AutoStart: searchParams.get("autoStart") === "true",
            P2P_AutoBroadcast: searchParams.get("autoBroadcast") === "true",
            P2P_turnServers: searchParams.get("turnServers") || "",
            P2P_turnUsername: searchParams.get("turnUser") || "",
            P2P_turnCredential: searchParams.get("turnPass") || "",
        };
    },
    pick: pickP2PSettings,
    serialise(settings) {
        const searchParams = new URLSearchParams();
        if (!settings.P2P_Enabled) searchParams.set("enabled", "false");
        searchParams.set("relays", settings.P2P_relays);
        searchParams.set("appId", settings.P2P_AppID);
        if (settings.P2P_AutoStart) searchParams.set("autoStart", "true");
        if (settings.P2P_AutoBroadcast) searchParams.set("autoBroadcast", "true");
        if (settings.P2P_turnServers) searchParams.set("turnServers", settings.P2P_turnServers);
        if (settings.P2P_turnUsername) searchParams.set("turnUser", settings.P2P_turnUsername);
        if (settings.P2P_turnCredential) searchParams.set("turnPass", settings.P2P_turnCredential);
        const credentials = settings.P2P_passphrase ? `:${encodeURIComponent(settings.P2P_passphrase)}@` : "";
        const host = encodeURIComponent(settings.P2P_roomID);
        const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
        return `sls+p2p://${credentials}${host}${query}`;
    },
    suggestName(settings) {
        const room = settings.P2P_roomID.trim();
        return room ? `P2P ${room}` : "P2P remote";
    },
};
