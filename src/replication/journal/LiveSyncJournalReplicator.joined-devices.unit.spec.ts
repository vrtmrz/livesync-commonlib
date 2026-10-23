import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_SETTINGS,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    type DeviceInfo,
    type EntryMilestoneInfo,
} from "@lib/common/types.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

const DEVICE_INFO: DeviceInfo = {
    app_version: "app",
    plugin_version: "plugin",
    vault_name: "vault",
    device_name: "device",
    progress: "",
};

function createMilestone(): EntryMilestoneInfo {
    return {
        _id: MILESTONE_DOCID,
        type: "milestoneinfo",
        created: 1,
        locked: false,
        accepted_nodes: ["own-device", "old-device"],
        node_chunk_info: {
            "own-device": { min: 0, max: 2, current: 2 },
            "old-device": { min: 0, max: 2, current: 2 },
        },
        node_info: {
            "own-device": { ...DEVICE_INFO, last_connected: 1 },
            "old-device": { ...DEVICE_INFO, last_connected: 2, platform: "linux" },
        },
        tweak_values: {
            "own-device": {},
            "old-device": {},
        },
    };
}

function createReplicator(nodeId = "own-device") {
    const localDB = {
        get: vi.fn(async () => ({ _id: NODEINFO_DOCID, type: "nodeinfo", nodeid: nodeId })),
    };
    const replicator = new LiveSyncJournalReplicator({
        services: {
            API: {
                getAppVersion: () => "app",
                getPluginVersion: () => "plugin",
                getPlatform: () => "test-platform",
            },
            database: { localDatabase: { localDatabase: localDB } },
            keyValueDB: { simpleStore: {} },
            replication: { parseSynchroniseResult: vi.fn() },
        },
    } as never);
    const setting = { ...DEFAULT_SETTINGS, pathNormalizationVersion: 0 };

    return { localDB, replicator, setting };
}

describe("LiveSyncJournalReplicator joined devices", () => {
    it("projects a remote milestone from a disposed trial client", async () => {
        const milestone = createMilestone();
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue({
            status: "available",
            value: milestone,
            revision: '"etag-1"',
        } as never);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { replicator, setting } = createReplicator();

        await expect(replicator.getJoinedDevices(setting)).resolves.toMatchObject({
            milestonePresent: true,
            devices: expect.arrayContaining([
                expect.objectContaining({ id: "old-device", accepted: true, platform: "linux" }),
            ]),
        });
        expect(download).toHaveBeenCalledWith("_00000000-milestone.json");
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("treats only NOT_FOUND as a missing Journal milestone", async () => {
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue({
            status: "not-found",
        } as never);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { replicator, setting } = createReplicator();

        await expect(replicator.getJoinedDevices(setting)).resolves.toEqual({
            milestonePresent: false,
            locked: false,
            cleaned: false,
            devices: [],
        });
        expect(download).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("propagates unavailable Journal reads and disposes the trial client", async () => {
        const failure = new Error("remote read failed");
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue({
            status: "unavailable",
            error: failure,
        } as never);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { replicator, setting } = createReplicator();

        await expect(replicator.getJoinedDevices(setting)).rejects.toBe(failure);
        expect(download).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("forgets a remote device using the read ETag and conditional JSON write", async () => {
        const milestone = createMilestone();
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue({
            status: "available",
            value: milestone,
            revision: '"etag-1"',
        } as never);
        const conditionalWrite = vi
            .spyOn(JournalSyncCore.prototype, "uploadJsonIfUnchanged")
            .mockResolvedValue("updated");
        const unconditionalWrite = vi.spyOn(JournalSyncCore.prototype, "uploadJson").mockResolvedValue(true);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { localDB, replicator, setting } = createReplicator();

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).resolves.toBe("forgotten");

        expect(localDB.get).toHaveBeenCalledWith(NODEINFO_DOCID);
        expect(download).toHaveBeenCalledOnce();
        expect(conditionalWrite).toHaveBeenCalledOnce();
        expect(conditionalWrite.mock.calls[0][0]).toBe("_00000000-milestone.json");
        expect(conditionalWrite.mock.calls[0][1]).toMatchObject({
            accepted_nodes: ["own-device"],
            node_info: { "own-device": expect.any(Object) },
        });
        expect(conditionalWrite.mock.calls[0][2]).toBe('"etag-1"');
        expect(unconditionalWrite).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("returns conflict after conditional writes conflict and never uses an unconditional write", async () => {
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue({
            status: "available",
            value: createMilestone(),
            revision: '"etag-1"',
        } as never);
        const conditionalWrite = vi
            .spyOn(JournalSyncCore.prototype, "uploadJsonIfUnchanged")
            .mockResolvedValue("conflict");
        const unconditionalWrite = vi.spyOn(JournalSyncCore.prototype, "uploadJson").mockResolvedValue(true);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { replicator, setting } = createReplicator();

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).resolves.toBe("conflict");

        expect(download).toHaveBeenCalledTimes(4);
        expect(conditionalWrite).toHaveBeenCalledTimes(4);
        expect(unconditionalWrite).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("rejects forgetting when the local node identity is unavailable", async () => {
        const download = vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult");
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose").mockImplementation(() => {});
        const { localDB, replicator, setting } = createReplicator("");

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).rejects.toThrow(
            "The local node identity is unavailable."
        );
        expect(localDB.get).toHaveBeenCalledWith(NODEINFO_DOCID);
        expect(download).not.toHaveBeenCalled();
        expect(dispose).not.toHaveBeenCalled();
    });
});
