import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { createIndexedDBKeyValueDatabaseFactory } from "./IndexedDBKeyValueDatabase";

describe("IndexedDB key-value database", () => {
    it("reopens a closed database and replaces a destroyed database", async () => {
        const databaseKey = `livesync-commonlib-test-${crypto.randomUUID()}`;
        const openDatabase = createIndexedDBKeyValueDatabaseFactory();
        const firstDatabase = await openDatabase(databaseKey);
        let firstDatabaseDestroyed = false;

        try {
            await firstDatabase.set("first", { value: 1 });
            await firstDatabase.set("second", { value: 2 });
            expect(await firstDatabase.get<{ value: number }>("first")).toEqual({ value: 1 });
            expect(await firstDatabase.keys()).toEqual(["first", "second"]);

            await firstDatabase.close();
            const reopenedDatabase = await openDatabase(databaseKey);
            expect(reopenedDatabase).toBe(firstDatabase);
            expect(await reopenedDatabase.get<{ value: number }>("second")).toEqual({ value: 2 });

            await reopenedDatabase.destroy();
            firstDatabaseDestroyed = true;
            await expect(reopenedDatabase.get("first")).rejects.toThrow("Database is destroyed");

            const replacementDatabase = await openDatabase(databaseKey);
            expect(replacementDatabase).not.toBe(reopenedDatabase);
            expect(await replacementDatabase.get("first")).toBeUndefined();
            await replacementDatabase.destroy();
        } finally {
            if (!firstDatabaseDestroyed) await firstDatabase.destroy();
        }
    });
});
