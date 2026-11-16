import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { LiveSyncLocalDB as LiveSyncLocalDBClass } from "@lib/pouchdb/LiveSyncLocalDB";
import { ServiceContext } from "./ServiceBase";
import { DatabaseService } from "./DatabaseService";
import { SuffixDatabaseName } from "@lib/common/models/shared.const.ts";
import type { openDatabaseParameters } from "./IService";

class TestDatabaseService extends DatabaseService {
    setActiveDatabase(database: LiveSyncLocalDB | null) {
        this._localDatabase = database;
    }
}

function localDatabase(name: string, resetResult = true) {
    return {
        dbname: name,
        close: vi.fn(async () => undefined),
        onunload: vi.fn(),
        resetDatabase: vi.fn(async () => resetResult),
    } as unknown as LiveSyncLocalDB;
}

function createDatabaseService(selectedDatabaseName = "vault-current") {
    return new TestDatabaseService(new ServiceContext(), {
        pouchDB: vi.fn() as never,
        path: {} as never,
        vault: {
            getVaultName: vi.fn(() => selectedDatabaseName),
        } as never,
        setting: {
            currentSettings: vi.fn(() => ({ useIndexedDBAdapter: false })),
        } as never,
        API: { addLog: vi.fn() } as never,
    });
}

const openParameters = {} as openDatabaseParameters;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("DatabaseService active database ownership", () => {
    it("does not retain an active database whose physical readiness was rejected", async () => {
        const service = createDatabaseService();
        const initialise = vi.spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase").mockResolvedValueOnce(false);

        await expect(service.openDatabase(openParameters)).resolves.toBe(false);

        expect(initialise).toHaveBeenCalledOnce();
        expect(service.localDatabaseDirect).toBeNull();
        expect(service.isDatabaseReady()).toBe(false);
    });

    it("does not retain an active database whose physical initialisation threw", async () => {
        const error = new Error("physical initialisation failed");
        const service = createDatabaseService();
        vi.spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase").mockRejectedValueOnce(error);

        await expect(service.openDatabase(openParameters)).rejects.toBe(error);

        expect(service.localDatabaseDirect).toBeNull();
        expect(service.isDatabaseReady()).toBe(false);
    });
});

