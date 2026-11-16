import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import IdbAdapter from "pouchdb-adapter-idb";
import { DEFAULT_SETTINGS, type DocumentID } from "@lib/common/types";
import { DatabaseService } from "./DatabaseService";
import { DatabaseEventService } from "./DatabaseEventService";
import { ServiceContext } from "./ServiceBase";

vi.mock("@lib/managers/LiveSyncManagers", () => ({
    LiveSyncManagers: class {
        changeManager = { restartWatch: vi.fn() };
        initialise = vi.fn(async () => undefined);
        teardownManagers = vi.fn(async () => undefined);
        prepareHashFunction = vi.fn(async () => undefined);
    },
}));

PouchDB.plugin(IdbAdapter);
class TestDatabaseService extends DatabaseService {}
class TestDatabaseEvents extends DatabaseEventService {}
afterEach(() => vi.restoreAllMocks());

describe("DatabaseService with the PouchDB 9 idb adapter", () => {
    it("reopens a deliberately closed native handle and keeps the document and revision", async () => {
        const context = new ServiceContext();
        const events = new TestDatabaseEvents(context);
        const vaultName = `connection-recovery-${crypto.randomUUID()}`;
        const nativeHandles: IDBDatabase[] = [];
        const nativeOpen = indexedDB.open.bind(indexedDB);
        vi.spyOn(indexedDB, "open").mockImplementation((...args) => {
            const request = nativeOpen(...args);
            request.addEventListener("success", () => nativeHandles.push(request.result));
            return request;
        });
        const service = new TestDatabaseService(context, {
            pouchDB: PouchDB,
            path: {} as never,
            vault: { getVaultName: () => vaultName } as never,
            setting: { currentSettings: () => DEFAULT_SETTINGS } as never,
            API: { addLog: vi.fn() } as never,
        });
        const params = {
            databaseEvents: events,
            replicator: { onCloseActiveReplication: vi.fn(async () => true) } as never,
        };
        const observed = vi.fn(async () => true);
        service.onLocalDatabaseError.addHandler(observed);
        expect(await service.openDatabase(params)).toBe(true);
        const original = service.localDatabase;
        const document = { _id: "h:retained" as DocumentID, type: "leaf", data: "retained content" } as const;
        const pouch = original.localDatabase as typeof original.localDatabase & { id(): Promise<string> };
        const written = await pouch.put(document);
        const databaseId = await pouch.id();
        expect(await service.canReadCurrentDatabaseInfo()).toBe(true);
        expect(nativeHandles).toHaveLength(1);
        nativeHandles[0].close();
        try {
            await expect(original.localDatabase.get(document._id)).rejects.toMatchObject({ name: "InvalidStateError" });
            await expect(service.canReadCurrentDatabaseInfo()).rejects.toMatchObject({ name: "InvalidStateError" });
            expect(observed).not.toHaveBeenCalled();
            // Raw Pouch is not intercepted. The owner explicitly requests its usability check.
            expect(await service.reopenDatabase(original, params)).toBe(true);
            expect(nativeHandles).toHaveLength(2);
            expect(await (service.localDatabase.localDatabase as typeof pouch).id()).toBe(databaseId);
            expect(await service.localDatabase.localDatabase.get(document._id)).toMatchObject({
                ...document,
                _rev: written.rev,
            });
            expect(await service.canReadCurrentDatabaseInfo()).toBe(true);
        } finally {
            const name = service.localDatabaseDirect?.localDatabase?.name;
            await service.closeDatabase();
            if (name) await new PouchDB(name, { adapter: "idb" }).destroy();
        }
    });
});
