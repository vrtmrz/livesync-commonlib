import { StoragePathResolver } from "./StoragePathResolver.ts";
import type { StoragePathResolver as ResolverContract, StoragePathResolverOptions } from "./pathTypes.ts";

export type {
    DirectoryEntry,
    ReadDirectory,
    ResolvedRename,
    StorageEntry,
    StoragePathResolver,
    StoragePathResolverOptions,
} from "./pathTypes.ts";
export { AmbiguousNormalisedPathError } from "./AmbiguousNormalisedPathError.ts";

/** Bind strict directory reads to an immutable NFC resolution policy. */
export function createStoragePathResolver(options: StoragePathResolverOptions): ResolverContract {
    return new StoragePathResolver(options);
}
