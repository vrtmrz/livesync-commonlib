import { describe, expect, it } from "vitest";

import {
    DEFAULT_SETTINGS,
    type DocumentID,
    type FilePath,
    type FilePathWithPrefix,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types.ts";
import { path2id_base } from "@lib/string_and_binary/path.ts";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService.ts";
import type { ISettingService } from "./IService.ts";
import { ServiceContext } from "./ServiceBase.ts";

describe("PathService", () => {
    it("keeps obfuscated Metadata IDs stable after an E2EE passphrase change", async () => {
        const settings: ObsidianLiveSyncSettings = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "first E2EE passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "f3205cc41d24116d8c2484993c9d9a2e667373af338ba02f2ee71199adb82f2e",
        };
        const settingService = { currentSettings: () => settings } as unknown as ISettingService;
        const service = new PathServiceCompat(new ServiceContext(), { settingService });
        const first = await service.path2id("i:Folder/Note.md" as FilePathWithPrefix);
        settings.passphrase = "second E2EE passphrase";
        expect(await service.path2id("i:Folder/Note.md" as FilePathWithPrefix)).toBe(first);
        expect(first).toMatch(/^i:f:[0-9a-f]{64}$/u);
    });

    it("uses legacy document IDs while E2EE is off without discarding the saved ID key", async () => {
        const settings: ObsidianLiveSyncSettings = {
            ...DEFAULT_SETTINGS,
            encrypt: false,
            passphrase: "legacy path passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        };
        const service = new PathServiceCompat(new ServiceContext(), {
            settingService: { currentSettings: () => settings } as ISettingService,
        });
        const path = "Notes/One.md" as FilePathWithPrefix;

        expect(await service.path2id(path)).toBe(await path2id_base(path, settings.passphrase, true));
        settings.encrypt = true;
        expect(await service.path2id(path)).not.toBe(await path2id_base(path, settings.passphrase, true));
        settings.encrypt = false;
        expect(await service.path2id(path)).toBe(await path2id_base(path, settings.passphrase, true));
        expect(settings.idDerivationKey).toBe("ab".repeat(32));
    });

    it.each(["", "i:", "ix:"])("normalises the whole path after the %s namespace", async (prefix) => {
        const settingService = {
            currentSettings: () => ({ ...DEFAULT_SETTINGS, handleFilenameCaseSensitive: true }),
        } as unknown as ISettingService;
        const service = new PathServiceCompat(new ServiceContext(), { settingService });
        const input = `${prefix}Folder//Poem: Example.md` as FilePathWithPrefix;
        const expected = `${prefix}Folder/Poem: Example.md`;
        await expect(service.path2id(input)).resolves.toBe(expected);
        expect(service.id2path(input as DocumentID)).toBe(expected);
    });

    it("uses an optional host path-obfuscation passphrase without changing the settings default", async () => {
        const settings: ObsidianLiveSyncSettings = {
            ...DEFAULT_SETTINGS,
            usePathObfuscation: true,
            passphrase: "content-secret",
            handleFilenameCaseSensitive: true,
        };
        const settingService = {
            currentSettings: () => settings,
        } as unknown as ISettingService;
        const path = "note.md" as FilePath;
        const defaultService = new PathServiceCompat(new ServiceContext(), { settingService });
        const hostService = new PathServiceCompat(new ServiceContext(), {
            settingService,
            getPathObfuscationPassphrase: () => "path-secret",
        });

        await expect(defaultService.path2id(path)).resolves.toBe(await path2id_base(path, "content-secret", false));
        await expect(hostService.path2id(path)).resolves.toBe(await path2id_base(path, "path-secret", false));
    });
});
