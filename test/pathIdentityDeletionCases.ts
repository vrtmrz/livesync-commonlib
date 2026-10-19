import type { EntryDoc, DocumentID, FilePathWithPrefix } from "../src/common/types";

export const composedPath = "caf\u00e9.md" as FilePathWithPrefix;
export const decomposedPath = "cafe\u0301.md" as FilePathWithPrefix;

export const pathIdentityDeletionCases = [
    { name: "active duplicate", expectedCollision: true, count: 2 },
    { name: "logical deletion", expectedCollision: false, count: 2 },
    { name: "CouchDB tombstone", expectedCollision: false, count: 1 },
    { name: "both logically deleted", expectedCollision: false, count: 2 },
    { name: "both tombstoned", expectedCollision: false, count: 0 },
    {
        name: "tombstoned branch with a surviving non-deleted conflict",
        expectedCollision: true,
        count: 2,
    },
    {
        name: "logically deleted winner with a non-deleted losing conflict",
        expectedCollision: true,
        count: 2,
    },
    {
        name: "logically deleted winner with a logically deleted losing conflict",
        expectedCollision: true,
        count: 2,
    },
] as const;

export type PathIdentityDeletionCase = (typeof pathIdentityDeletionCases)[number];

function metadata(path: FilePathWithPrefix): EntryDoc {
    return { _id: path as string as DocumentID, path, type: "plain", ctime: 1, mtime: 1, size: 0, children: [] };
}

export async function seedPathIdentityDeletionCase(
    database: PouchDB.Database<EntryDoc>,
    scenario: PathIdentityDeletionCase
): Promise<void> {
    const created = await database.bulkDocs([metadata(composedPath), metadata(decomposedPath)]);
    if (created.some((result) => "error" in result)) throw new Error("Could not create the deletion fixture");
    const original = await database.get(decomposedPath);

    if (scenario.name === "logical deletion" || scenario.name === "both logically deleted") {
        await database.put({ ...original, deleted: true });
        if (scenario.name === "both logically deleted") {
            await database.put({ ...(await database.get(composedPath)), deleted: true });
        }
    } else if (scenario.name === "CouchDB tombstone" || scenario.name === "both tombstoned") {
        await database.remove(original);
        if (scenario.name === "both tombstoned") await database.remove(await database.get(composedPath));
    } else if (scenario.name.includes("conflict")) {
        const base = original._rev.split("-")[1];
        const logicallyDeletedWinner = scenario.name.startsWith("logically deleted winner");
        const logicallyDeletedLoser =
            scenario.name === "logically deleted winner with a logically deleted losing conflict";
        const inserted = await database.bulkDocs(
            [
                {
                    ...original,
                    ...(logicallyDeletedLoser ? { deleted: true } : {}),
                    _rev: "2-aaaa",
                    _revisions: { start: 2, ids: ["aaaa", base] },
                },
                {
                    ...original,
                    _rev: "2-zzzz",
                    _revisions: { start: 2, ids: ["zzzz", base] },
                    ...(logicallyDeletedWinner ? { deleted: true } : {}),
                },
            ],
            { new_edits: false }
        );
        if (inserted.some((result) => "error" in result)) throw new Error("Could not create the conflict fixture");
        if (scenario.name === "tombstoned branch with a surviving non-deleted conflict") {
            await database.remove(decomposedPath, "2-zzzz");
        }
    }
}
