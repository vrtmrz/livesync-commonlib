import { describe, expect, it } from "vitest";
import { P2P_DEFAULT_SETTINGS } from "./models/setting.const.defaults";
import { pickP2PSyncSettings } from "./utils";

describe("pickP2PSyncSettings managed ICE source state", () => {
    const managedSource = {
        version: 1,
        id: "cloudflare",
        configuration: { turnKeyId: "key-id", apiToken: "api-token" },
    };

    it("declares both source persistence fields in the P2P defaults", () => {
        expect(Object.prototype.hasOwnProperty.call(P2P_DEFAULT_SETTINGS, "P2P_iceServerSource")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(P2P_DEFAULT_SETTINGS, "encryptedP2PIceServerSource")).toBe(true);
        expect(P2P_DEFAULT_SETTINGS.P2P_iceServerSource).toBeUndefined();
        expect(P2P_DEFAULT_SETTINGS.encryptedP2PIceServerSource).toBe("");
    });

    it("preserves plaintext and encrypted source projections when copying P2P settings", () => {
        const picked = pickP2PSyncSettings({
            ...P2P_DEFAULT_SETTINGS,
            P2P_iceServerSource: managedSource,
            encryptedP2PIceServerSource: "encrypted-source",
        });

        expect(picked.P2P_iceServerSource).toEqual(managedSource);
        expect(picked.P2P_iceServerSource).not.toBe(managedSource);
        expect(picked.encryptedP2PIceServerSource).toBe("encrypted-source");
    });

    it("does not turn an encrypted-only source into an implicit manual profile", () => {
        const picked = pickP2PSyncSettings({
            ...P2P_DEFAULT_SETTINGS,
            encryptedP2PIceServerSource: "opaque-encrypted-source",
        });

        expect(picked.P2P_iceServerSource).toBeUndefined();
        expect(picked.encryptedP2PIceServerSource).toBe("opaque-encrypted-source");
    });
});
