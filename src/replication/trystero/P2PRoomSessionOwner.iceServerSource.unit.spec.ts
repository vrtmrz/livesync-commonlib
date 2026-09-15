import { afterEach, describe, expect, it, vi } from "vitest";
import type { IceServerSourceFactoryCatalogue } from "@lib/p2p/IceServerSource";
import { P2PRoomSessionOwner } from "./P2PRoomSessionOwner";

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
        P2P_iceServerSource: {
            version: 1,
            id: "managed",
            configuration: { apiToken: "token-a" },
        },
    };
}

function createOwnerHarness(
    catalogue: IceServerSourceFactoryCatalogue,
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
    const owner = new P2PRoomSessionOwner(env, createSession, { iceServerSources: catalogue });
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

    constructor(readonly env: { readonly iceServers?: readonly RTCIceServer[] }) {}
}

function validConfiguration(expiresAt: number, credential = "issued-secret") {
    return {
        iceServers: [
            {
                urls: ["stun:stun.example.com", "turns:turn.example.com"],
                username: "issued-user",
                credential,
            },
        ],
        expiresAt,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("P2PRoomSessionOwner managed ICE server lifecycle", () => {
    it("reuses an equivalent serving room while its cached credentials remain usable", async () => {
        let now = 1_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const acquire = vi.fn(async () => validConfiguration(now + 120_000));
        const factory = vi.fn(() => ({ acquire }));
        const { createSession, owner, sessions } = createOwnerHarness({ managed: factory });

        await owner.open();
        now += 10_000;
        await owner.open();

        expect(factory).toHaveBeenCalledOnce();
        expect(acquire).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledOnce();
        expect(sessions[0].env.iceServers).toEqual(validConfiguration(0).iceServers);
    });

    it("settles the expired room before acquiring credentials for its replacement", async () => {
        let now = 2_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const acquire = vi.fn(async () => validConfiguration(now + 60_000));
        const retirement = createDeferred<void>();
        const { owner, sessions } = createOwnerHarness({ managed: () => ({ acquire }) }, (session, index) => {
            if (index === 0) {
                session.retire = vi.fn(async () => {
                    session.host.isServing = false;
                    await retirement.promise;
                });
            }
        });
        await owner.open();
        now += 31_000;
        expect(sessions).toHaveLength(1);
        expect(acquire).toHaveBeenCalledOnce();

        const replacement = owner.open();
        await vi.waitFor(() => expect(sessions[0].retire).toHaveBeenCalledOnce());
        expect(acquire).toHaveBeenCalledOnce();
        expect(sessions).toHaveLength(1);

        retirement.resolve();
        await replacement;

        expect(acquire).toHaveBeenCalledTimes(2);
        expect(sessions).toHaveLength(2);
    });

    it("shares one acquisition between concurrent open requests", async () => {
        const now = 3_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const acquired = createDeferred<ReturnType<typeof validConfiguration>>();
        const acquire = vi.fn(() => acquired.promise);
        const { createSession, owner } = createOwnerHarness({ managed: () => ({ acquire }) });

        const first = owner.open();
        const second = owner.open();
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
        acquired.resolve(validConfiguration(now + 120_000));
        await Promise.all([first, second]);

        expect(acquire).toHaveBeenCalledOnce();
        expect(createSession).toHaveBeenCalledOnce();
    });

    it("bounds acquisition waiting and aborts a source which does not settle", async () => {
        vi.useFakeTimers();
        const acquire = vi.fn((_signal: AbortSignal) => new Promise<never>(() => undefined));
        const { createSession, owner } = createOwnerHarness({ managed: () => ({ acquire }) });

        const opening = owner.open();
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
        const signal = acquire.mock.calls[0][0];
        const timedOut = expect(opening).rejects.toMatchObject({ code: "unavailable", retryable: true });
        await vi.advanceTimersByTimeAsync(30_000);

        await timedOut;
        expect(signal.aborted).toBe(true);
        expect(createSession).not.toHaveBeenCalled();
    });

    it("aborts an acquisition immediately when the owner is explicitly closed", async () => {
        const now = 4_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const acquired = createDeferred<ReturnType<typeof validConfiguration>>();
        let acquisitionSignal: AbortSignal | undefined;
        const acquire = vi.fn((signal: AbortSignal) => {
            acquisitionSignal = signal;
            return acquired.promise;
        });
        const { createSession, owner } = createOwnerHarness({ managed: () => ({ acquire }) });

        const opening = owner.open();
        await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());
        const closing = owner.close();
        expect(acquisitionSignal?.aborted).toBe(true);
        acquired.resolve(validConfiguration(now + 120_000));
        await Promise.all([opening, closing]);

        expect(createSession).not.toHaveBeenCalled();
        expect(owner.currentSession).toBeUndefined();
    });

    it("aborts an acquisition immediately when P2P is disabled", async () => {
        const now = 5_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const acquired = createDeferred<ReturnType<typeof validConfiguration>>();
        let acquisitionSignal: AbortSignal | undefined;
        const acquire = (signal: AbortSignal) => {
            acquisitionSignal = signal;
            return acquired.promise;
        };
        const { createSession, owner, settings } = createOwnerHarness({ managed: () => ({ acquire }) });

        const opening = owner.open();
        await vi.waitFor(() => expect(acquisitionSignal).toBeDefined());
        settings.P2P_Enabled = false;
        const disabling = owner.setPersistentDemand("automatic", false);
        expect(acquisitionSignal?.aborted).toBe(true);
        acquired.resolve(validConfiguration(now + 120_000));
        await Promise.all([opening, disabling]);

        expect(createSession).not.toHaveBeenCalled();
    });

    it("fences a late result and acquires for a changed source configuration", async () => {
        const now = 6_000_000;
        vi.spyOn(Date, "now").mockReturnValue(now);
        const firstResult = createDeferred<ReturnType<typeof validConfiguration>>();
        const secondResult = createDeferred<ReturnType<typeof validConfiguration>>();
        const signals: AbortSignal[] = [];
        const factory = vi.fn((configuration: Readonly<Record<string, unknown>>) => ({
            acquire: (signal: AbortSignal) => {
                signals.push(signal);
                return configuration.apiToken === "token-a" ? firstResult.promise : secondResult.promise;
            },
        }));
        const { createSession, owner, settings } = createOwnerHarness({ managed: factory });

        const firstOpening = owner.open();
        await vi.waitFor(() => expect(signals).toHaveLength(1));
        settings.P2P_iceServerSource = {
            version: 1,
            id: "managed",
            configuration: { apiToken: "token-b" },
        };
        const secondOpening = owner.open();
        expect(signals[0].aborted).toBe(true);
        firstResult.resolve(validConfiguration(now + 120_000, "obsolete-secret"));
        await vi.waitFor(() => expect(signals).toHaveLength(2));
        secondResult.resolve(validConfiguration(now + 120_000, "current-secret"));
        await Promise.all([firstOpening, secondOpening]);

        expect(factory).toHaveBeenCalledTimes(2);
        expect(createSession).toHaveBeenCalledOnce();
        expect(createSession.mock.calls[0][0].iceServers?.[0].credential).toBe("current-secret");
    });

    it("rejects an encrypted source which is unavailable at runtime instead of using manual TURN", async () => {
        const { createSession, owner, settings } = createOwnerHarness({});
        settings.P2P_iceServerSource = undefined as any;
        (settings as typeof settings & { encryptedP2PIceServerSource: string }).encryptedP2PIceServerSource =
            "encrypted-source";

        await expect(owner.open()).rejects.toMatchObject({ code: "configuration", retryable: false });
        expect(createSession).not.toHaveBeenCalled();
    });
});
