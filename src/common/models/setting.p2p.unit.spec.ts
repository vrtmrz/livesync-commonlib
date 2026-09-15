import { describe, expect, it } from "vitest";
import {
    hasManagedP2PIceServerSource,
    hasP2PTurnConfiguration,
    isManualIceServerSourceConfiguration,
} from "./setting.p2p";

describe("P2P ICE source settings", () => {
    it("recognises a managed descriptor in the selected profile", () => {
        expect(
            hasManagedP2PIceServerSource({
                P2P_iceServerSource: {
                    version: 1,
                    id: "cloudflare",
                    configuration: { turnKeyId: "key", apiToken: "token" },
                },
            })
        ).toBe(true);
    });

    it("finds managed sources in inactive profiles for sharing decisions", () => {
        expect(
            hasManagedP2PIceServerSource({
                P2P_iceServerSource: undefined,
                remoteConfigurations: {
                    inactive: {
                        uri: "sls+p2p://room?source=%7B%7D",
                    },
                },
            })
        ).toBe(true);
    });

    it("does not let inactive profiles provide selected TURN configuration", () => {
        expect(
            hasP2PTurnConfiguration({
                P2P_turnServers: "",
                P2P_iceServerSource: undefined,
                encryptedP2PIceServerSource: undefined,
                remoteConfigurations: {
                    inactive: {
                        uri: "sls+p2p://room?source=%7B%7D",
                    },
                },
            } as any)
        ).toBe(false);
    });

    it("recognises manual mode only for its reserved descriptor version", () => {
        expect(isManualIceServerSourceConfiguration({ version: 1, id: "manual", configuration: {} })).toBe(true);
        expect(isManualIceServerSourceConfiguration({ version: 99, id: "manual", configuration: {} })).toBe(false);
        expect(
            hasManagedP2PIceServerSource({
                P2P_iceServerSource: { version: 99, id: "manual", configuration: {} },
            })
        ).toBe(true);
    });
});
