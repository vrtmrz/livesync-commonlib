import { describe, expect, it, vi } from "vitest";
import type PouchDBType from "pouchdb-core";
import type { EntryDoc, FilePathWithPrefix, RemoteDBSettings } from "@lib/common/types.ts";
import { path2id_base } from "@lib/string_and_binary/path.ts";
import { E2EEAlgorithms } from "@lib/common/types.ts";
import { PouchDB } from "./pouchdb-test.ts";
import { enableEncryption } from "./encryption.ts";
import { assessRemoteDocumentIds as assessRemoteDocumentIdsWithPathService } from "./remoteIdCompatibility.ts";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService.ts";
import { ServiceContext } from "@lib/services/base/ServiceBase.ts";
import type { ISettingService } from "@lib/services/base/IService.ts";

const key = "ab".repeat(32);
const baseSetting = {
    encrypt: true,
    idDerivationVersion: 1,
    idDerivationKey: key,
    usePathObfuscation: true,
    passphrase: "content-passphrase",
    handleFilenameCaseSensitive: false,
} as RemoteDBSettings;

function assessRemoteDocumentIds(db: PouchDBType.Database<EntryDoc>, setting: RemoteDBSettings) {
    const pathService = new PathServiceCompat(new ServiceContext(), {
        settingService: { currentSettings: () => setting } as ISettingService,
    });
    return assessRemoteDocumentIdsWithPathService(db, setting, (path) =>
        pathService.path2idWithSettings(path, setting)
    );
}

function mockDatabase(id?: string) {
    return {
        allDocs: vi.fn().mockImplementation(async () => ({ rows: id ? [{ id }] : [] })),
        get: vi.fn().mockImplementation(async () => ({ _id: id, type: "plain", path: "Notes/One.md" })),
    } as unknown as PouchDBType.Database<EntryDoc>;
}

describe("remote document ID agreement", () => {
    it("accepts a legacy document when the configured ID generation is also legacy", async () => {
        const setting = { ...baseSetting, idDerivationVersion: 0 as const, idDerivationKey: "" };
        const id = await path2id_base("Notes/One.md" as FilePathWithPrefix, setting.passphrase, true);
        expect(await assessRemoteDocumentIds(mockDatabase(id), setting)).toBe("matching");
    });

    it("accepts an existing document derived with the configured key", async () => {
        const id = await path2id_base("Notes/One.md" as FilePathWithPrefix, baseSetting.passphrase, true, key);
        const db = mockDatabase(id);
        expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("matching");
        expect(db.get).toHaveBeenCalledWith(id);
    });

    it("rejects a document derived with a different key", async () => {
        const id = await path2id_base(
            "Notes/One.md" as FilePathWithPrefix,
            baseSetting.passphrase,
            true,
            "cd".repeat(32)
        );
        const db = mockDatabase(id);
        expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("mismatched");
    });

    it("accepts a stored path that is normalised by the path service before ID generation", async () => {
        const canonical = "Notes/Draft/One.md" as FilePathWithPrefix;
        const id = await path2id_base(canonical, baseSetting.passphrase, true, key);
        const db = {
            allDocs: vi.fn().mockResolvedValue({ rows: [{ id }] }),
            get: vi.fn().mockResolvedValue({ _id: id, type: "plain", path: "Notes\\Draft//One.md" }),
        } as unknown as PouchDBType.Database<EntryDoc>;
        expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("matching");
    });

    it("skips keyed document verification while E2EE is off", async () => {
        const id = await path2id_base("Notes/One.md" as FilePathWithPrefix, baseSetting.passphrase, true, key);
        expect(await assessRemoteDocumentIds(mockDatabase(id), { ...baseSetting, encrypt: false })).toBe("unverified");
    });

    it("rejects mixed document identities even after a matching sample", async () => {
        const matching = await path2id_base("Notes/One.md" as FilePathWithPrefix, baseSetting.passphrase, true, key);
        const mismatching = await path2id_base(
            "Notes/One.md" as FilePathWithPrefix,
            baseSetting.passphrase,
            true,
            "cd".repeat(32)
        );
        const db = {
            allDocs: vi.fn().mockResolvedValue({ rows: [{ id: matching }, { id: mismatching }] }),
            get: vi.fn().mockImplementation(async (id: string) => ({ _id: id, type: "plain", path: "Notes/One.md" })),
        } as unknown as PouchDBType.Database<EntryDoc>;
        expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("mismatched");
    });

    it("reports an empty remote database as unverified", async () => {
        expect(await assessRemoteDocumentIds(mockDatabase(), baseSetting)).toBe("unverified");
    });

    it("can verify an internal Metadata document when ordinary files are absent", async () => {
        const path = "i:config.json" as FilePathWithPrefix;
        const id = await path2id_base(path, baseSetting.passphrase, true, key);
        const db = {
            allDocs: vi.fn().mockImplementation(async ({ startkey }: { startkey: string }) => ({
                rows: startkey === "i:f:" ? [{ id }] : [],
            })),
            get: vi.fn().mockResolvedValue({ _id: id, type: "plain", path }),
        } as unknown as PouchDBType.Database<EntryDoc>;
        expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("matching");
    });

    it("checks the decrypted path through a real encrypted PouchDB handle", async () => {
        const db = new PouchDB<EntryDoc>(`id-compatibility-${crypto.randomUUID()}`, { adapter: "memory" });
        try {
            enableEncryption(db, baseSetting.passphrase, false, false, async () => new Uint8Array(16), E2EEAlgorithms.V2);
            const path = "Notes/One.md" as FilePathWithPrefix;
            const id = await path2id_base(path, baseSetting.passphrase, true, key);
            await db.put({
                _id: id,
                type: "plain",
                path,
                ctime: 1,
                mtime: 1,
                size: 0,
                children: [],
                eden: {},
            });
            expect(await assessRemoteDocumentIds(db, baseSetting)).toBe("matching");
            expect(await assessRemoteDocumentIds(db, { ...baseSetting, idDerivationKey: "cd".repeat(32) })).toBe(
                "mismatched"
            );
        } finally {
            await db.destroy();
        }
    });
});
