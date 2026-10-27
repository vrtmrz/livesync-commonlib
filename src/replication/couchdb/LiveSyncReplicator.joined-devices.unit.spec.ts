import { describe, expect, it, vi } from "vitest";

import {
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    type DeviceInfo,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";

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
        _rev: "1-milestone",
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

function createReplicator(
    remoteDB: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> },
    nodeInfo: unknown = { _id: NODEINFO_DOCID, type: "nodeinfo", nodeid: "own-device" }
) {
    const localDB = { get: vi.fn(async () => nodeInfo) };
    const close = vi.fn(async () => {});
    const setting = {} as RemoteDBSettings;
    const replicator = new LiveSyncCouchDBReplicator({
        services: {
            API: { isMobile: () => false },
            database: { localDatabase: { localDatabase: localDB } },
        },
    } as never);
    const connect = vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
        db: remoteDB,
        info: {},
        close,
    } as never);
    return { close, connect, localDB, replicator, setting };
}

describe("LiveSyncCouchDBReplicator joined devices", () => {
    it("projects the remote milestone and closes the trial connection", async () => {
        const remoteDB = {
            get: vi.fn(async () => createMilestone()),
            put: vi.fn(),
        };
        const { close, connect, replicator, setting } = createReplicator(remoteDB);

        const snapshot = await replicator.getJoinedDevices(setting);

        expect(snapshot).toMatchObject({
            milestonePresent: true,
            devices: [
                expect.objectContaining({ id: "old-device", accepted: true, platform: "linux" }),
                expect.objectContaining({ id: "own-device", accepted: true }),
            ],
        });
        expect(connect).toHaveBeenCalledWith(setting, false, false);
        expect(remoteDB.get).toHaveBeenCalledWith(MILESTONE_DOCID);
        expect(close).toHaveBeenCalledOnce();
    });

    it("treats only a 404 milestone read as missing", async () => {
        const missing = { status: 404 };
        const remoteDB = {
            get: vi.fn(async () => {
                throw missing;
            }),
            put: vi.fn(),
        };
        const { close, replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.getJoinedDevices(setting)).resolves.toEqual({
            milestonePresent: false,
            locked: false,
            cleaned: false,
            devices: [],
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it("propagates non-404 milestone read errors", async () => {
        const failure = { status: 500, message: "server failed" };
        const remoteDB = {
            get: vi.fn(async () => {
                throw failure;
            }),
            put: vi.fn(),
        };
        const { close, replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.getJoinedDevices(setting)).rejects.toBe(failure);
        expect(close).toHaveBeenCalledOnce();
    });

    it("reports a generic connection error without exposing the connection string", async () => {
        const remoteDB = { get: vi.fn(), put: vi.fn() };
        const { connect, replicator, setting } = createReplicator(remoteDB);
        connect.mockResolvedValue("https://secret.example.test/user:password" as never);

        const error = await replicator.getJoinedDevices(setting).catch((ex: unknown) => ex);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Could not connect to remote CouchDB for joined-device management.");
        expect((error as Error).message).not.toContain("secret.example.test");
    });

    it("forgets a remote device using the milestone revision", async () => {
        const milestone = createMilestone();
        const remoteDB = {
            get: vi.fn(async () => milestone),
            put: vi.fn(async (written: EntryMilestoneInfo) => {
                Object.assign(milestone, written);
                return { ok: true };
            }),
        };
        const { close, connect, localDB, replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).resolves.toBe("forgotten");

        expect(connect).toHaveBeenCalledWith(setting, false, false);
        expect(localDB.get).toHaveBeenCalledWith(NODEINFO_DOCID);
        expect(remoteDB.put).toHaveBeenCalledOnce();
        const written = remoteDB.put.mock.calls[0][0] as EntryMilestoneInfo;
        expect(written._rev).toBe("1-milestone");
        expect(written.accepted_nodes).toEqual(["own-device"]);
        expect(written.node_info).not.toHaveProperty("old-device");
        expect(close).toHaveBeenCalledOnce();
    });

    it("reports failure when a successful write still has the device on readback", async () => {
        const milestone = createMilestone();
        const remoteDB = {
            get: vi.fn().mockResolvedValueOnce(milestone).mockResolvedValueOnce(milestone),
            put: vi.fn(async () => ({ ok: true })),
        };
        const { close, replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).rejects.toThrow(
            "Could not verify joined-device removal."
        );

        expect(remoteDB.put).toHaveBeenCalledOnce();
        expect(remoteDB.get).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledOnce();
    });

    it("rejects forgetting when the local node identity is unavailable", async () => {
        const remoteDB = { get: vi.fn(), put: vi.fn() };
        const { connect, localDB, replicator, setting } = createReplicator(remoteDB, { nodeid: "" });

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).rejects.toThrow(
            "The local node identity is unavailable."
        );
        expect(localDB.get).toHaveBeenCalledWith(NODEINFO_DOCID);
        expect(connect).not.toHaveBeenCalled();
    });

    it("maps only repeated HTTP 409 writes to a conflict result", async () => {
        const conflict = { status: 409 };
        const remoteDB = {
            get: vi.fn(async () => createMilestone()),
            put: vi.fn(async () => {
                throw conflict;
            }),
        };
        const { close, replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).resolves.toBe("conflict");
        expect(remoteDB.put).toHaveBeenCalledTimes(4);
        expect(close).toHaveBeenCalledOnce();
    });

    it("propagates non-conflict write errors", async () => {
        const failure = { status: 500, message: "write failed" };
        const remoteDB = {
            get: vi.fn(async () => createMilestone()),
            put: vi.fn(async () => {
                throw failure;
            }),
        };
        const { replicator, setting } = createReplicator(remoteDB);

        await expect(replicator.forgetJoinedDevice(setting, "old-device")).rejects.toBe(failure);
        expect(remoteDB.put).toHaveBeenCalledOnce();
    });
});
