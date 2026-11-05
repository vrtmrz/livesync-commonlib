import {
    type ChunkVersionRange,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
    DEVICE_ID_PREFERRED,
} from "@lib/common/types.ts";
import { configuredIdKey } from "@lib/common/idDerivation.ts";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import type { PathIdentityInspection } from "@lib/pouchdb/pathIdentityCompatibility.ts";

const currentVersionRange: ChunkVersionRange = {
    min: 0,
    max: 2,
    current: 2,
};

export function journalVersionRange(setting: RemoteDBSettings): ChunkVersionRange {
    if (getPathNormalizationVersion(setting) === 1) return { min: 4, max: 4, current: 4 };
    return configuredIdKey(setting) && setting.encrypt && setting.usePathObfuscation
        ? { min: 3, max: 3, current: 3 }
        : currentVersionRange;
}

export function pathIdentityFromJournalRange(range: ChunkVersionRange | undefined): 0 | 1 {
    if (range?.min === 4 && range?.max === 4) return 1;
    if (!range) return 0;
    if (
        Number.isSafeInteger(range.min) &&
        Number.isSafeInteger(range.max) &&
        range.min >= 0 &&
        range.max <= 3 &&
        range.min <= range.max
    ) {
        return 0;
    }
    throw new Error("The Journal declares an unsupported path identity range.");
}

function journalPathIdentityNodes(milestone: EntryMilestoneInfo | undefined): Set<string> {
    // A rebuild lock retires accepted nodes, but their stored ranges still describe existing Journals.
    return new Set([...(milestone?.accepted_nodes ?? []), ...Object.keys(milestone?.node_chunk_info ?? {})]);
}

/** Without a node declaration, the caller must inspect storage before treating the bucket as empty. */
export function hasJournalNodeDeclarations(milestone: EntryMilestoneInfo | undefined): boolean {
    return journalPathIdentityNodes(milestone).size > 0;
}

export function matchesJournalPathIdentity(
    setting: RemoteDBSettings,
    milestone: EntryMilestoneInfo | undefined
): boolean {
    const pathVersion = getPathNormalizationVersion(setting);
    const ranges = milestone?.node_chunk_info ?? {};
    for (const node of journalPathIdentityNodes(milestone)) {
        const range = ranges[node];
        const usesNFC = range?.min === 4 && range?.max === 4;
        if (usesNFC !== (pathVersion === 1)) return false;
    }
    const preferred = milestone?.tweak_values?.[DEVICE_ID_PREFERRED];
    return !preferred || getPathNormalizationVersion(preferred) === pathVersion;
}

/** Project declarations only; an empty result does not establish that remote storage is empty. */
export function inspectJournalPathIdentity(milestone: EntryMilestoneInfo | undefined): PathIdentityInspection {
    const versions = new Set<0 | 1>();
    const ranges = milestone?.node_chunk_info ?? {};
    for (const node of journalPathIdentityNodes(milestone)) {
        versions.add(pathIdentityFromJournalRange(ranges[node]));
    }
    const preferred = milestone?.tweak_values?.[DEVICE_ID_PREFERRED];
    if (preferred) versions.add(getPathNormalizationVersion(preferred));
    if (versions.size > 1) throw new Error("The Journal has conflicting path identity declarations.");
    const version = [...versions][0];
    return version === undefined ? { status: "empty" } : { status: "configured", pathNormalizationVersion: version };
}
