import { describe, expect, it } from "vitest";
import { P2P_DEFAULT_SETTINGS } from "./models/setting.const.defaults";
import { pickP2PSyncSettings } from "./utils";

describe("pickP2PSyncSettings managed ICE source state", () => {
    const managedSource = {
        version: 1,
        id: "cloudflare",
        configuration: { turnKeyId: "key-id", apiToken: "api-token" },
    };

    it("copies the source configuration without sharing ownership", () => {
        const picked = pickP2PSyncSettings({
            ...P2P_DEFAULT_SETTINGS,
            P2P_iceServerSource: managedSource,
        });

        expect(picked.P2P_iceServerSource).toEqual(managedSource);
        expect(picked.P2P_iceServerSource).not.toBe(managedSource);
    });

});
