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
    const env = {
        services: {
            context: { events: {}, translate: (key: string) => key },
            setting: { currentSettings: () => settings },
            keyValueDB: { openSimpleStore: () => ({}) },
            database: { localDatabase: { localDatabase: {} } },
            config: { getSmallConfig: () => "device-a" },
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
    const owner = new P2PRoomSessionOwner(env, createSession, { prepareP2PSettings });
    return { createSession, owner, sessions, settings };
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
        const prepare = vi.fn((_settings: Readonly<P2PSyncSetting>, _signal: AbortSignal) => new Promise<never>(() => undefined));
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