describe("DatabaseService reset ownership", () => {
    it("does not reset a replacement selected while the reset waits for the lifecycle lock", async () => {
        const service = createDatabaseService();
        let finish!: () => void;
        const gate = new Promise<boolean>((resolve) => {
            finish = () => resolve(true);
        });
        const initialise = vi
            .spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase")
            .mockImplementationOnce(() => gate)
            .mockResolvedValue(true);
        vi.spyOn(LiveSyncLocalDBClass.prototype, "close").mockResolvedValue(undefined);
        const reset = vi.spyOn(LiveSyncLocalDBClass.prototype, "resetDatabase").mockResolvedValue(true);
        const first = service.openDatabase(openParameters);
        await vi.waitFor(() => expect(initialise).toHaveBeenCalledOnce());
        const next = service.openDatabase(openParameters);
        const pendingReset = service.resetDatabase();
        finish();
        await first;
        await next;
        await expect(pendingReset).resolves.toBe(false);
        expect(reset).not.toHaveBeenCalled();
    });

    it("selects the settings-derived database before resetting it", async () => {
        const service = createDatabaseService("vault-current");
        const previous = localDatabase("vault-previous");
        const selected = localDatabase("vault-current");
        service.setActiveDatabase(previous);
        const open = vi.spyOn(service, "openDatabase").mockImplementation(async () => {
            service.setActiveDatabase(selected);
            return true;
        });

        await expect(service.resetDatabaseForCurrentSettings(openParameters)).resolves.toBe(true);

        expect(open).toHaveBeenCalledWith(openParameters);
        expect(previous.resetDatabase).not.toHaveBeenCalled();
        expect(selected.resetDatabase).toHaveBeenCalledOnce();
    });

    it("does not reopen an already selected active database", async () => {
        const service = createDatabaseService("vault-current");
        const selected = localDatabase("vault-current");
        service.setActiveDatabase(selected);
        const open = vi.spyOn(service, "openDatabase");

        await expect(service.resetDatabaseForCurrentSettings(openParameters)).resolves.toBe(true);

        expect(open).not.toHaveBeenCalled();
        expect(selected.resetDatabase).toHaveBeenCalledOnce();
    });

    it("stops when the settings-derived database cannot be opened", async () => {
        const service = createDatabaseService("vault-current");
        const previous = localDatabase("vault-previous");
        service.setActiveDatabase(previous);
        vi.spyOn(service, "openDatabase").mockResolvedValue(false);

        await expect(service.resetDatabaseForCurrentSettings(openParameters)).resolves.toBe(false);

        expect(previous.resetDatabase).not.toHaveBeenCalled();
    });

    it("does not reset a different database if selection changes while opening", async () => {
        const service = createDatabaseService("vault-current");
        const previous = localDatabase("vault-previous");
        const unexpected = localDatabase("vault-unexpected");
        service.setActiveDatabase(previous);
        vi.spyOn(service, "openDatabase").mockImplementation(async () => {
            service.setActiveDatabase(unexpected);
            return true;
        });

        await expect(service.resetDatabaseForCurrentSettings(openParameters)).resolves.toBe(false);

        expect(previous.resetDatabase).not.toHaveBeenCalled();
        expect(unexpected.resetDatabase).not.toHaveBeenCalled();
    });

    it("runs completion handlers only after a successful reset", async () => {
        const service = createDatabaseService();
        const completion = vi.fn(async () => true);
        service.onDatabaseReset.addHandler(completion);
        const rejected = localDatabase("vault-current", false);
        service.setActiveDatabase(rejected);

        await expect(service.resetDatabase()).resolves.toBe(false);
        expect(completion).not.toHaveBeenCalled();
        expect(rejected.close).toHaveBeenCalledOnce();
        expect(service.localDatabaseDirect).toBeNull();

        service.setActiveDatabase(localDatabase("vault-current"));
        await expect(service.resetDatabase()).resolves.toBe(true);
        expect(completion).toHaveBeenCalledOnce();
    });

    it("reports a failed post-reset dependency as a reset failure", async () => {
        const service = createDatabaseService();
        const reset = localDatabase("vault-current");
        service.setActiveDatabase(reset);
        service.onDatabaseReset.addHandler(async () => false);

        await expect(service.resetDatabase()).resolves.toBe(false);

        expect(reset.close).toHaveBeenCalledOnce();
        expect(service.localDatabaseDirect).toBeNull();
    });

    it("discards the active database before propagating a reset error", async () => {
        const error = new Error("reset failed");
        const service = createDatabaseService();
        const reset = localDatabase("vault-current");
        vi.spyOn(reset, "resetDatabase").mockRejectedValueOnce(error);
        service.setActiveDatabase(reset);

        await expect(service.resetDatabase()).rejects.toBe(error);

        expect(reset.close).toHaveBeenCalledOnce();
        expect(service.localDatabaseDirect).toBeNull();
    });
});

