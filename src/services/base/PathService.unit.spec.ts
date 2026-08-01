import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type FilePath, type ObsidianLiveSyncSettings } from "@lib/common/types.ts";
import { path2id_base } from "@lib/string_and_binary/path.ts";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService.ts";
import type { ISettingService } from "./IService.ts";
import { ServiceContext } from "./ServiceBase.ts";

describe("PathService", () => {
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

        await expect(defaultService.path2id(path)).resolves.toBe(
            await path2id_base(path, "content-secret", false)
        );
        await expect(hostService.path2id(path)).resolves.toBe(await path2id_base(path, "path-secret", false));
    });
});
