import {
    resolveJournalProtocolOptionsV1,
    type JournalProtocolOptionsV1,
    type ResolvedJournalProtocolOptionsV1,
} from "@lib/common/models/journalProtocol.ts";

const JOURNAL_PROTOCOL_PARAMETERS = ["expectedRepositoryId", "journalFormat", "packReadPolicy"] as const;

export function parseJournalProtocolOptionsV1(
    url: URL,
    defaults: JournalProtocolOptionsV1 = {}
): ResolvedJournalProtocolOptionsV1 {
    return resolveJournalProtocolOptionsV1({
        expectedRepositoryId: url.searchParams.get("expectedRepositoryId") || defaults.expectedRepositoryId,
        journalFormat: url.searchParams.get("journalFormat") || defaults.journalFormat,
        packReadPolicy: url.searchParams.get("packReadPolicy") || defaults.packReadPolicy,
    });
}

export function removeJournalProtocolOptionsV1(url: URL): void {
    for (const parameter of JOURNAL_PROTOCOL_PARAMETERS) url.searchParams.delete(parameter);
}

export function applyJournalProtocolOptionsV1(url: URL, options: JournalProtocolOptionsV1): void {
    removeJournalProtocolOptionsV1(url);
    const protocol = resolveJournalProtocolOptionsV1(options);
    if (protocol.journalFormat !== "adaptive-v1") return;

    url.searchParams.set("journalFormat", protocol.journalFormat);
    if (protocol.expectedRepositoryId) {
        url.searchParams.set("expectedRepositoryId", protocol.expectedRepositoryId);
    }
    if (protocol.packReadPolicy !== "whole-pack") {
        url.searchParams.set("packReadPolicy", protocol.packReadPolicy);
    }
}
