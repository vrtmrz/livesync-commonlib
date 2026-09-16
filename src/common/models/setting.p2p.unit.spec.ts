import { describe, expect, it } from "vitest";
import { hasManagedP2PTurnConfiguration, hasP2PTurnConfiguration, omitP2PRuntimeSettings } from "./setting.p2p";

describe("P2P managed TURN settings", () => {
    it("recognises a non-empty managed provider type", () => {
        expect(hasManagedP2PTurnConfiguration({ P2P_managedType: "CF" })).toBe(true);
        expect(hasManagedP2PTurnConfiguration({ P2P_managedType: "" })).toBe(false);
        expect(hasManagedP2PTurnConfiguration({})).toBe(false);
    });

    it("does not let inactive profiles provide selected TURN configuration", () => {
        expect(
            hasP2PTurnConfiguration({
                P2P_turnServers: "",
                remoteConfigurations: {
                    inactive: { uri: "sls+p2p://room?managedType=CF" },
                },
            } as any)
        ).toBe(false);
    });

    it("removes runtime ICE fields without changing provider selection", () => {
        const projected = omitP2PRuntimeSettings({
            P2P_managedType: "CF",
            P2P_managedId: "key-id",
            P2P_managedToken: "secret-token",
            P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
            P2P_iceServersExpiresAt: 123_456,
        });

        expect(projected).toEqual({
            P2P_managedType: "CF",
            P2P_managedId: "key-id",
            P2P_managedToken: "secret-token",
        });
    });
});
