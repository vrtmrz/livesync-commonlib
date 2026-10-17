import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DEFAULT_SETTINGS, VERSIONING_DOCID, type EntryDoc, type FilePathWithPrefix } from "@lib/common/types";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import type { ISettingService } from "@lib/services/base/IService";
import { EntryManager, type EntryManagerOptions } from "./EntryManager";

PouchDB.plugin(MemoryAdapter);
const databases: PouchDB.Database<EntryDoc>[] = [];
let sequence = 0;

function fixture() {
    const settings = { ...DEFAULT_SETTINGS, pathNormalizationVersion: 0 };
    const settingService = { currentSettings: () => settings } as ISettingService;
    const pathService = new PathServiceCompat(new ServiceContext(), { settingService });
    const database = new PouchDB<EntryDoc>(`entry-path-admission-${++sequence}`, { adapter: "memory" });
    databases.push(database);
    const manager = new EntryManager({ database, settingService, pathService } as EntryManagerOptions);
    return { settings, database, pathService, manager };
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("EntryManager path identity admission", () => {
    it("accepts a fresh database declared by another writer during the Metadata check", async () => {
        const { settings, database, manager } = fixture();
        settings.pathNormalizationVersion = 1;
        const allDocs = database.allDocs.bind(database);
        vi.spyOn(database, "allDocs").mockImplementationOnce(async (options: any) => {
            await database.put({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: ["nfc-path-identity-v1"],
            });
            await database.put({
                _id: "other.md" as any,
                path: "other.md" as FilePathWithPrefix,
                type: "plain",
                ctime: 1,
                mtime: 1,
                size: 0,
                children: [],
            });
            return await allDocs(options);
        });

        await expect(manager.deleteDBEntry("missing.md" as FilePathWithPrefix)).resolves.toBe(false);
        expect(await database.get("other.md")).not.toHaveProperty("deleted");
    });

    it("refuses writes after enabling NFC over legacy Metadata, before changing any document", async () => {
        const { settings, database, pathService, manager } = fixture();
        const path = "Cafe\u0301.md" as FilePathWithPrefix;
        const document = {
            _id: await pathService.path2id(path),
            path,
            type: "plain" as const,
            ctime: 1,
            mtime: 1,
            size: 0,
            children: [],
        };
        await database.put(document);
        const before = await database.info();
        settings.pathNormalizationVersion = 1;

        await expect(manager.deleteDBEntry(path)).rejects.toThrow(/Rebuild|Fetch/);

        expect((await database.info()).update_seq).toBe(before.update_seq);
        expect(await database.get(document._id)).not.toHaveProperty("deleted");
    });

    it("refuses legacy writes to a database declaring NFC identity", async () => {
        const { database, manager } = fixture();
        await database.put({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["nfc-path-identity-v1"],
        });
        const before = await database.info();

        await expect(manager.deleteDBEntry("missing.md" as FilePathWithPrefix)).rejects.toThrow(/path identity/);

        expect((await database.info()).update_seq).toBe(before.update_seq);
    });

    it("declares NFC identity before the first write to a fresh local database", async () => {
        const { settings, database, manager } = fixture();
        settings.pathNormalizationVersion = 1;

        await manager.deleteDBEntry("missing.md" as FilePathWithPrefix);

        expect(await database.get(VERSIONING_DOCID)).toMatchObject({
            type: "versioninfo",
            version: 13,
            used_features: ["nfc-path-identity-v1"],
        });
        settings.pathNormalizationVersion = 0;
        await expect(manager.deleteDBEntry("missing.md" as FilePathWithPrefix)).rejects.toThrow(/path identity/);
    });
});
