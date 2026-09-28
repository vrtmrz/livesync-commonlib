import {
    type EntryDoc,
    type EntryMilestoneInfo,
    MILESTONE_DOCID as MILESTONE_DOC_ID,
    type RemoteDBSettings,
    type ChunkVersionRange,
    TweakValuesTemplate,
    type TweakValues,
    DEVICE_ID_PREFERRED,
    type DeviceInfo,
    type TweakAssessment,
    REMOTE_COUCHDB,
} from "@lib/common/types.ts";
import { extractObject, isObjectDifferent, resolveWithIgnoreKnownError } from "@lib/common/utils.ts";
import { assessTweakCompatibility } from "@lib/common/models/tweak.compatibility.ts";
import { usesEncryptedInternalMetadata } from "./remoteFeatureCompatibility.ts";

export function getEffectiveTweakValues(setting: RemoteDBSettings): TweakValues {
    return {
        ...extractObject(TweakValuesTemplate, setting),
        encryptInternalMetadata: setting.remoteType === REMOTE_COUCHDB && usesEncryptedInternalMetadata(setting),
    };
}

// This interface is expected to be unnecessary because of the change in dependency direction

/// Connectivity

// Should we move ENSURE_DB_RESULT and ensureRemoteIsCompatible to the replication utility?
export type ENSURE_DB_RESULT =
    | "OK"
    | "INCOMPATIBLE"
    | "ID_KEY_MISMATCH"
    | "LOCKED"
    | "NODE_LOCKED"
    | "NODE_CLEANED"
    | ["MISMATCHED", TweakValues];

/**
 * Ensures that the remote database is compatible with the current device.
 *
 * @param infoSrc - The information about the remote database (which retrieved from the remote).
 * @param setting - The current settings.
 * @param deviceNodeID - The ID of the current device node.
 * @param currentVersionRange - The current version range of the database.
 * @param updateCallback - The callback function to update the remote milestone.
 * @returns A promise that resolves to the result of ensuring compatibility.
 */
