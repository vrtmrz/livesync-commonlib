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

/**
 * Bind strict directory reads to a copied NFC resolution policy.
 *
 * @param options - Host enumeration and explicit NFC/case settings.
 * @returns A resolver which reads current listings without retaining a directory cache.
 * @throws Rejects a path version other than `1` or a non-boolean case setting.
 * @remarks Construction performs no I/O. Resolution performs no mutation or
 * atomic reservation; construct a new resolver when its comparison settings change.
 */
export function createStoragePathResolver(options: StoragePathResolverOptions): ResolverContract {
    return new StoragePathResolver(options);
}
