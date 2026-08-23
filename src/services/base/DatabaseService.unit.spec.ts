import { describe, expect, it, vi } from "vitest";
import type { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { ServiceContext } from "./ServiceBase";
import { DatabaseService } from "./DatabaseService";
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
        setting: {} as never,
        API: {} as never,
    });
}

const openParameters = {} as openDatabaseParameters;

describe("DatabaseService reset ownership", () => {
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
        service.setActiveDatabase(localDatabase("vault-current", false));

        await expect(service.resetDatabase()).resolves.toBe(false);
        expect(completion).not.toHaveBeenCalled();

        service.setActiveDatabase(localDatabase("vault-current"));
        await expect(service.resetDatabase()).resolves.toBe(true);
        expect(completion).toHaveBeenCalledOnce();
    });

    it("reports a failed post-reset dependency as a reset failure", async () => {
        const service = createDatabaseService();
        service.setActiveDatabase(localDatabase("vault-current"));
        service.onDatabaseReset.addHandler(async () => false);

        await expect(service.resetDatabase()).resolves.toBe(false);
    });
});
