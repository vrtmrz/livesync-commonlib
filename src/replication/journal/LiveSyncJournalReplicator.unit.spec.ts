import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type RemoteDBSettings } from "@lib/common/types.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import { MinioStorageAdapter } from "./objectstore/MinioStorageAdapter.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("LiveSyncJournalReplicator initialisation", () => {
    it("does not access the local database while constructing a remote-only replicator", () => {
        const getLocalDatabase = vi.fn(() => {
            throw new Error("Local database is not ready yet.");
        });
        const env = {
            services: {
                database: {
                    get localDatabase() {
                        return getLocalDatabase();
                    },
                },
            },
        } as unknown as ConstructorParameters<typeof LiveSyncJournalReplicator>[0];

        expect(() => new LiveSyncJournalReplicator(env)).not.toThrow();
        expect(getLocalDatabase).not.toHaveBeenCalled();
    });
});

describe("LiveSyncJournalReplicator replication outcomes", () => {
    it("does not report an incomplete journal transfer as completed", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        const sync = vi.fn().mockResolvedValue(false);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(true);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            sync,
        } as never);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, false)).resolves.toBe(false);
        expect(sync).toHaveBeenCalledWith(false);
    });
});

describe("LiveSyncJournalReplicator finite resource ownership", () => {
    it.each([
        ["successful", () => Promise.resolve([]), true],
        ["failed", () => Promise.reject(new Error("bucket unavailable")), false],
    ] as const)("disposes the Object Storage connection probe after a %s request", async (_case, run, expected) => {
        vi.spyOn(MinioStorageAdapter.prototype, "listFiles").mockImplementation(run);
        const dispose = vi.spyOn(MinioStorageAdapter.prototype, "dispose");
        const replicator = new LiveSyncJournalReplicator({} as never);

        await expect(replicator.tryConnectRemote(DEFAULT_SETTINGS, false)).resolves.toBe(expected);

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("does not construct a Journal client merely to close an unused Replicator", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        replicator.updateInfo = vi.fn();
        const setupJournalSyncClient = vi
            .spyOn(replicator, "setupJournalSyncClient")
            .mockReturnValue({ requestStop: vi.fn() } as never);

        replicator.closeReplication();

        expect(setupJournalSyncClient).not.toHaveBeenCalled();
    });

    it("disposes an existing Journal client when replication closes", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const dispose = vi.fn();
        const client = {
            applyNewConfig: vi.fn(),
            dispose,
            requestStop: vi.fn(),
        };
        replicator._client = client as never;
        replicator.updateInfo = vi.fn();
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);

        replicator.closeReplication();

        expect(dispose).toHaveBeenCalledOnce();
    });

    it.each([
        ["successful", () => Promise.resolve({ estimatedSize: 12 }), { estimatedSize: 12 }],
        ["failed", () => Promise.reject(new Error("status unavailable")), undefined],
    ] as const)("disposes the Object Storage status adapter after a %s request", async (_case, run, expected) => {
        vi.spyOn(MinioStorageAdapter.prototype, "getUsage").mockImplementation(run);
        const dispose = vi.spyOn(MinioStorageAdapter.prototype, "dispose");
        const replicator = new LiveSyncJournalReplicator({} as never);

        const operation = replicator.getRemoteStatus(DEFAULT_SETTINGS);
        if (expected === undefined) {
            await expect(operation).rejects.toThrow("status unavailable");
        } else {
            await expect(operation).resolves.toEqual(expected);
        }

        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator remote preferred tweak values", () => {
    function createReplicator(result: unknown) {
        const replicator = new LiveSyncJournalReplicator({
            services: {
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue(result as never);
        return replicator;
    }

    it("distinguishes a missing milestone from an unavailable object store", async () => {
        const replicator = createReplicator({ status: "not-found" });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });
    });

    it("reports an object-store read failure as unavailable", async () => {
        const failure = new Error("network failed");
        const replicator = createReplicator({ status: "unavailable", error: failure });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
    });

    it("distinguishes a milestone without preferred values", async () => {
        const replicator = createReplicator({ status: "available", value: { tweak_values: {} } });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "preferred-values-missing",
        });
    });

    it("returns available preferred values explicitly", async () => {
        const values = { encrypt: true };
        const replicator = createReplicator({
            status: "available",
            value: { tweak_values: { PREFERRED: values } },
        });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "available",
            values,
        });
    });

    it("binds a preferred-tweak read to the supplied settings and disposes its trial client", async () => {
        const currentSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://current.example.test",
        };
        const trialSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://trial.example.test",
        };
        const currentSettingsReader = vi.fn(() => currentSettings);
        const replicator = new LiveSyncJournalReplicator({
            services: {
                setting: { currentSettings: currentSettingsReader },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        let observedEndpoint: string | undefined;
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockImplementation(async function () {
            observedEndpoint = this._settings.endpoint;
            return { status: "not-found" };
        });
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.getRemotePreferredTweakValues(trialSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });

        expect(observedEndpoint).toBe(trialSettings.endpoint);
        expect(currentSettingsReader).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("disposes the trial client when a preferred-tweak read rejects", async () => {
        const error = new Error("preferred values unavailable");
        const replicator = new LiveSyncJournalReplicator({
            services: {
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockRejectedValue(error);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.getRemotePreferredTweakValues(DEFAULT_SETTINGS)).rejects.toBe(error);

        expect(dispose).toHaveBeenCalledOnce();
    });
});
