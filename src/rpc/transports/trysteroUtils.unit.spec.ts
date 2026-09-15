import { describe, expect, it } from "vitest";
import type { P2PConnectionInfo } from "@lib/common/types";
import { generateJoinRoomOptions } from "./trysteroUtils";

const MANUAL_SETTINGS: P2PConnectionInfo = {
    P2P_Enabled: true,
    P2P_relays: "wss://relay.example.com",
    P2P_roomID: "room-a",
    P2P_passphrase: "pass-a",
    P2P_AppID: "app-a",
    P2P_AutoStart: false,
    P2P_AutoBroadcast: false,
    P2P_turnServers: "turn:manual.example.com",
    P2P_turnUsername: "manual-user",
    P2P_turnCredential: "manual-secret",
    P2P_connectionPath: "relay",
};

describe("generateJoinRoomOptions ICE configuration", () => {
    it("preserves the existing manual TURN behaviour when no source result is supplied", () => {
        const options = generateJoinRoomOptions(MANUAL_SETTINGS);

        expect(options.turnConfig).toEqual([
            {
                urls: ["turn:manual.example.com"],
                username: "manual-user",
                credential: "manual-secret",
            },
        ]);
        expect(options.rtcConfig).toEqual({ iceTransportPolicy: "relay" });
    });

    it("uses ephemeral ICE servers without mutating persisted manual fields and keeps relay-only policy", () => {
        const settings: P2PConnectionInfo = {
            ...MANUAL_SETTINGS,
            P2P_iceServerSource: {
                version: 1,
                id: "managed",
                configuration: { apiToken: "persisted-token" },
            },
        };
        const issuedServers = [
            {
                urls: ["stun:stun.example.com", "turns:managed.example.com"],
                username: "issued-user",
                credential: "issued-secret",
            },
        ];

        const options = generateJoinRoomOptions(settings, issuedServers);

        expect(options.turnConfig).toEqual(issuedServers);
        expect(options.turnConfig).not.toBe(issuedServers);
        expect(options.rtcConfig).toEqual({ iceTransportPolicy: "relay" });
        expect(settings).toMatchObject({
            P2P_turnServers: "turn:manual.example.com",
            P2P_turnUsername: "manual-user",
            P2P_turnCredential: "manual-secret",
        });
    });

    it("does not fall back to manual credentials for an unresolved managed source", () => {
        expect(() =>
            generateJoinRoomOptions({
                ...MANUAL_SETTINGS,
                P2P_iceServerSource: {
                    version: 1,
                    id: "managed",
                    configuration: { apiToken: "persisted-token" },
                },
            })
        ).toThrow("requires resolved credentials");
    });
});
