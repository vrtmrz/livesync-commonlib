import type { DocumentID } from "./db.type";

export const VERSIONING_DOCID = "obsydian_livesync_version" as DocumentID;
export const MILESTONE_DOCID = "_local/obsydian_livesync_milestone" as DocumentID;
export const NODEINFO_DOCID = "_local/obsydian_livesync_nodeinfo" as DocumentID;

export const SYNCINFO_ID = "syncinfo" as DocumentID;

export const EntryTypes = {
    NOTE_LEGACY: "notes",
    NOTE_BINARY: "newnote",
    NOTE_PLAIN: "plain",
    INTERNAL_FILE: "internalfile",
    CHUNK: "leaf",
    CHUNK_PACK: "chunkpack",
    VERSION_INFO: "versioninfo",
    SYNC_INFO: "syncinfo",
    SYNC_PARAMETERS: "sync-parameters",
    MILESTONE_INFO: "milestoneinfo",
    NODE_INFO: "nodeinfo",
} as const;

export const NoteTypes = [EntryTypes.NOTE_LEGACY, EntryTypes.NOTE_BINARY, EntryTypes.NOTE_PLAIN];
export const ChunkTypes = [EntryTypes.CHUNK, EntryTypes.CHUNK_PACK];
