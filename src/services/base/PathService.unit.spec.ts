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
