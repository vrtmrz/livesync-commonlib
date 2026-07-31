import type { AdaptiveJournalPackReadPolicyV1, JournalFormatV1 } from "./setting.type.ts";

export interface JournalProtocolOptionsV1 {
    expectedRepositoryId?: unknown;
    journalFormat?: unknown;
    packReadPolicy?: unknown;
}

export interface ResolvedJournalProtocolOptionsV1 {
    expectedRepositoryId: string;
    journalFormat: JournalFormatV1;
    packReadPolicy: AdaptiveJournalPackReadPolicyV1;
}

function validateExpectedRepositoryId(value: string): void {
    if (!value) return;
    try {
        if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("invalid base64url");
        const padding = "=".repeat((4 - (value.length % 4)) % 4);
        const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
        const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
        if (binary.length !== 32 || canonical !== value) throw new Error("invalid repository ID");
    } catch {
        throw new Error("expectedRepositoryId must be a canonical base64url-encoded 32-byte value");
    }
}

/** Resolves conservative defaults and rejects inconsistent persisted Journal protocol fields. */
export function resolveJournalProtocolOptionsV1(options: JournalProtocolOptionsV1): ResolvedJournalProtocolOptionsV1 {
    const journalFormat = options.journalFormat ?? "opaque-v1";
    if (journalFormat !== "opaque-v1" && journalFormat !== "adaptive-v1") {
        throw new Error(`Unsupported Journal format: ${String(journalFormat)}`);
    }
    const packReadPolicy = options.packReadPolicy ?? "whole-pack";
    if (packReadPolicy !== "whole-pack" && packReadPolicy !== "range") {
        throw new Error(`Unsupported Adaptive Journal pack read policy: ${String(packReadPolicy)}`);
    }
    const expectedRepositoryId = options.expectedRepositoryId ?? "";
    if (typeof expectedRepositoryId !== "string") {
        throw new Error("expectedRepositoryId must be a string");
    }
    validateExpectedRepositoryId(expectedRepositoryId);
    if (journalFormat === "opaque-v1" && (expectedRepositoryId || packReadPolicy !== "whole-pack")) {
        throw new Error("Opaque Journal connections cannot carry Adaptive repository options");
    }
    return { expectedRepositoryId, journalFormat, packReadPolicy };
}
