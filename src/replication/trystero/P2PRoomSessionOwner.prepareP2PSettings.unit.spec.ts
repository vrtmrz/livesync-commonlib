import { afterEach, describe, expect, it, vi } from "vitest";
import type { P2PSyncSetting } from "@lib/common/types";
import { P2PRoomSessionOwner, type PrepareP2PSettings } from "./P2PRoomSessionOwner";

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function createSettings() {
    return {
        P2P_Enabled: true,
        P2P_AutoBroadcast: false,
        P2P_AppID: "app-a",
        P2P_roomID: "room-a",
        P2P_passphrase: "pass-a",
        P2P_relays: "wss://relay.example.com",
        P2P_turnServers: "turn:manual.example.com",
        P2P_turnUsername: "manual-user",
        P2P_turnCredential: "manual-secret",
        P2P_connectionPath: "relay",
        P2P_managedType: "CF",
        P2P_managedId: "key-a",
        P2P_managedToken: "token-a",
    };
}

function createOwnerHarness(
    prepareP2PSettings?: PrepareP2PSettings,
    createSessionOverride?: (session: FakeSession, index: number) => void
) {
    const settings = createSettings();
    const sessions: FakeSession[] = [];
    const getValue = vi.fn(async () => "device-a");
    const env = {
        services: {
            context: { events: {}, translate: (key: string) => key },
            setting: { currentSettings: () => settings },
            keyValueDB: { openSimpleStore: () => ({}) },
            database: { localDatabase: { localDatabase: {} } },
            config: { getValue },
            vault: { getVaultName: () => "vault-a" },
            API: { getPlatform: () => "test", confirm: {} },
            replicator: { runFiniteReplicationActivity: async (task: () => unknown) => await task() },
            replication: {
                isReplicationReady: async () => true,
                parseSynchroniseResult: async () => undefined,
            },
        },
    } as any;
    const createSession = vi.fn((sessionEnv: any) => {
        const session = new FakeSession(sessionEnv);
        createSessionOverride?.(session, sessions.length);
        sessions.push(session);
        return session as any;
    });
    const diagnostic = vi.fn();
    const owner = new P2PRoomSessionOwner(env, createSession, { prepareP2PSettings, onDiagnosticEvent: diagnostic });
    return { createSession, owner, sessions, settings, getValue, diagnostic };
}

class FakeSession {
    readonly host = { isServing: false };
    readonly replicator = { reconcileAutoBroadcast: vi.fn() };
    readonly open = vi.fn(async () => {
        this.host.isServing = true;
    });
    retire = vi.fn(async () => {
        this.host.isServing = false;
    });

    constructor(readonly env: { readonly settings: P2PSyncSetting }) {}
}