describe("DatabaseService connection lifetime", () => {
    it("serialises two opens until initialisation and the preceding close have settled", async () => {
        const service = createDatabaseService();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const initialised: LiveSyncLocalDB[] = [];
        vi.spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase").mockImplementation(async function () {
            initialised.push(this);
            if (initialised.length === 1) await pending;
            this.isReady = true;
            return true;
        });
        const close = vi.spyOn(LiveSyncLocalDBClass.prototype, "close").mockResolvedValue();
        const first = service.openDatabase(openParameters);
        const second = service.openDatabase(openParameters);
        try {
            await vi.waitFor(() => expect(initialised.length).toBeGreaterThan(0));
            await Promise.resolve();
            expect(initialised).toHaveLength(1);
            expect(close).not.toHaveBeenCalled();
        } finally {
            release();
        }
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(initialised).toHaveLength(2);
        expect(close).toHaveBeenCalledOnce();
        expect(service.localDatabaseDirect).toBe(initialised[1]);
    });

    it("does not create a database just to check a missing or unready connection", async () => {
        const service = createDatabaseService();
        const open = vi.spyOn(service, "openDatabase");
        await expect(service.canReadCurrentDatabaseInfo()).resolves.toBe(false);
        const unready = localDatabase("vault-current");
        Object.assign(unready, { isReady: false, localDatabase: { info: vi.fn() } });
        service.setActiveDatabase(unready);
        await expect(service.canReadCurrentDatabaseInfo()).resolves.toBe(false);
        expect(unready.localDatabase.info).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    it.each(["idb", "indexeddb"])("checks the existing %s instance and retains the original error", async (adapter) => {
        const service = createDatabaseService();
        const error = new DOMException("The database connection is closing.", "InvalidStateError");
        const info = vi.fn().mockResolvedValueOnce({ adapter }).mockRejectedValueOnce(error);
        const active = localDatabase("vault-current");
        Object.assign(active, { isReady: true, localDatabase: { info } });
        service.setActiveDatabase(active);
        await expect(service.canReadCurrentDatabaseInfo()).resolves.toBe(true);
        await expect(service.canReadCurrentDatabaseInfo()).rejects.toBe(error);
        expect(service.localDatabaseDirect).toBe(active);
        expect(active.close).not.toHaveBeenCalled();
    });

    it("reopens a failed lifetime once when duplicate recovery requests are queued", async () => {
        const service = createDatabaseService();
        const initialise = vi
            .spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase")
            .mockImplementation(async function () {
                this.isReady = true;
                return true;
            });
        const close = vi.spyOn(LiveSyncLocalDBClass.prototype, "close").mockResolvedValue(undefined);
        await service.openDatabase(openParameters);
        const active = service.localDatabase;
        active.isReady = false;
        initialise.mockClear();
        await expect(
            Promise.all([
                service.reopenDatabase(active, openParameters),
                service.reopenDatabase(active, openParameters),
            ])
        ).resolves.toEqual([true, false]);
        expect(close).toHaveBeenCalledOnce();
        expect(initialise).toHaveBeenCalledOnce();
    });

    it("does not reopen a retired database after an explicit close", async () => {
        const service = createDatabaseService();
        const active = localDatabase("vault-current");
        service.setActiveDatabase(active);
        await service.closeDatabase();
        await expect(service.reopenDatabase(active, openParameters)).resolves.toBe(false);
        expect(service.localDatabaseDirect).toBeNull();
        expect(active.close).toHaveBeenCalledOnce();
    });
});

it("rejects recovery when the selected database changes while work drains", async () => {
    let useIndexedDBAdapter = false;
    const pouchDB = vi.fn(function (name: string, options: { adapter?: string }) {
        return { name, adapter: options.adapter ?? "idb" };
    });
    const service = new TestDatabaseService(new ServiceContext(), {
        pouchDB: pouchDB as never,
        path: {} as never,
        vault: { getVaultName: () => "vault-current" } as never,
        setting: { currentSettings: () => ({ useIndexedDBAdapter }) } as never,
        API: { addLog: vi.fn() } as never,
    });
    vi.spyOn(LiveSyncLocalDBClass.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(LiveSyncLocalDBClass.prototype, "initializeDatabase").mockImplementation(async function () {
        const runtime = (
            this as unknown as { runtimeOptions: { createPouchDBInstance?: typeof service.createPouchDBInstance } }
        ).runtimeOptions;
        const create =
            runtime.createPouchDBInstance ??
            this.env.services.database.createPouchDBInstance.bind(this.env.services.database);
        this.localDatabase = create(this.dbname + SuffixDatabaseName);
        this.isReady = true;
        return true;
    });
    await service.openDatabase(openParameters);
    const originalName = (service.localDatabase.localDatabase as unknown as { name: string }).name;
    const active = service.localDatabase;
    const params = {
        databaseEvents: {
            onBeforeDatabaseRecovery: async () => {
                useIndexedDBAdapter = true;
                return true;
            },
        },
    } as openDatabaseParameters;
    await expect(service.reopenDatabase(active, params)).resolves.toBe(false);
    expect(service.localDatabase).toBe(active);
    expect((service.localDatabase.localDatabase as unknown as { name: string }).name).toBe(originalName);
    expect((service.localDatabase.localDatabase as unknown as { adapter: string }).adapter).toBe("idb");
});
