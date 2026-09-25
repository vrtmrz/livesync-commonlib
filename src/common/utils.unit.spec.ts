import { describe, expect, it } from "vitest";
import { isRemediationModeActive, pickP2PSyncSettings } from "./utils";

describe("pickP2PSyncSettings managed TURN state", () => {
    it("preserves the managed provider scalars", () => {
        const picked = pickP2PSyncSettings({
            P2P_Enabled: true,
            P2P_AppID: "app",
            P2P_roomID: "room",
            P2P_passphrase: "passphrase",
            P2P_relays: "",
            P2P_AutoStart: false,
            P2P_AutoBroadcast: false,
            P2P_turnServers: "",
            P2P_turnUsername: "",
            P2P_turnCredential: "",
            P2P_managedType: "CF",
            P2P_managedId: "key-id",
            P2P_managedToken: "secret-token",
        });

        expect(picked).toMatchObject({
            P2P_managedType: "CF",
            P2P_managedId: "key-id",
            P2P_managedToken: "secret-token",
        });
    });
});

describe("isRemediationModeActive", () => {
    it.each([
        ["a configured limit", { maxMTimeForReflectEvents: Date.parse("2026-09-01T00:00:00Z") }, true],
        ["no limit", { maxMTimeForReflectEvents: 0 }, false],
        ["a missing limit", {} as { maxMTimeForReflectEvents: number }, false],
        ["a negative limit", { maxMTimeForReflectEvents: -1 }, false],
    ])("reports %s", (_label, settings, expected) => {
        expect(isRemediationModeActive(settings)).toBe(expected);
    });
});