export async function ensureRemoteIsCompatible(
    infoSrc: EntryMilestoneInfo | false,
    setting: RemoteDBSettings,
    deviceNodeID: string,
    currentVersionRange: ChunkVersionRange,
    nodeDeviceInfo: DeviceInfo,
    updateCallback: (info: EntryMilestoneInfo) => Promise<void>,
    recordTweakAssessment?: (assessment: TweakAssessment) => void
): Promise<ENSURE_DB_RESULT> {
    const now = Date.now();
    const baseMilestone: EntryMilestoneInfo = {
        _id: MILESTONE_DOC_ID,
        type: "milestoneinfo",
        created: now,
        locked: false,
        accepted_nodes: [deviceNodeID],
        node_chunk_info: { [deviceNodeID]: currentVersionRange },
        node_info: {
            [deviceNodeID]: {
                ...nodeDeviceInfo,
                last_connected: 0,
                progress: "",
            },
        },
        tweak_values: {},
    };
    let remoteMilestone = infoSrc;
    if (!remoteMilestone) remoteMilestone = baseMilestone;

    const currentTweakValues = getEffectiveTweakValues(setting);
    const nodeChunkInfo = { ...baseMilestone.node_chunk_info, ...remoteMilestone.node_chunk_info };

    // Check compatibility before publishing this node's settings to the remote milestone.
    let globalMin = currentVersionRange.min;
    let globalMax = currentVersionRange.max;
    for (const nodeId of remoteMilestone.accepted_nodes) {
        if (nodeId == deviceNodeID) continue;
        if (nodeId in nodeChunkInfo) {
            const nodeInfo = nodeChunkInfo[nodeId];
            globalMin = Math.max(nodeInfo.min, globalMin);
            globalMax = Math.min(nodeInfo.max, globalMax);
        } else {
            globalMin = 0;
            globalMax = 0;
        }
    }

    if (globalMax < globalMin && !setting.ignoreVersionCheck) {
        return "INCOMPATIBLE";
    }

    const preferred_tweak = remoteMilestone.tweak_values?.[DEVICE_ID_PREFERRED] ?? currentTweakValues;
    const tweakAssessment = assessTweakCompatibility(currentTweakValues, preferred_tweak);
    if (tweakAssessment.entries.some(({ key, relation }) => key === "idDerivationVersion" && relation === "different")) {
        return "ID_KEY_MISMATCH";
    }

    if (!setting.disableCheckingConfigMismatch) {
        recordTweakAssessment?.(tweakAssessment);
        if (tweakAssessment.alignment === "mismatched") {
            return ["MISMATCHED", preferred_tweak];
        }
    }

    if (remoteMilestone.locked && remoteMilestone.accepted_nodes.indexOf(deviceNodeID) == -1) {
        return remoteMilestone.cleaned ? "NODE_CLEANED" : "NODE_LOCKED";
    }

    remoteMilestone.node_chunk_info = nodeChunkInfo;
    let writeMilestone =
        remoteMilestone.node_chunk_info[deviceNodeID].min != currentVersionRange.min ||
        remoteMilestone.node_chunk_info[deviceNodeID].max != currentVersionRange.max ||
        isObjectDifferent(remoteMilestone.tweak_values?.[deviceNodeID], currentTweakValues) ||
        typeof remoteMilestone._rev == "undefined" ||
        !(DEVICE_ID_PREFERRED in remoteMilestone.tweak_values);

    if (!remoteMilestone.node_info) {
        remoteMilestone.node_info = {};
    }
    if (!(deviceNodeID in remoteMilestone.node_info)) {
        remoteMilestone.node_info[deviceNodeID] = {
            ...nodeDeviceInfo,
            last_connected: 0,
            progress: "",
        };
        writeMilestone = true;
    }
    const info = remoteMilestone.node_info[deviceNodeID];
    const keys = ["device_name", "app_version", "plugin_version", "vault_name", "progress"] as (keyof DeviceInfo)[];
    for (const key of keys) {
        if (info[key] != nodeDeviceInfo[key]) {
            remoteMilestone.node_info[deviceNodeID][key] = nodeDeviceInfo[key];
            writeMilestone = true;
        }
    }

    const diffLastConnected = now - (remoteMilestone.node_info[deviceNodeID].last_connected || 0);
    // Prevent updating last_connected too frequently
    if (diffLastConnected > 60000) {
        remoteMilestone.node_info[deviceNodeID].last_connected = now;
        writeMilestone = true;
    }

    if (writeMilestone) {
        remoteMilestone.node_chunk_info[deviceNodeID].min = currentVersionRange.min;
        remoteMilestone.node_chunk_info[deviceNodeID].max = currentVersionRange.max;
        remoteMilestone.tweak_values = { ...(remoteMilestone.tweak_values ?? {}), [deviceNodeID]: currentTweakValues };
        if (!(DEVICE_ID_PREFERRED in remoteMilestone.tweak_values)) {
            remoteMilestone.tweak_values[DEVICE_ID_PREFERRED] = currentTweakValues;
        }
        await updateCallback(remoteMilestone);
    }

    return remoteMilestone.locked ? "LOCKED" : "OK";
}

export async function ensureDatabaseIsCompatible(
    db: PouchDB.Database<EntryDoc>,
    setting: RemoteDBSettings,
    deviceNodeID: string,
    currentVersionRange: ChunkVersionRange,
    nodeDeviceInfo: DeviceInfo,
    recordTweakAssessment?: (assessment: TweakAssessment) => void
): Promise<ENSURE_DB_RESULT> {
    const remoteMilestone = await resolveWithIgnoreKnownError<EntryMilestoneInfo | false>(
        db.get(MILESTONE_DOC_ID),
        false
    );
    const ret = await ensureRemoteIsCompatible(
        remoteMilestone,
        setting,
        deviceNodeID,
        currentVersionRange,
        nodeDeviceInfo,
        async (info) => {
            await db.put(info);
        },
        recordTweakAssessment
    );
    return ret;
}
