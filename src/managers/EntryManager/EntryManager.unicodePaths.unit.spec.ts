import { afterEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DEFAULT_SETTINGS, type EntryDoc, type FilePathWithPrefix } from "@lib/common/types";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import type { ISettingService } from "@lib/services/base/IService";
import { getDBEntryMetaByPath } from "./EntryManagerImpls";

PouchDB.plugin(MemoryAdapter);
let nextDatabase = 0;
const databases: PouchDB.Database<EntryDoc>[] = [];

class NFCPathService extends PathServiceCompat {
    protected override normalizePath(path: string): string {
        return super.normalizePath(path).normalize("NFC");
    }
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe.each([false, true])("Unicode paths with path obfuscation %s", (usePathObfuscation) => {
    it.each([
        { form: "ASCII", path: "Folder/note.md" },
        { form: "NFC", path: "Caf\u00e9/r\u00e9sum\u00e9.md" },
        { form: "NFD", path: "Cafe\u0301/re\u0301sume\u0301.md" },
        { form: "mixed NFC and NFD", path: "Caf\u00e9/re\u0301sume\u0301.md" },
    ])("retrieves received $form metadata through the receiving host's storage path", async ({ path }) => {
        const settings = {
            ...DEFAULT_SETTINGS,
            encrypt: usePathObfuscation,
            usePathObfuscation,
            passphrase: "unicode-path-regression-secret",
            handleFilenameCaseSensitive: false,
            pathNormalizationVersion: 1,
        };
        const settingService = { currentSettings: () => settings } as ISettingService;
        const sender = new PathServiceCompat(new ServiceContext(), { settingService });
        const receiver = new NFCPathService(new ServiceContext(), { settingService });
        const database = new PouchDB<EntryDoc>(`unicode-paths-${++nextDatabase}`, { adapter: "memory" });
        databases.push(database);
        const metadata = {
            _id: await sender.path2id(path as FilePathWithPrefix),
            path: path as FilePathWithPrefix,
            type: "plain" as const,
            ctime: 1_000,
            mtime: 2_000,
            size: 0,
            children: [],
        };
        await database.put(metadata);
        const received = await database.get(metadata._id);
        const storagePath = receiver.getPath(received);

        expect(storagePath).toBe(path.normalize("NFC"));
        expect(received.path).toBe(path);
        const found = await getDBEntryMetaByPath(
            { services: { path: receiver, setting: settingService }, serviceModules: {} },
            { localDatabase: database },
            storagePath
        );

        expect(found).toMatchObject({ _id: metadata._id, path: storagePath, size: 0, children: [] });
    });
});

describe("legacy Unicode path identity", () => {
    it("keeps decomposed and composed paths distinct at version zero", async () => {
        const path = "Cafe\u0301/re\u0301sume\u0301.md";
        const settings = {
            ...DEFAULT_SETTINGS,
            encrypt: false,
            usePathObfuscation: false,
            handleFilenameCaseSensitive: false,
            pathNormalizationVersion: 0,
        };
        const settingService = { currentSettings: () => settings } as ISettingService;
        const sender = new PathServiceCompat(new ServiceContext(), { settingService });
        const receiver = new NFCPathService(new ServiceContext(), { settingService });
        const database = new PouchDB<EntryDoc>(`unicode-paths-legacy-${++nextDatabase}`, { adapter: "memory" });
        databases.push(database);
        const metadata = {
            _id: await sender.path2id(path as FilePathWithPrefix),
            path: path as FilePathWithPrefix,
            type: "plain" as const,
            ctime: 1_000,
            mtime: 2_000,
            size: 0,
            children: [],
        };
        await database.put(metadata);
        const received = await database.get(metadata._id);
        const storagePath = receiver.getPath(received);

        expect(storagePath).toBe(path.normalize("NFC"));
        expect(received.path).toBe(path);
        expect(await receiver.path2id(storagePath)).not.toBe(metadata._id);
        await expect(
            getDBEntryMetaByPath(
                { services: { path: receiver, setting: settingService }, serviceModules: {} },
                { localDatabase: database },
                storagePath
            )
        ).resolves.toBe(false);
    });
});
