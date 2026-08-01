import type { RemoteDBSettings } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import {
    inspectJournalStorageRemoteFormatV1,
    type IJournalStorage,
    type JournalStorageRemoteFormatV1,
} from "./JournalStorageAdapter.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";
import {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./JournalStorageConfiguration.ts";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "../adaptive/AdaptiveJournalManifest.ts";
import type { CapabilityVerification } from "../adaptive/AdaptiveJournalRepository.ts";

export {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./JournalStorageConfiguration.ts";

export function createJournalStorageAdapter(
    settings: RemoteDBSettings,
    env: LiveSyncJournalReplicatorEnv
): IJournalStorage {
    switch (journalStorageKindForRemoteType(settings.remoteType)) {
        case "s3":
            return new MinioStorageAdapter(settings, env);
        case "webdav":
            return new WebDAVStorageAdapter(settings, env);
    }
}

export function isJournalStorageAdapterCompatible(storage: IJournalStorage, settings: RemoteDBSettings): boolean {
    return storage.kind === journalStorageKindForRemoteType(settings.remoteType);
}

export interface JournalStorageConnectivityResult {
    adaptiveCapabilities?: JournalStorageAdaptiveCapabilityInspection;
    available: boolean;
    remoteFormat?: JournalStorageRemoteFormatV1;
}

export type JournalStorageCapabilityInspection = CapabilityVerification | { status: "not-checked" };

export interface JournalStorageAdaptiveCapabilityInspection {
    byteRange: JournalStorageCapabilityInspection;
    required: JournalStorageCapabilityInspection;
}

const OPTIONAL_BYTE_RANGE_CAPABILITY = "byte-range";
const ADAPTIVE_OBJECT_CAPABILITIES_TO_INSPECT = [
    ...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
    OPTIONAL_BYTE_RANGE_CAPABILITY,
].sort();

function splitAdaptiveCapabilityVerification(
    verification: CapabilityVerification
): JournalStorageAdaptiveCapabilityInspection {
    if (verification.status === "verified") {
        return {
            byteRange: { status: "verified" },
            required: { status: "verified" },
        };
    }
    if (verification.status === "failed") {
        return {
            byteRange: { status: "not-checked" },
            required: verification,
        };
    }

    const requiredMissing = verification.missing.filter((capability) => capability !== OPTIONAL_BYTE_RANGE_CAPABILITY);
    return {
        byteRange: verification.missing.includes(OPTIONAL_BYTE_RANGE_CAPABILITY)
            ? { missing: [OPTIONAL_BYTE_RANGE_CAPABILITY], status: "unsupported" }
            : requiredMissing.length === 0
              ? { status: "verified" }
              : { status: "not-checked" },
        required:
            requiredMissing.length === 0 ? { status: "verified" } : { missing: requiredMissing, status: "unsupported" },
    };
}

function unsupportedAdaptiveCapabilities(): JournalStorageAdaptiveCapabilityInspection {
    return {
        byteRange: { status: "not-checked" },
        required: {
            missing: [...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1],
            status: "unsupported",
        },
    };
}

export async function inspectJournalStorageConnectivity(
    storage: IJournalStorage,
    settings: RemoteDBSettings
): Promise<JournalStorageConnectivityResult> {
    journalStorageKindForRemoteType(settings.remoteType);
    const protocol = journalProtocolConfigurationForSettings(settings);
    const remoteFormat = await inspectJournalStorageRemoteFormatV1(storage);
    if (remoteFormat !== undefined && remoteFormat !== "empty" && remoteFormat !== protocol.journalFormat) {
        return { available: false, remoteFormat };
    }
    const formatResult = remoteFormat === undefined ? {} : { remoteFormat };
    if (protocol.journalFormat === "opaque-v1") {
        if (remoteFormat === undefined) await storage.listFiles("", 1);
        return { available: true, ...formatResult };
    }
    if (protocol.journalFormat === "adaptive-v1") {
        const adaptiveCapabilities = storage.verifyCapabilities
            ? splitAdaptiveCapabilityVerification(
                  await storage.verifyCapabilities(ADAPTIVE_OBJECT_CAPABILITIES_TO_INSPECT)
              )
            : unsupportedAdaptiveCapabilities();
        const requiredAvailable = adaptiveCapabilities.required.status === "verified";
        const rangeAvailable = adaptiveCapabilities.byteRange.status === "verified";
        return {
            adaptiveCapabilities,
            available: requiredAvailable && (protocol.packReadPolicy === "whole-pack" || rangeAvailable),
            ...formatResult,
        };
    }
    return { available: await storage.isAvailable(), ...formatResult };
}

export async function testJournalStorageConnectivity(
    storage: IJournalStorage,
    settings: RemoteDBSettings
): Promise<boolean> {
    return (await inspectJournalStorageConnectivity(storage, settings)).available;
}
