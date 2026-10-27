import { DEVICE_ID_PREFERRED, type EntryMilestoneInfo } from "@lib/common/types.ts";

export interface JoinedDevice {
    readonly id: string;
    readonly accepted: boolean;
    readonly platform?: string;
    readonly pluginVersion?: string;
    readonly appVersion?: string;
    readonly lastConnected?: number;
}

export interface JoinedDevicesSnapshot {
    readonly milestonePresent: boolean;
    readonly locked: boolean;
    readonly cleaned: boolean;
    readonly devices: readonly JoinedDevice[];
}

export function projectJoinedDevices(milestone: EntryMilestoneInfo | undefined): JoinedDevicesSnapshot {
    if (milestone === undefined) {
        return { milestonePresent: false, locked: false, cleaned: false, devices: [] };
    }

    const source = milestone as unknown as Record<string, unknown>;
    const nodeInfo = asRecord(source.node_info);
    const acceptedNodes = Array.isArray(source.accepted_nodes)
        ? source.accepted_nodes.filter((id): id is string => typeof id === "string")
        : [];
    const accepted = new Set(acceptedNodes);
    const ids = new Set<string>();

    for (const id of acceptedNodes) {
        if (id !== DEVICE_ID_PREFERRED) ids.add(id);
    }
    addRecordKeys(ids, source.node_info);
    addRecordKeys(ids, source.node_chunk_info);
    addRecordKeys(ids, source.tweak_values);

    const devices = [...ids]
        .filter((id) => id !== DEVICE_ID_PREFERRED)
        .sort()
        .map((id): JoinedDevice => {
            const nodeData = nodeInfo && hasOwn(nodeInfo, id) ? asRecord(nodeInfo[id]) : undefined;
            const platform = readString(nodeData, "platform");
            const pluginVersion = readString(nodeData, "plugin_version");
            const appVersion = readString(nodeData, "app_version");
            const lastConnected = readTimestamp(nodeData?.last_connected);

            return {
                id,
                accepted: accepted.has(id),
                ...(platform === undefined ? {} : { platform }),
                ...(pluginVersion === undefined ? {} : { pluginVersion }),
                ...(appVersion === undefined ? {} : { appVersion }),
                ...(lastConnected === undefined ? {} : { lastConnected }),
            };
        });

    return {
        milestonePresent: true,
        locked: source.locked === true,
        cleaned: source.cleaned === true,
        devices,
    };
}

export type ForgetJoinedDeviceResult = "forgotten" | "not-found" | "conflict" | "unsupported";

export interface JoinedDevicesStore {
    read(): Promise<{ milestone: EntryMilestoneInfo; revision?: string } | undefined>;
    write(milestone: EntryMilestoneInfo, revision: string): Promise<"updated" | "conflict" | "unsupported">;
}

const MAX_CONFLICT_RETRIES = 3;

export async function forgetJoinedDevice(
    store: JoinedDevicesStore,
    deviceId: string,
    ownDeviceId: string
): Promise<ForgetJoinedDeviceResult> {
    if (ownDeviceId.length === 0) {
        throw new Error("The current device ID must not be empty");
    }
    if (deviceId.length === 0) {
        throw new Error("The device ID must not be empty");
    }
    if (deviceId === DEVICE_ID_PREFERRED) {
        throw new Error("The preferred-device marker cannot be forgotten");
    }
    if (deviceId === ownDeviceId) {
        throw new Error("The current device cannot be forgotten");
    }

    let conflictRetries = 0;
    while (true) {
        const current = await store.read();
        if (current === undefined || !hasDevice(current.milestone, deviceId)) {
            return "not-found";
        }
        if (typeof current.revision !== "string") {
            return "unsupported";
        }

        const updatedMilestone = removeDevice(current.milestone, deviceId);
        const result = await store.write(updatedMilestone, current.revision);
        if (result === "updated") return "forgotten";
        if (result === "unsupported") return "unsupported";
        if (conflictRetries >= MAX_CONFLICT_RETRIES) return "conflict";
        conflictRetries++;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function addRecordKeys(ids: Set<string>, value: unknown): void {
    const record = asRecord(value);
    if (!record) return;
    for (const id of Object.keys(record)) {
        if (id !== DEVICE_ID_PREFERRED) ids.add(id);
    }
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasDevice(milestone: EntryMilestoneInfo, deviceId: string): boolean {
    const source = milestone as unknown as Record<string, unknown>;
    const accepted = Array.isArray(source.accepted_nodes) && source.accepted_nodes.includes(deviceId);
    return (
        accepted ||
        hasMapKey(source.node_info, deviceId) ||
        hasMapKey(source.node_chunk_info, deviceId) ||
        hasMapKey(source.tweak_values, deviceId)
    );
}

function hasMapKey(value: unknown, deviceId: string): boolean {
    const record = asRecord(value);
    return record !== undefined && hasOwn(record, deviceId);
}

function removeDevice(milestone: EntryMilestoneInfo, deviceId: string): EntryMilestoneInfo {
    const source = milestone as unknown as Record<string, unknown>;
    const updated: Record<string, unknown> = { ...source };

    for (const key of ["node_info", "node_chunk_info", "tweak_values"]) {
        if (hasOwn(source, key)) {
            updated[key] = removeMapKey(source[key], deviceId);
        }
    }

    if (hasOwn(source, "accepted_nodes") && Array.isArray(source.accepted_nodes)) {
        updated.accepted_nodes = source.accepted_nodes.filter((id) => id !== deviceId);
    }

    return updated as unknown as EntryMilestoneInfo;
}

function removeMapKey(value: unknown, deviceId: string): unknown {
    const record = asRecord(value);
    if (!record) return value;
    const updated = { ...record };
    delete updated[deviceId];
    return updated;
}
