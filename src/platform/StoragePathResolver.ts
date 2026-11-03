import { getPathNormalizationVersion } from "../common/pathNormalization.ts";
import { AmbiguousNormalisedPathError } from "./AmbiguousNormalisedPathError.ts";
import { getStoragePathComparisonKey } from "./pathComparison.ts";
import { validateStoragePath } from "./storagePath.ts";
import type {
    DirectoryEntry,
    FilePath,
    PathComparisonSettings,
    ReadDirectory,
    ResolvedRename,
    StorageEntry,
    StoragePath,
    StoragePathResolver as ResolverContract,
    StoragePathResolverOptions,
} from "./pathTypes.ts";

function storagePath(path: string): StoragePath {
    return validateStoragePath(path) as StoragePath;
}

function childPath(parent: StoragePath, name: string): StoragePath {
    return storagePath(parent === "" ? name : `${parent}/${name}`);
}

function segments(path: FilePath): string[] {
    validateStoragePath(path);
    return path.split("/").filter(Boolean);
}

/** Resolves listed names using one immutable NFC policy and no retained directory cache. */
export class StoragePathResolver implements ResolverContract {
    private readonly readDirectory: ReadDirectory;
    private readonly policy: PathComparisonSettings;

    constructor({ readDirectory, policy }: StoragePathResolverOptions) {
        if (getPathNormalizationVersion(policy) !== 1) {
            throw new Error("Storage path resolution requires NFC path identity");
        }
        if (typeof policy.handleFilenameCaseSensitive !== "boolean") {
            throw new TypeError("Filename case handling must be explicit");
        }
        this.readDirectory = readDirectory;
        this.policy = Object.freeze({ ...policy });
    }

    async resolveExisting(path: FilePath): Promise<StoragePath | null> {
        return await this.resolve(path, false);
    }

    async resolveForWrite(path: FilePath): Promise<StoragePath> {
        const resolved = await this.resolve(path, true);
        if (resolved === null) throw new Error(`Could not resolve storage target: ${path}`);
        return resolved;
    }

    async resolveRename(source: FilePath, target: FilePath): Promise<ResolvedRename | null> {
        validateStoragePath(source, false);
        validateStoragePath(target, false);
        const resolvedSource = await this.resolveExisting(source);
        if (resolvedSource === null) return null;
        const resolvedTarget = await this.resolveForWrite(target);
        if (resolvedTarget !== resolvedSource || target === resolvedSource) {
            return { source: resolvedSource, target: resolvedTarget };
        }
        const requestedParts = segments(target);
        const leaf = requestedParts[requestedParts.length - 1];
        const parent = storagePath(resolvedTarget.slice(0, Math.max(0, resolvedTarget.lastIndexOf("/"))));
        return { source: resolvedSource, target: childPath(parent, leaf) };
    }

    async listResolvedDirectory(path: StoragePath): Promise<readonly StorageEntry[] | null> {
        validateStoragePath(path);
        const entries = await this.readEntries(path);
        if (entries === null) return null;
        const names = new Map<string, StoragePath>();
        return entries.map((entry) => {
            const actualPath = childPath(path, entry.name);
            const key = this.key(entry.name);
            const previous = names.get(key);
            if (previous !== undefined) {
                throw new AmbiguousNormalisedPathError(path, [previous, actualPath]);
            }
            names.set(key, actualPath);
            return { path: actualPath, kind: entry.kind };
        });
    }

    private async resolve(path: FilePath, allowMissing: boolean): Promise<StoragePath | null> {
        const parts = segments(path);
        let parent = storagePath("");
        if (parts.length === 0) {
            return allowMissing || (await this.readEntries(parent)) !== null ? parent : null;
        }
        for (let index = 0; index < parts.length; index++) {
            const entries = await this.readEntries(parent);
            const match = entries === null ? undefined : this.findEntry(entries, parts[index], parent, path);
            if (!match) {
                return allowMissing ? childPath(parent, parts.slice(index).join("/")) : null;
            }
            parent = childPath(parent, match.name);
            if (index < parts.length - 1 && match.kind !== "directory") {
                throw new Error(`A storage path parent is not a directory: ${parent}`);
            }
        }
        return parent;
    }

    private findEntry(
        entries: readonly DirectoryEntry[],
        name: string,
        parent: StoragePath,
        requestedPath: FilePath
    ): DirectoryEntry | undefined {
        const key = this.key(name);
        const matches = entries.filter((entry) => this.key(entry.name) === key);
        if (matches.length > 1) {
            throw new AmbiguousNormalisedPathError(
                requestedPath,
                matches.map((entry) => childPath(parent, entry.name))
            );
        }
        return matches[0];
    }

    private async readEntries(path: StoragePath): Promise<readonly DirectoryEntry[] | null> {
        const entries = await this.readDirectory(path);
        if (entries === null) return null;
        for (const entry of entries) {
            if (
                typeof entry.name !== "string" ||
                entry.name === "" ||
                entry.name === "." ||
                entry.name === ".." ||
                /[\/\\\0]/u.test(entry.name) ||
                (entry.kind !== "file" && entry.kind !== "directory")
            ) {
                throw new TypeError(`Invalid directory entry below ${JSON.stringify(path)}`);
            }
            childPath(path, entry.name);
        }
        return entries;
    }

    private key(name: string): string {
        // Components have already crossed the path or directory-listing boundary.
        return getStoragePathComparisonKey(name as FilePath, this.policy);
    }
}
