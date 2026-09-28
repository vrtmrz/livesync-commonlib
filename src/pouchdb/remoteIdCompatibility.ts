import type PouchDB from "pouchdb-core";
import type { DocumentID, EntryDoc, RemoteDBSettings } from "@lib/common/types.ts";
import { configuredIdKey } from "@lib/common/idDerivation.ts";
import { ICHeader, ICXHeader, PSCHeader } from "@lib/common/models/fileaccess.const.ts";
import { PREFIX_OBFUSCATED, type FilePathWithPrefix } from "@lib/common/types.ts";

export type RemoteIdCompatibility = "matching" | "mismatched" | "unverified";

/** Check a bounded set of existing document IDs before admitting an ID configuration. */
export async function assessRemoteDocumentIds(
    db: PouchDB.Database<EntryDoc>,
    setting: Pick<
        RemoteDBSettings,
        | "encrypt"
        | "idDerivationVersion"
        | "idDerivationKey"
        | "usePathObfuscation"
        | "passphrase"
        | "handleFilenameCaseSensitive"
    >,
    path2id: (path: FilePathWithPrefix) => Promise<DocumentID>
): Promise<RemoteIdCompatibility> {
    configuredIdKey(setting);
    if (!setting.encrypt || !setting.usePathObfuscation) return "unverified";
    let matched = false;

    for (const prefix of [
        PREFIX_OBFUSCATED,
        `${ICHeader}${PREFIX_OBFUSCATED}`,
        `${ICXHeader}${PREFIX_OBFUSCATED}`,
        `${PSCHeader}${PREFIX_OBFUSCATED}`,
    ]) {
        const rows = await db.allDocs({ startkey: prefix, endkey: `${prefix}\ufff0`, limit: 2 });
        for (const row of rows.rows) {
            if ("error" in row || !row.id) continue;
            const doc = await db.get(row.id);
            if (!("path" in doc) || typeof doc.path !== "string") continue;
            const expected = await path2id(doc.path as FilePathWithPrefix);
            if (expected !== doc._id) return "mismatched";
            matched = true;
        }
    }
    return matched ? "matching" : "unverified";
}
