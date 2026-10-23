import { describe, expect, it, vi } from "vitest";
import { DEVICE_ID_PREFERRED, EntryTypes, MILESTONE_DOCID, type EntryMilestoneInfo } from "@lib/common/types.ts";
import { forgetJoinedDevice, projectJoinedDevices, type JoinedDevicesStore } from "@lib/replication/joinedDevices.ts";

function milestone(overrides: Record<string, unknown> = {}): EntryMilestoneInfo {
    return {
        _id: MILESTONE_DOCID,
        type: EntryTypes.MILESTONE_INFO,
        created: 1,
        accepted_nodes: [],
        node_info: {},
        locked: false,
        node_chunk_info: {},
        tweak_values: {},
        ...overrides,
    } as unknown as EntryMilestoneInfo;
}

function storeFor(read: JoinedDevicesStore["read"], write: JoinedDevicesStore["write"]): JoinedDevicesStore {
    return { read, write };
}

describe("projectJoinedDevices", () => {
    it("unions and sorts device IDs while returning only safe display fields", () => {
        const source = {
            ...milestone(),
            accepted_nodes: ["accepted-only", "shared", DEVICE_ID_PREFERRED],
            node_info: {
                nodeOnly: {
                    device_name: "private device name",
                    vault_name: "private vault name",
                    app_version: "1.2.3",
                    plugin_version: "4.5.6",
                    platform: "desktop",
                    progress: "private progress",
                    last_connected: 15,
                },
                shared: {
                    device_name: "another private name",
                    vault_name: "private vault name",
                    app_version: "2.0",
                    plugin_version: "5.0",
                    progress: "private progress",
                    last_connected: 0,
                },
                legacy: {},
                invalidTime: { platform: 42, app_version: false, plugin_version: null, last_connected: -1 },
                nonFiniteTime: { last_connected: Number.POSITIVE_INFINITY },
            },
            node_chunk_info: { chunkOnly: { min: 0, max: 0, current: 0 }, shared: {} },
            tweak_values: {
                tweakOnly: { passphrase: "private tweak value" },
                [DEVICE_ID_PREFERRED]: { passphrase: "preferred secret" },
            },
        } as unknown as EntryMilestoneInfo;

        const snapshot = projectJoinedDevices(source);

        expect(snapshot).toEqual({
            milestonePresent: true,
            locked: false,
            cleaned: false,
            devices: [
                { id: "accepted-only", accepted: true },
                { id: "chunkOnly", accepted: false },
                { id: "invalidTime", accepted: false },
                { id: "legacy", accepted: false },
                {
                    id: "nodeOnly",
                    accepted: false,
                    platform: "desktop",
                    pluginVersion: "4.5.6",
                    appVersion: "1.2.3",
                    lastConnected: 15,
                },
                { id: "nonFiniteTime", accepted: false },
                { id: "shared", accepted: true, pluginVersion: "5.0", appVersion: "2.0", lastConnected: 0 },
                { id: "tweakOnly", accepted: false },
            ],
        });
        expect(JSON.stringify(snapshot)).not.toContain("private device name");
        expect(JSON.stringify(snapshot)).not.toContain("private tweak value");
        expect(JSON.stringify(snapshot)).not.toContain("preferred secret");
    });

    it("handles missing legacy fields and absent milestones", () => {
        const legacy = { locked: true, node_info: { oldNode: {} } } as unknown as EntryMilestoneInfo;

        expect(projectJoinedDevices(legacy)).toEqual({
            milestonePresent: true,
            locked: true,
            cleaned: false,
            devices: [{ id: "oldNode", accepted: false }],
        });
        expect(projectJoinedDevices(undefined)).toEqual({
            milestonePresent: false,
            locked: false,
            cleaned: false,
            devices: [],
        });
    });
});

