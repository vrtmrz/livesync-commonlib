import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type P2PSyncSetting } from "@lib/common/types";
import { createPeerAgreement, type PeerAgreementHost, type PeerTweakSettings } from "./peerAgreement";

function createHarness() {
    const snapshot: P2PSyncSetting = { ...DEFAULT_SETTINGS, passphrase: "room-pass", encrypt: true };
    const current: P2PSyncSetting = { ...snapshot };
    const local: PeerTweakSettings = {
        pathNormalizationVersion: 0,
        idDerivationVersion: 0,
        idDerivationProof: "",
        passphrase: "digest",
        encrypt: true,
        usePathObfuscation: false,
    };
    const requestAuthentication = vi.fn(
        async (_timeoutMs: number, _signal?: AbortSignal) => true as boolean | undefined
    );
    const requestTweakSettings = vi.fn(async (_challenge: string, _timeoutMs: number, _signal?: AbortSignal) => local);
    const connection = vi.fn(() => ({ requestAuthentication, requestTweakSettings }));
    const peerPlatform = vi.fn(() => "test" as string | undefined);
    let host: PeerAgreementHost | undefined = { connection, peerPlatform };
    const hostPort = vi.fn(() => host);
    const settings = vi.fn(() => snapshot);
    const currentSettings = vi.fn(() => current);
    const assertPathIdentity = vi.fn(async (_settings: P2PSyncSetting) => {});
    const localTweakSettings = vi.fn(async (_challenge: string) => local);
    const reportDiagnostic = vi.fn();
    const agreement = createPeerAgreement({
        host: hostPort,
        settings,
        currentSettings,
        platform: () => "test",
        assertPathIdentity,
        localTweakSettings,
        reportDiagnostic,
    });
    return {
        agreement,
        snapshot,
        current,
        local,
        requestAuthentication,
        requestTweakSettings,
        connection,
        peerPlatform,
        hostPort,
        settings,
        currentSettings,
        assertPathIdentity,
        localTweakSettings,
        reportDiagnostic,
        removeHost: () => {
            host = undefined;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("peer agreement", () => {
    it("does not read host capabilities or settings during construction", () => {
        const h = createHarness();
        expect(h.hostPort).not.toHaveBeenCalled();
        expect(h.settings).not.toHaveBeenCalled();
        expect(h.currentSettings).not.toHaveBeenCalled();
        expect(h.connection).not.toHaveBeenCalled();
    });

    it("forwards the authentication deadline and signal while retaining the remote result", async () => {
        const h = createHarness();
        const controller = new AbortController();
        h.requestAuthentication.mockResolvedValue(undefined);
        expect(await h.agreement.requestAuthenticate("peer", controller.signal)).toBeUndefined();
        expect(h.connection).toHaveBeenCalledExactlyOnceWith("peer");
        expect(h.requestAuthentication).toHaveBeenCalledExactlyOnceWith(20000, controller.signal);
        expect(h.reportDiagnostic).toHaveBeenLastCalledWith(
            expect.objectContaining({ code: "auth-error", peerId: "peer" })
        );
    });

    it("does not open a connection for authentication without a host", async () => {
        const h = createHarness();
        h.removeHost();
        expect(await h.agreement.requestAuthenticate("peer")).toBe(false);
        expect(h.connection).not.toHaveBeenCalled();
        expect(h.reportDiagnostic).not.toHaveBeenCalled();
    });

    it("contains authentication errors and reports the existing failure category", async () => {
        const h = createHarness();
        h.requestAuthentication.mockRejectedValue(Object.assign(new Error("private detail"), { code: "TIMEOUT" }));
        expect(await h.agreement.requestAuthenticate("peer")).toBe(false);
        expect(h.reportDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ code: "auth-timeout" }));
        expect(JSON.stringify(h.reportDiagnostic.mock.calls)).not.toContain("private detail");
    });

    it("projects snapshot tweaks and hashes its passphrase while using current path policy", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const h = createHarness();
        h.current.passphrase = "changed-policy-pass";
        h.current.encrypt = false;
        h.current.pathNormalizationVersion = 1;
        const result = await h.agreement.getTweakSettings("challenge");
        const sha1 = (value: string) => createHash("sha1").update(value).digest("base64");
        expect(result.passphrase).toBe(sha1(sha1("0") + "room-pass"));
        expect(result.encrypt).toBe(true);
        expect(result.pathNormalizationVersion).toBe(1);
        expect(result.idDerivationProof).toBe("");
        expect(result).not.toHaveProperty("P2P_passphrase");
        expect(result).not.toHaveProperty("idDerivationKey");
        expect(h.snapshot.passphrase).toBe("room-pass");
        expect(h.assertPathIdentity).toHaveBeenCalledExactlyOnceWith(h.current);
        expect(h.currentSettings).toHaveBeenCalledTimes(2);
    });

    it("waits for database path validation before reading the room snapshot", async () => {
        const h = createHarness();
        h.current.pathNormalizationVersion = 1;
        let release!: () => void;
        h.assertPathIdentity.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );
        const request = h.agreement.getTweakSettings("challenge");
        expect(h.settings).not.toHaveBeenCalled();
        release();
        await request;
        expect(h.settings).toHaveBeenCalledOnce();
    });

    it("does not create a tweak connection for a peer without advertisement metadata", async () => {
        const h = createHarness();
        h.peerPlatform.mockReturnValue(undefined);
        expect(await h.agreement.checkTweakValues("peer")).toBe(false);
        expect(h.connection).not.toHaveBeenCalled();
    });

    it("uses the captured connection and forwards one random challenge to both peers", async () => {
        const h = createHarness();
        const controller = new AbortController();
        h.requestTweakSettings.mockImplementation(async () => {
            h.removeHost();
            return h.local;
        });
        expect(await h.agreement.checkTweakValues("peer", controller.signal)).toBe(true);
        const challenge = h.requestTweakSettings.mock.calls[0][0];
        expect(challenge).toMatch(/^[a-f0-9]{32}$/);
        expect(h.requestTweakSettings).toHaveBeenCalledExactlyOnceWith(challenge, 5000, controller.signal);
        expect(h.localTweakSettings).toHaveBeenCalledExactlyOnceWith(challenge);
        expect(h.hostPort).toHaveBeenCalledOnce();
        expect(h.connection).toHaveBeenCalledExactlyOnceWith("peer");
    });

    it("does not start local validation if cancellation is observed after the remote response", async () => {
        const h = createHarness();
        const controller = new AbortController();
        h.requestTweakSettings.mockImplementation(async () => {
            controller.abort();
            return h.local;
        });
        expect(await h.agreement.checkTweakValues("peer", controller.signal)).toBe(false);
        expect(h.localTweakSettings).not.toHaveBeenCalled();
    });

    it("checks path identity before allowing the pseudo-replicator exception", async () => {
        const h = createHarness();
        h.peerPlatform.mockReturnValue("pseudo-replicator");
        h.requestTweakSettings.mockResolvedValue({ ...h.local, pathNormalizationVersion: 1 });
        expect(await h.agreement.checkTweakValues("peer")).toBe(false);
        h.requestTweakSettings.mockResolvedValue({ ...h.local, passphrase: "different" });
        expect(await h.agreement.checkTweakValues("peer")).toBe(true);
    });

    it("propagates tweak RPC failures rather than translating them into authentication refusal", async () => {
        const h = createHarness();
        const error = new Error("tweak RPC failed");
        h.requestTweakSettings.mockRejectedValue(error);
        await expect(h.agreement.checkTweakValues("peer")).rejects.toBe(error);
        expect(h.localTweakSettings).not.toHaveBeenCalled();
    });
});
