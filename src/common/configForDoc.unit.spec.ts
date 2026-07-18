import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./types";
import { performDoctorConsultation, RebuildOptions } from "./configForDoc";

describe("Doctor translation boundary", () => {
    it("uses the translator supplied by the host", async () => {
        const translate = vi.fn((key: string) => `translated:${key}`);
        const settings = {
            ...DEFAULT_SETTINGS,
            customChunkSize: 60,
            handleFilenameCaseSensitive: false,
            usePluginSyncV2: true,
        };

        const result = await performDoctorConsultation(
            {
                confirm: {} as never,
                translate,
            },
            settings,
            {
                localRebuild: RebuildOptions.ConfirmIfRequired,
                remoteRebuild: RebuildOptions.ConfirmIfRequired,
                forceRescan: true,
            }
        );

        expect(result.isModified).toBe(false);
        expect(translate).toHaveBeenCalledWith("Doctor.Message.NoIssues");
    });
});
