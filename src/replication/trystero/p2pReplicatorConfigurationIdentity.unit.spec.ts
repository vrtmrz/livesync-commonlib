import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ObsidianLiveSyncSettings } from "@lib/common/types.ts";
import { P2PConnectionPaths, P2PMessageSizePresets } from "@lib/common/models/setting.const.ts";
import { getP2PReplicatorConfigurationIdentity } from "./p2pReplicatorConfigurationIdentity.ts";

function configuredSettings(overrides: Partial<ObsidianLiveSyncSettings> = {}): ObsidianLiveSyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        activeConfigurationId: "central-profile-a",
        P2P_ActiveRemoteConfigurationId: "p2p-profile-a",
        P2P_Enabled: true,
        P2P_AppID: "self-hosted-livesync",
        P2P_roomID: "room-a",
        P2P_passphrase: "passphrase-a",
        P2P_relays: "wss://relay-a.example.test,wss://relay-b.example.test",
        P2P_turnServers: "turn:turn-a.example.test,turns:turn-b.example.test",
        P2P_turnUsername: "alice",
        P2P_turnCredential: "secret-a",
        P2P_maxWirePayloadBytes: P2PMessageSizePresets.MaximumCompatibility,
        P2P_connectionPath: P2PConnectionPaths.Relay,
        P2P_useDiagRTC: false,
        ...overrides,
    };
}

describe("P2P Replicator configuration identity", () => {
    it.each([
        ["P2P_AppID", "other-app"],
        ["P2P_roomID", "room-b"],
        ["P2P_passphrase", "passphrase-b"],
        ["P2P_relays", "wss://relay-c.example.test"],
        ["P2P_turnServers", "turn:turn-c.example.test"],
        ["P2P_turnUsername", "bob"],
        ["P2P_turnCredential", "secret-b"],
        ["P2P_maxWirePayloadBytes", P2PMessageSizePresets.Standard],
        ["P2P_connectionPath", P2PConnectionPaths.Automatic],
        ["P2P_useDiagRTC", true],
    ] satisfies Array<[keyof ObsidianLiveSyncSettings, ObsidianLiveSyncSettings[keyof ObsidianLiveSyncSettings]]>)(
        "detects a %s transport change",
        (key, value) => {
            const settings = configuredSettings();
            expect(getP2PReplicatorConfigurationIdentity({ ...settings, [key]: value })).not.toBe(
                getP2PReplicatorConfigurationIdentity(settings)
            );
        }
    );

    it("normalises effective relay lists, the default App ID, and the wire-payload bound", () => {
        const settings = configuredSettings({
            P2P_AppID: "",
            P2P_relays: " wss://relay-a.example.test,  wss://relay-b.example.test, ",
            P2P_turnServers: " turn:turn-a.example.test, turns:turn-b.example.test, ",
            P2P_maxWirePayloadBytes: undefined,
        });

        expect(
            getP2PReplicatorConfigurationIdentity({
                ...settings,
                P2P_AppID: "self-hosted-livesync",
                P2P_relays: "wss://relay-a.example.test,wss://relay-b.example.test",
                P2P_turnServers: "turn:turn-a.example.test,turns:turn-b.example.test",
                P2P_maxWirePayloadBytes: P2PMessageSizePresets.Standard,
            })
        ).toBe(getP2PReplicatorConfigurationIdentity(settings));
    });

    it("uses the effective connection path and ignores inactive TURN credentials", () => {
        const noTurn = configuredSettings({
            P2P_turnServers: "",
            P2P_connectionPath: P2PConnectionPaths.Relay,
            P2P_turnUsername: "inactive-a",
            P2P_turnCredential: "inactive-a",
        });

        expect(
            getP2PReplicatorConfigurationIdentity({
                ...noTurn,
                P2P_connectionPath: P2PConnectionPaths.Automatic,
                P2P_turnUsername: "inactive-b",
                P2P_turnCredential: "inactive-b",
            })
        ).toBe(getP2PReplicatorConfigurationIdentity(noTurn));
    });

    it("does not replace the active adapter for profile selection, demand, or dynamic policy changes", () => {
        const settings = configuredSettings();
        const identity = getP2PReplicatorConfigurationIdentity(settings);

        expect(
            getP2PReplicatorConfigurationIdentity({
                ...settings,
                activeConfigurationId: "central-profile-b",
                P2P_ActiveRemoteConfigurationId: "p2p-profile-b",
                P2P_Enabled: false,
                P2P_AutoStart: !settings.P2P_AutoStart,
                P2P_AutoBroadcast: !settings.P2P_AutoBroadcast,
                P2P_AutoSyncPeers: "peer-a",
                P2P_DevicePeerName: "renamed-device",
            })
        ).toBe(identity);
    });
});
