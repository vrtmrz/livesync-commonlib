import { describe, expect, it } from "vitest";
import { pickP2PSyncSettings } from "./utils";

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
