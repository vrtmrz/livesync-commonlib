import { describe, expect, it, vi } from "vitest";
import type {
    DeviceInfo,
    EntryMilestoneInfo,
    RemoteDBSettings,
    TweakValues,
} from "@lib/common/types.ts";
import { DEVICE_ID_PREFERRED, E2EEAlgorithms, MILESTONE_DOCID, REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/types.ts";
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
    it.each([false, true])(
        "rejects document ID modes separately from ordinary tweaks (checks disabled: %s)",
        async (disableCheckingConfigMismatch) => {
            const remote = milestone({ encrypt: true, usePathObfuscation: true, idDerivationVersion: 1 });
            const before = structuredClone(remote);
            const update = vi.fn(async () => {});
            const result = await ensureRemoteIsCompatible(
                remote,
                {
                    encrypt: true,
                    usePathObfuscation: true,
                    idDerivationVersion: 0,
                    disableCheckingConfigMismatch,
                } as RemoteDBSettings,
                "new-node",
                VERSION_RANGE,
                DEVICE_INFO,
                update
            );

            expect(result).toBe("ID_KEY_MISMATCH");
            expect(update).not.toHaveBeenCalled();
            expect(remote).toEqual(before);
        }
    );

    it.each([
        [REMOTE_COUCHDB, false],
        [REMOTE_MINIO, true],
    ])("does not advertise inactive internal Metadata encryption for %s", async (remoteType, encrypt) => {
        const recordAssessment = vi.fn();
        const result = await ensureRemoteIsCompatible(
            milestone({ encryptInternalMetadata: false }),
            {
                remoteType,
                encrypt,
                usePathObfuscation: false,
                E2EEAlgorithm: E2EEAlgorithms.V2,
                encryptInternalMetadata: true,
            } as RemoteDBSettings,
            "local",
            VERSION_RANGE,
            DEVICE_INFO,
            vi.fn(async () => {}),
            recordAssessment
        );

        expect(result).toBe("OK");
        expect(recordAssessment.mock.calls[0][0].currentValues.encryptInternalMetadata).toBe(false);
    });

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

    it("does not update the milestone when the preferred configuration rejects admission", async () => {
        const remote = milestone({ handleFilenameCaseSensitive: false });
        const update = vi.fn(async () => {});

        await expect(
            ensureRemoteIsCompatible(
                remote,
                { handleFilenameCaseSensitive: true } as RemoteDBSettings,
                "new-node",
                VERSION_RANGE,
                DEVICE_INFO,
                update
            )
        ).resolves.toEqual(["MISMATCHED", remote.tweak_values[DEVICE_ID_PREFERRED]]);
        expect(update).not.toHaveBeenCalled();
    });

    it("admits a different Chunk ID mode when both sides keep document paths visible", async () => {
        const remote = milestone({ encrypt: true, usePathObfuscation: false, idDerivationVersion: 0 });

        await expect(
            ensureRemoteIsCompatible(
                remote,
                {
                    encrypt: true,
                    usePathObfuscation: false,
                    idDerivationVersion: 1,
                    idDerivationKey: "ab".repeat(32),
                } as RemoteDBSettings,
                "new-node",
                VERSION_RANGE,
                DEVICE_INFO,
                vi.fn(async () => {})
            )
        ).resolves.toBe("OK");
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
