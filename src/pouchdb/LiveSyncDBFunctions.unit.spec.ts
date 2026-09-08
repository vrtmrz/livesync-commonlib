import { describe, expect, it, vi } from "vitest";
import type {
    DeviceInfo,
    EntryMilestoneInfo,
    RemoteDBSettings,
    TweakValues,
} from "@lib/common/types.ts";
import { DEVICE_ID_PREFERRED, MILESTONE_DOCID } from "@lib/common/types.ts";
import { ensureRemoteIsCompatible } from "./LiveSyncDBFunctions.ts";

const VERSION_RANGE = { min: 0, max: 2 } as const;
const DEVICE_INFO: DeviceInfo = {
    app_version: "test",
    plugin_version: "test",
    vault_name: "test",
    device_name: "test",
    progress: "",
};

function milestone(preferred: TweakValues): EntryMilestoneInfo {
    return {
        _id: MILESTONE_DOCID,
        _rev: "1-test",
        type: "milestoneinfo",
        created: 1,
        locked: false,
        accepted_nodes: ["local"],
        node_chunk_info: { local: { ...VERSION_RANGE } },
        node_info: {
            local: {
                ...DEVICE_INFO,
                last_connected: Date.now(),
            },
        },
        tweak_values: {
            [DEVICE_ID_PREFERRED]: preferred,
        },
    };
}

describe("ensureRemoteIsCompatible", () => {
    it("rejects an explicit case-sensitive setting when the preferred setting is missing", async () => {
        const preferred: TweakValues = {};
        const recordAssessment = vi.fn();

        const result = await ensureRemoteIsCompatible(
            milestone(preferred),
            { handleFilenameCaseSensitive: true } as RemoteDBSettings,
            "local",
            VERSION_RANGE,
            DEVICE_INFO,
            vi.fn(async () => {}),
            recordAssessment
        );

        expect(result).toEqual(["MISMATCHED", preferred]);
        expect(recordAssessment).toHaveBeenCalledOnce();
        expect(recordAssessment.mock.calls[0][0]).toMatchObject({
            alignment: "mismatched",
            currentValues: { handleFilenameCaseSensitive: true },
            preferredValues: {},
        });
    });

    it.each([
        [{ handleFilenameCaseSensitive: false }, {}],
        [{ customChunkSize: 0 }, {}],
    ] as const)("permits an equivalent or unadvertised partial value (%o)", async (current, preferred) => {
        await expect(
            ensureRemoteIsCompatible(
                milestone(preferred),
                current as RemoteDBSettings,
                "local",
                VERSION_RANGE,
                DEVICE_INFO,
                vi.fn(async () => {})
            )
        ).resolves.toBe("OK");
    });
});
