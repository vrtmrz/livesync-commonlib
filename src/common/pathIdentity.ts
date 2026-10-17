import type { EntryHasPath, FilePathWithPrefix } from "./types";
import type { IPathService } from "@lib/services/base/IService";
import { id2path_base } from "@lib/string_and_binary/path";

function collision(first: string, second: string): Error {
    return new Error(
        `File path identity collision: ${JSON.stringify(first)} and ${JSON.stringify(second)}. Rename or exclude the distinct files before continuing.`
    );
}

/** Check the complete source listing before an operation can discard either database. */
export async function assertUniqueStoragePathIdentities(
    paths: Iterable<FilePathWithPrefix>,
    pathService: Pick<IPathService, "path2id">
): Promise<void> {
    const identities = new Map<string, string>();
    for (const path of paths) {
        const id = await pathService.path2id(path);
        const previous = identities.get(id);
        if (previous !== undefined && previous !== path) throw collision(previous, path);
        identities.set(id, path);
    }
}

/** Distinct Metadata documents must not be merged by a change of path identity. */
export async function assertMetadataPathIdentities(
    entries: AsyncIterable<EntryHasPath & { _id: string }> | Iterable<EntryHasPath & { _id: string }>,
    pathService: Pick<IPathService, "path2id">,
    requireMatchingIds: boolean
): Promise<void> {
    const identities = new Map<string, { path: string; id: string }>();
    for await (const entry of entries) {
        const path = id2path_base(entry._id as Parameters<typeof id2path_base>[0], entry);
        const id = await pathService.path2id(path);
        const previous = identities.get(id);
        if (previous && previous.id !== entry._id) throw collision(previous.path, path);
        identities.set(id, { path, id: entry._id });
        if (requireMatchingIds && entry._id !== id) {
            throw new Error(
                `The stored document ID for ${JSON.stringify(path)} uses a different path identity. Rebuild from the authoritative Vault or Fetch the migrated database before synchronising.`
            );
        }
    }
}