describe("forgetJoinedDevice", () => {
    it("removes only the requested device from each collection and preserves other milestone data", async () => {
        const original = {
            ...milestone({
                accepted_nodes: ["target", "keep", "target"],
                node_info: {
                    target: { device_name: "target device" },
                    keep: { device_name: "kept device" },
                },
                node_chunk_info: { target: { min: 1 }, keep: { min: 2 } },
                tweak_values: {
                    target: { usePathObfuscation: true },
                    keep: { usePathObfuscation: false },
                    [DEVICE_ID_PREFERRED]: { usePathObfuscation: false },
                },
                locked: true,
                cleaned: true,
            }),
            unknownField: { retained: true },
        } as EntryMilestoneInfo;
        const write = vi.fn<JoinedDevicesStore["write"]>(async () => "updated");
        const store = storeFor(
            vi.fn<JoinedDevicesStore["read"]>(async () => ({ milestone: original, revision: "rev-1" })),
            write
        );

        await expect(forgetJoinedDevice(store, "target", "own")).resolves.toBe("forgotten");

        expect(write).toHaveBeenCalledOnce();
        const [updated, revision] = write.mock.calls[0];
        expect(revision).toBe("rev-1");
        expect(updated.accepted_nodes).toEqual(["keep"]);
        expect(updated.node_info).toEqual({ keep: { device_name: "kept device" } });
        expect(updated.node_chunk_info).toEqual({ keep: { min: 2 } });
        expect(updated.tweak_values).toEqual({
            keep: { usePathObfuscation: false },
            [DEVICE_ID_PREFERRED]: { usePathObfuscation: false },
        });
        expect(updated.locked).toBe(true);
        expect(updated.cleaned).toBe(true);
        expect((updated as EntryMilestoneInfo & { unknownField?: unknown }).unknownField).toBe(
            (original as EntryMilestoneInfo & { unknownField?: unknown }).unknownField
        );
        expect(original.accepted_nodes).toEqual(["target", "keep", "target"]);
        expect(original.node_info).toHaveProperty("target");
    });

    it("reads again after a conflict and includes a concurrent change to another device", async () => {
        const first = milestone({
            accepted_nodes: ["target"],
            node_info: { target: { device_name: "target" } },
            node_chunk_info: { target: { min: 1 } },
            tweak_values: { [DEVICE_ID_PREFERRED]: {} },
        });
        const concurrent = milestone({
            accepted_nodes: ["target", "other"],
            node_info: { target: { device_name: "target" }, other: { device_name: "other" } },
            node_chunk_info: { target: { min: 1 }, other: { min: 2 } },
            tweak_values: { [DEVICE_ID_PREFERRED]: {}, other: { usePathObfuscation: true } },
            unknownConcurrentField: "preserve me",
        });
        const read = vi
            .fn<JoinedDevicesStore["read"]>()
            .mockResolvedValueOnce({ milestone: first, revision: "rev-1" })
            .mockResolvedValueOnce({ milestone: concurrent, revision: "rev-2" });
        const write = vi
            .fn<JoinedDevicesStore["write"]>()
            .mockResolvedValueOnce("conflict")
            .mockResolvedValueOnce("updated");

        await expect(forgetJoinedDevice(storeFor(read, write), "target", "own")).resolves.toBe("forgotten");

        expect(read).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[0][1]).toBe("rev-1");
        expect(write.mock.calls[1][1]).toBe("rev-2");
        expect(write.mock.calls[1][0].accepted_nodes).toEqual(["other"]);
        expect(write.mock.calls[1][0].node_info).toEqual({ other: { device_name: "other" } });
        expect(
            (write.mock.calls[1][0] as EntryMilestoneInfo & { unknownConcurrentField?: unknown }).unknownConcurrentField
        ).toBe("preserve me");
    });

    it("returns conflict after three conflict retries", async () => {
        const current = milestone({
            accepted_nodes: ["target"],
            node_info: { target: { device_name: "target" } },
        });
        const read = vi.fn<JoinedDevicesStore["read"]>(async () => ({ milestone: current, revision: "rev" }));
        const write = vi.fn<JoinedDevicesStore["write"]>(async () => "conflict");

        await expect(forgetJoinedDevice(storeFor(read, write), "target", "own")).resolves.toBe("conflict");

        expect(read).toHaveBeenCalledTimes(4);
        expect(write).toHaveBeenCalledTimes(4);
    });

    it("returns unsupported when the revision is missing without writing", async () => {
        const milestoneValue = milestone({ accepted_nodes: ["target"] });
        const read = vi.fn<JoinedDevicesStore["read"]>(async () => ({ milestone: milestoneValue }));
        const write = vi.fn<JoinedDevicesStore["write"]>();

        await expect(forgetJoinedDevice(storeFor(read, write), "target", "own")).resolves.toBe("unsupported");
        expect(write).not.toHaveBeenCalled();
    });

    it("returns unsupported when the store does not support writes", async () => {
        const current = milestone({ accepted_nodes: ["target"] });
        const write = vi.fn<JoinedDevicesStore["write"]>(async () => "unsupported");
        const store = storeFor(
            vi.fn<JoinedDevicesStore["read"]>(async () => ({ milestone: current, revision: "rev-1" })),
            write
        );

        await expect(forgetJoinedDevice(store, "target", "own")).resolves.toBe("unsupported");
        expect(write).toHaveBeenCalledOnce();
    });

    it("returns not-found without writing when the milestone or device is missing", async () => {
        const read = vi.fn<JoinedDevicesStore["read"]>().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
            milestone: milestone(),
            revision: "rev-1",
        });
        const write = vi.fn<JoinedDevicesStore["write"]>();
        const store = storeFor(read, write);

        await expect(forgetJoinedDevice(store, "target", "own")).resolves.toBe("not-found");
        await expect(forgetJoinedDevice(store, "missing", "own")).resolves.toBe("not-found");
        expect(write).not.toHaveBeenCalled();
    });

    it.each([
        ["empty device ID", "", "own"],
        ["preferred device ID", DEVICE_ID_PREFERRED, "own"],
        ["own device ID", "own", "own"],
        ["empty own device ID", "target", ""],
    ])("rejects %s before reading", async (_caseName, deviceId, ownDeviceId) => {
        const read = vi.fn<JoinedDevicesStore["read"]>();
        const write = vi.fn<JoinedDevicesStore["write"]>();

        await expect(forgetJoinedDevice(storeFor(read, write), deviceId, ownDeviceId)).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it("propagates store failures", async () => {
        const failure = new Error("store unavailable");
        const store = storeFor(
            vi.fn<JoinedDevicesStore["read"]>(async () => {
                throw failure;
            }),
            vi.fn<JoinedDevicesStore["write"]>()
        );

        await expect(forgetJoinedDevice(store, "target", "own")).rejects.toBe(failure);
    });
});
