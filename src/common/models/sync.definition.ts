import { EntryTypes } from "./db.const";
import type { DatabaseEntry, DocumentID } from "./db.type";

export const ProtocolVersions = {
    UNSET: undefined,
    LEGACY: 1,
    ADVANCED_E2EE: 2,
} as const;
export type ProtocolVersion = (typeof ProtocolVersions)[keyof typeof ProtocolVersions];
export const DOCID_SYNC_PARAMETERS = "_local/obsidian_livesync_sync_parameters" as DocumentID;
export const DOCID_JOURNAL_SYNC_PARAMETERS = "_obsidian_livesync_journal_sync_parameters.json" as DocumentID;

export interface SyncParameters extends DatabaseEntry {
    _id: typeof DOCID_SYNC_PARAMETERS;
    _rev?: string;
    type: (typeof EntryTypes)["SYNC_PARAMETERS"];
    protocolVersion: ProtocolVersion;
    pbkdf2salt: string;
}
export const DEFAULT_SYNC_PARAMETERS: SyncParameters = {
    _id: DOCID_SYNC_PARAMETERS,
    type: EntryTypes["SYNC_PARAMETERS"],
    protocolVersion: ProtocolVersions.ADVANCED_E2EE,
    pbkdf2salt: "",
};