function preparedSettings(settings: Readonly<P2PSyncSetting>, expiresAt: number, credential = "issued-secret") {
    return {
        ...settings,
        P2P_iceServers: [
            {
                urls: ["stun:stun.example.com", "turns:turn.example.com"],
                username: "issued-user",
                credential,
            },
        ],
        P2P_iceServersExpiresAt: expiresAt,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("P2PRoomSessionOwner prepared settings lifecycle", () => {
    it.each(["persistent", "finite"] as const)(
        "rejects an unsupported version before registering %s demand",
        async (kind) => {
            const { owner, settings, createSession, getValue } = createOwnerHarness();
            settings.P2P_managedType = "";
            Object.assign(settings, { pathNormalizationVersion: 2 });
            const task = vi.fn();

            const result = kind === "persistent" ? owner.open() : owner.runWithFiniteDemand(task);
            await expect(result).rejects.toThrow("Unsupported path normalisation version: 2");
            expect(task).not.toHaveBeenCalled();
            expect(createSession).not.toHaveBeenCalled();
            expect(getValue).not.toHaveBeenCalled();

            Object.assign(settings, { pathNormalizationVersion: 0 });
            await owner.setPersistentDemand("automatic", false);
            expect(createSession).not.toHaveBeenCalled();
            expect(getValue).not.toHaveBeenCalled();
        }
    );

    it("returns a rejected promise for an unsupported probe without starting the trial", async () => {
        const { owner, settings, createSession } = createOwnerHarness();
        Object.assign(settings, { pathNormalizationVersion: 2 });
        const trial = vi.fn(async () => "connected");
        let result: ReturnType<typeof owner.runConnectionProbe>;

        expect(() => {
            result = owner.runConnectionProbe(settings, trial);
        }).not.toThrow();
        await expect(result!).rejects.toThrow("Unsupported path normalisation version: 2");
        expect(trial).not.toHaveBeenCalled();
        expect(createSession).not.toHaveBeenCalled();

        Object.assign(settings, { pathNormalizationVersion: 0 });
        await expect(owner.runConnectionProbe(settings, trial)).resolves.toEqual({
            status: "trial",
            result: "connected",
        });
        expect(trial).toHaveBeenCalledOnce();
    });

    it("rejects a version which becomes unsupported before queued reconciliation", async () => {
        const { owner, settings, createSession, getValue } = createOwnerHarness();
        const opening = owner.open();
        Object.assign(settings, { pathNormalizationVersion: 2 });

        await expect(opening).rejects.toThrow("Unsupported path normalisation version: 2");
        expect(createSession).not.toHaveBeenCalled();
        expect(getValue).not.toHaveBeenCalled();
        await owner.close();
    });

    it("waits for the stored identity before creating a room", async () => {
        const { owner, settings, getValue, createSession } = createOwnerHarness();
        settings.P2P_managedType = "";
        const identity = createDeferred<string>();
        getValue.mockReturnValue(identity.promise);
        const opening = owner.open();
        await vi.waitFor(() => expect(getValue).toHaveBeenCalledOnce());
        expect(createSession).not.toHaveBeenCalled();
        identity.resolve("loaded-device");
        await opening;
        expect(createSession.mock.calls[0][0].deviceName).toBe("loaded-device");
        await owner.close();
    });

    it("does not publish a room if demand is withdrawn during the identity read", async () => {
        const { owner, settings, getValue, createSession } = createOwnerHarness();
        settings.P2P_managedType = "";
        const identity = createDeferred<string>();
        getValue.mockReturnValue(identity.promise);
        const opening = owner.open();
        await vi.waitFor(() => expect(getValue).toHaveBeenCalledOnce());
        const closing = owner.close();
        identity.resolve("loaded-device");
        await Promise.all([opening, closing]);
        expect(createSession).not.toHaveBeenCalled();
        expect(owner.isConnected).toBe(false);
    });

    it("releases finite demand when the identity cannot be read", async () => {
        const { owner, settings, getValue, createSession } = createOwnerHarness();
        settings.P2P_managedType = "";
        const failure = new Error("device storage unavailable");
        getValue.mockRejectedValueOnce(failure);
        const task = vi.fn();
        await expect(owner.runWithFiniteDemand(task)).rejects.toBe(failure);
        await owner.setPersistentDemand("explicit", false);
        expect(task).not.toHaveBeenCalled();
        expect(createSession).not.toHaveBeenCalled();
    });

    it("replaces an existing room and revalidates automation when path identity changes to NFC", async () => {
        const { owner, sessions, settings } = createOwnerHarness();
        settings.P2P_managedType = "";

        await owner.open();
        expect(sessions).toHaveLength(1);
        const coordinator = (sessions[0] as any).env.automationCoordinator;
        const baseline = vi.fn(async () => ({ status: "completed" as const, ok: true as const }));
        await coordinator.runBaseline("peer-a", baseline);
        expect(baseline).toHaveBeenCalledOnce();

        settings.pathNormalizationVersion = 1;
        await owner.setPersistentDemand("explicit", true);

        expect(sessions).toHaveLength(2);
        expect(sessions[0].retire).toHaveBeenCalledOnce();
        const nextBaseline = vi.fn(async () => ({ status: "completed" as const, ok: true as const }));
        await (sessions[1] as any).env.automationCoordinator.runBaseline("peer-a", nextBaseline);
        expect(nextBaseline).toHaveBeenCalledOnce();

        settings.pathNormalizationVersion = 0;
        await owner.setPersistentDemand("explicit", true);
        expect(sessions).toHaveLength(3);
        expect(sessions[1].retire).toHaveBeenCalledOnce();
        const legacyBaseline = vi.fn(async () => ({ status: "completed" as const, ok: true as const }));
        await (sessions[2] as any).env.automationCoordinator.runBaseline("peer-a", legacyBaseline);
        expect(legacyBaseline).toHaveBeenCalledOnce();

        const task = vi.fn(async () => undefined);
        await expect(owner.runWithFiniteDemand(task)).resolves.toBeUndefined();
        expect(task).toHaveBeenCalledOnce();
        await owner.close();
    });

    it("reuses an equivalent serving room while its prepared settings remain usable", async () => {
        let now = 1_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const prepare = vi.fn(async (settings: Readonly<P2PSyncSetting>) => preparedSettings(settings, now + 120_000));
        const { createSession, owner, sessions } = createOwnerHarness(prepare);

        await owner.open();
        now += 10_000;
        await owner.open();

        expect(prepare).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledOnce();
        expect(sessions[0].env.settings.P2P_iceServers?.[0].credential).toBe("issued-secret");
    });

    it("settles the expired room before preparing its replacement", async () => {
        let now = 2_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const prepare = vi.fn(async (settings: Readonly<P2PSyncSetting>) => preparedSettings(settings, now + 60_000));
        const retirement = createDeferred<void>();
        const { owner, sessions } = createOwnerHarness(prepare, (session, index) => {
            if (index === 0) {
                session.retire = vi.fn(async () => {
                    session.host.isServing = false;
                    await retirement.promise;
                });
            }
        });
        await owner.open();
        now += 31_000;

        const replacement = owner.open();
        await vi.waitFor(() => expect(sessions[0].retire).toHaveBeenCalledOnce());
        expect(prepare).toHaveBeenCalledOnce();

        retirement.resolve();
        await replacement;

        expect(prepare).toHaveBeenCalledTimes(2);
        expect(sessions).toHaveLength(2);
    });

    it("shares one preparation between concurrent open requests", async () => {
        const now = 3_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const prepared = createDeferred<P2PSyncSetting>();
        const prepare = vi.fn(() => prepared.promise);
        const { createSession, owner, settings } = createOwnerHarness(prepare);

        const first = owner.open();
        const second = owner.open();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        prepared.resolve(preparedSettings(settings as P2PSyncSetting, now + 120_000));
        await Promise.all([first, second]);

        expect(prepare).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledOnce();
    });

    it("bounds preparation waiting and aborts a hook which does not settle", async () => {
        vi.useFakeTimers();
        const prepare = vi.fn(
            (_settings: Readonly<P2PSyncSetting>, _signal: AbortSignal) => new Promise<never>(() => undefined)
        );
        const { createSession, owner } = createOwnerHarness(prepare);

        const opening = owner.open();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        const signal = prepare.mock.calls[0][1];
        const timedOut = expect(opening).rejects.toThrow("managed P2P room could not be prepared or opened");
        await vi.advanceTimersByTimeAsync(30_000);

        await timedOut;
        expect(signal.aborted).toBe(true);
        expect(createSession).not.toHaveBeenCalled();
    });

    it("aborts preparation immediately when the owner is closed and ignores a late result", async () => {
        const now = 4_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const prepared = createDeferred<P2PSyncSetting>();
        const prepare = vi.fn((_settings: Readonly<P2PSyncSetting>, _signal: AbortSignal) => prepared.promise);
        const { createSession, owner, settings } = createOwnerHarness(prepare);

        const opening = owner.open();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        const signal = prepare.mock.calls[0][1];
        const closing = owner.close();
        expect(signal.aborted).toBe(true);
        prepared.resolve(preparedSettings(settings as P2PSyncSetting, now + 120_000));
        await Promise.all([opening, closing]);

        expect(createSession).not.toHaveBeenCalled();
        expect(owner.currentSession).toBeUndefined();
    });

    it("fences a late result and prepares changed provider credentials", async () => {
        const now = 5_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const firstResult = createDeferred<P2PSyncSetting>();
        const secondResult = createDeferred<P2PSyncSetting>();
        const prepare = vi.fn((settings: Readonly<P2PSyncSetting>) =>
            settings.P2P_managedToken === "token-a" ? firstResult.promise : secondResult.promise
        );
        const { createSession, owner, settings } = createOwnerHarness(prepare);

        const firstOpening = owner.open();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        const firstSignal = prepare.mock.calls[0][1];
        settings.P2P_managedToken = "token-b";
        const secondOpening = owner.open();
        expect(firstSignal.aborted).toBe(true);
        firstResult.resolve(preparedSettings(settings as P2PSyncSetting, now + 120_000, "obsolete-secret"));
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
        secondResult.resolve(preparedSettings(settings as P2PSyncSetting, now + 120_000, "current-secret"));
        await Promise.all([firstOpening, secondOpening]);

        expect(createSession).toHaveBeenCalledOnce();
        expect(createSession.mock.calls[0][0].settings.P2P_iceServers?.[0].credential).toBe("current-secret");
    });

    it("ignores static values returned by the hook", async () => {
        const now = 6_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const prepare = vi.fn(async (settings: Readonly<P2PSyncSetting>) => ({
            ...preparedSettings(settings, now + 120_000),
            P2P_roomID: "rewritten-room",
            P2P_managedToken: "rewritten-token",
        }));
        const { owner, sessions } = createOwnerHarness(prepare);

        await owner.open();

        expect(sessions[0].env.settings.P2P_roomID).toBe("room-a");
        expect(sessions[0].env.settings.P2P_managedToken).toBe("token-a");
    });

    it("fails a managed connection safely when the host has no preparation hook", async () => {
        const { createSession, owner } = createOwnerHarness();

        await expect(owner.open()).rejects.toThrow("managed P2P room could not be prepared or opened");
        expect(createSession).not.toHaveBeenCalled();
    });

    it("allows a generic host hook to provide STUN-only runtime ICE without provider metadata or expiry", async () => {
        const prepare = vi.fn(async (settings: Readonly<P2PSyncSetting>) => ({
            ...settings,
            P2P_iceServers: [{ urls: "stun:stun.example.com" }],
        }));
        const harness = createOwnerHarness(prepare);
        harness.settings.P2P_managedType = undefined as never;
        harness.settings.P2P_managedId = undefined as never;
        harness.settings.P2P_managedToken = undefined as never;
        harness.settings.P2P_connectionPath = "automatic";

        await harness.owner.open();

        expect(prepare).toHaveBeenCalledOnce();
        expect(harness.sessions[0].env.settings.P2P_iceServers).toEqual([{ urls: "stun:stun.example.com" }]);
        expect(harness.sessions[0].env.settings.P2P_iceServersExpiresAt).toBeUndefined();
    });
});

describe("P2P diagnostic session fences", () => {
    it("retains owned lifecycle events and discards reports from a retired room", async () => {
        const { owner, sessions, settings, diagnostic } = createOwnerHarness();
        settings.P2P_managedType = "";
        await owner.open();
        expect(diagnostic.mock.calls.map(([event]) => event.code)).toEqual(["room-opening", "room-opened"]);
        const oldReport = (sessions[0].env as any).reportDiagnostic;
        expect(oldReport).toBeTypeOf("function");
        oldReport({ category: "peer", code: "peer-left", peerId: "old-peer", timestamp: 10 });
        await owner.close();
        expect(diagnostic.mock.calls.at(-1)?.[0].code).toBe("room-closed");
        const afterClose = diagnostic.mock.calls.length;
        oldReport({ category: "peer", code: "peer-left", peerId: "late-peer", timestamp: 9999 });
        expect(diagnostic).toHaveBeenCalledTimes(afterClose);
        await owner.open();
        const afterReplacement = diagnostic.mock.calls.length;
        oldReport({ category: "peer", code: "peer-left", peerId: "late-peer", timestamp: 99999 });
        expect(diagnostic).toHaveBeenCalledTimes(afterReplacement);
        (sessions[1].env as any).reportDiagnostic({
            category: "peer",
            code: "peer-advertised",
            peerId: "new-peer",
            timestamp: 20,
        });
        expect(diagnostic.mock.calls.at(-1)?.[0].peerId).toBe("new-peer");
        await owner.close();
    });

    it("observes an opening error without exposing its text or changing unmanaged resolution", async () => {
        const { owner, settings, diagnostic } = createOwnerHarness(undefined, (session) => {
            session.open.mockRejectedValue(new Error("private key and room details"));
        });
        settings.P2P_managedType = "";
        await expect(owner.open()).resolves.toBeUndefined();
        expect(diagnostic.mock.calls.map(([event]) => event.code)).toEqual(["room-opening", "room-open-failed"]);
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private key");
    });
});

describe("P2P diagnostic observer isolation", () => {
    it("contains a failing lifecycle observer and keeps open and close results", async () => {
        const { owner, settings, sessions, diagnostic } = createOwnerHarness();
        settings.P2P_managedType = "";
        diagnostic.mockImplementation(() => {
            throw new Error("observer unavailable");
        });
        await expect(owner.open()).resolves.toBeUndefined();
        expect(sessions[0].host.isServing).toBe(true);
        await expect(owner.close()).resolves.toBeUndefined();
        expect(sessions[0].host.isServing).toBe(false);
    });
});
