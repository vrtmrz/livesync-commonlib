import { describe, expect, it, vi } from "vitest";
import {
    IceServerSourceError,
    resolveIceServerSelection,
    toSafeIceServerSourceError,
    validateIceServerConfiguration,
} from "./IceServerSource";

describe("ICE server source contract", () => {
    it("accepts bounded TURN credentials and copies only RTCIceServer fields", () => {
        const configuration = validateIceServerConfiguration(
            {
                iceServers: [
                    {
                        urls: ["stun:stun.example.com", "turns:turn.example.com"],
                        username: "issued-user",
                        credential: "issued-secret",
                        unknownProviderField: "discarded",
                    } as RTCIceServer,
                ],
                expiresAt: 200_000,
            },
            { managed: true, now: 100_000 }
        );

        expect(configuration).toEqual({
            iceServers: [
                {
                    urls: ["stun:stun.example.com", "turns:turn.example.com"],
                    username: "issued-user",
                    credential: "issued-secret",
                },
            ],
            expiresAt: 200_000,
        });
        expect(configuration.iceServers[0]).not.toHaveProperty("unknownProviderField");
    });

    it.each([
        {
            iceServers: [{ urls: "https://not-ice.example.com", username: "user", credential: "secret" }],
            expiresAt: 200_000,
        },
        { iceServers: [{ urls: "turn:turn.example.com" }], expiresAt: 200_000 },
        { iceServers: [{ urls: "stun:stun.example.com" }], expiresAt: 200_000 },
        {
            iceServers: [{ urls: "turn:turn.example.com", username: "user", credential: "secret" }],
            expiresAt: 120_000,
        },
    ])("rejects malformed or too-short managed results without including their values", (configuration) => {
        let error: unknown;
        try {
            validateIceServerConfiguration(configuration, { managed: true, now: 100_000 });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(IceServerSourceError);
        expect(error).toMatchObject({ code: "invalid-response", retryable: false });
        expect((error as Error).message).toBe("The ICE server source returned an invalid response.");
    });

    it("rejects unsupported identifiers and versions without invoking another source", () => {
        const factory = vi.fn();
        expect(() =>
            resolveIceServerSelection(
                { version: 1, id: "unknown", configuration: { apiToken: "do-not-report" } },
                { supported: factory }
            )
        ).toThrow("not supported by this host");
        expect(() =>
            resolveIceServerSelection(
                { version: 2, id: "supported", configuration: { apiToken: "do-not-report" } },
                { supported: factory }
            )
        ).toThrow("version is not supported");
        expect(factory).not.toHaveBeenCalled();
    });

    it("rejects a malformed source envelope as a safe configuration failure", () => {
        expect(() => resolveIceServerSelection(null, {})).toThrow(
            "The selected ICE server source configuration is invalid."
        );
        try {
            resolveIceServerSelection({ version: 1, id: "managed", configuration: [] }, {});
        } catch (error) {
            expect(error).toMatchObject({ code: "configuration", retryable: false });
        }
    });

    it("preserves absent and explicit manual selection without consulting the catalogue", () => {
        const factory = vi.fn();
        expect(resolveIceServerSelection(undefined, { managed: factory })).toEqual({
            kind: "manual",
            identity: "manual",
        });
        expect(
            resolveIceServerSelection({ version: 1, id: "manual", configuration: {} }, { managed: factory })
        ).toEqual({ kind: "manual", identity: "manual" });
        expect(factory).not.toHaveBeenCalled();
    });

    it("replaces arbitrary source failures with a credential-safe typed error", () => {
        const error = toSafeIceServerSourceError(new Error("request failed with bearer token-secret"));

        expect(error).toMatchObject({ code: "unavailable", retryable: true });
        expect(error.message).toBe("The ICE server source could not provide credentials.");
        expect(error.message).not.toContain("token-secret");
    });
});
