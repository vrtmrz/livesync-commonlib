import type { UXDataWriteOptions } from "@lib/common/types.ts";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { parseFilePath } from "../pathComparison.ts";
import type { FilePath, PathComparisonSettings, StorageEntry, StoragePath } from "../pathTypes.ts";
import { createStoragePathResolver, type StoragePathResolver } from "../storagePathResolution.ts";
import { FileSystemAccessStorageAdapter, type FileSystemAccessStorageStat } from "./storage.ts";

/**
 * Resolve NFC-equivalent logical paths against current File System Access directory names.
 *
 * @remarks
 * Each operation snapshots Unicode and case settings. Version `0` delegates to
 * the existing adapter; version `1` resolves names and rejects observed aliases
 * before I/O. Physical spelling and the host adapter's mutation semantics remain
 * unchanged. Resolution does not reserve paths against concurrent changes.
 */
export class UnicodeResolvingFileSystemAccessStorageAdapter implements IStorageAdapter<FileSystemAccessStorageStat> {
    private readonly storage: FileSystemAccessStorageAdapter;

    /**
     * Bind a host-owned root and callbacks for each operation's comparison settings.
     *
     * @param rootHandle - Host-selected directory handle with the required permissions.
     * @param getPathNormalizationVersion - Supplies `0` or `1`; defaults to Legacy `0`.
     * @param isCaseInsensitive - Whether comparisons ignore case; defaults to false.
     */
    constructor(
        rootHandle: FileSystemDirectoryHandle,
        private readonly getPathNormalizationVersion: () => number = () => 0,
        private readonly isCaseInsensitive: () => boolean = () => false
    ) {
        this.storage = new FileSystemAccessStorageAdapter(rootHandle);
    }

    /** Whether the current settings select NFC path resolution. */
    get isUnicodePathNormalizationEnabled(): boolean {
        return this.snapshotPolicy().pathNormalizationVersion === 1;
    }

    /**
     * Resolve a logical path under one snapshot of the current settings.
     *
     * @param path - Original root-relative file path.
     * @param caseInsensitive - Override this lookup's case rule without changing settings.
     * @param allowMissing - Keep a missing write suffix when true; defaults to true.
     * @returns The physical target, or `null` for an absent path when `allowMissing`
     * is false in NFC mode. Legacy mode returns the validated original path.
     * @throws Propagates NFC ambiguity and reader failures, and rejects invalid input.
     */
    async resolveLogicalPath(
        path: FilePath,
        caseInsensitive?: boolean,
        allowMissing = true
    ): Promise<StoragePath | null> {
        const policy = this.snapshotPolicy(caseInsensitive);
        const logicalPath = parseFilePath(path);
        if (policy.pathNormalizationVersion === 0) return logicalPath as StoragePath;

        const resolver = this.createResolver(policy);
        return allowMissing ? await resolver.resolveForWrite(logicalPath) : await resolver.resolveExisting(logicalPath);
    }

    /** Read metadata for a physical path without performing another logical lookup. */
    async statExact(path: StoragePath): Promise<FileSystemAccessStorageStat | null> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.trystat(path);
        return await this.storage.statResolved(path);
    }

    /** List a physical directory, rejecting equivalent child names in NFC mode. */
    async listExact(path: StoragePath): Promise<{ files: string[]; folders: string[] }> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.list(path);
        const entries = await this.createResolver(policy).listResolvedDirectory(path);
        return this.groupStorageEntries(entries ?? []);
    }

    /** Check whether the logical path exists under the current Unicode policy. */
    async exists(path: string): Promise<boolean> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.exists(path);
        return (await this.createResolver(policy).resolveExisting(parseFilePath(path))) !== null;
    }

    /** Read logical-path metadata, retaining Legacy adapter behaviour in version `0`. */
    async trystat(path: string): Promise<FileSystemAccessStorageStat | null> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.trystat(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        return resolved === null ? null : await this.storage.statResolved(resolved);
    }

    /** Read logical-path metadata, retaining Legacy adapter behaviour in version `0`. */
    async stat(path: string): Promise<FileSystemAccessStorageStat | null> {
        return await this.trystat(path);
    }

    /** Create a directory at the resolved write target. */
    async mkdir(path: string): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.mkdir(path);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.mkdirResolved(resolved);
    }

    /** Remove the entry at its resolved physical path. */
    async remove(path: string): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.remove(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved !== null) await this.storage.removeResolved(resolved);
    }

    /** Read text from the resolved physical file. */
    async read(path: string): Promise<string> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.read(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved === null) throw new Error(`File not found: ${path}`);
        return await this.storage.readResolved(resolved);
    }

    /** Read bytes from the resolved physical file. */
    async readBinary(path: string): Promise<ArrayBuffer> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.readBinary(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved === null) throw new Error(`File not found: ${path}`);
        return await this.storage.readBinaryResolved(resolved);
    }

    /** Write text at the resolved target while retaining existing physical spelling. */
    async write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.write(path, data, options);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.writeResolved(resolved, data, options);
    }

    /** Write bytes at the resolved target while retaining existing physical spelling. */
    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) {
            return await this.storage.writeBinary(path, data, options);
        }
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.writeBinaryResolved(resolved, data, options);
    }

    /** Append text at the resolved target using the host adapter semantics. */
    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.append(path, data, options);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.appendResolved(resolved, data, options);
    }

    /** List logical directory contents, checking equivalent child names in NFC mode. */
    async list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.list(basePath);
        const resolver = this.createResolver(policy);
        const resolved = await resolver.resolveExisting(parseFilePath(basePath));
        if (resolved === null) return { files: [], folders: [] };
        const entries = await resolver.listResolvedDirectory(resolved);
        return this.groupStorageEntries(entries ?? []);
    }

    private snapshotPolicy(caseInsensitive?: boolean): PathComparisonSettings {
        const pathNormalizationVersion = getPathNormalizationVersion({
            pathNormalizationVersion: this.getPathNormalizationVersion(),
        });
        const isCaseInsensitive = caseInsensitive ?? this.isCaseInsensitive();
        return Object.freeze({
            pathNormalizationVersion,
            handleFilenameCaseSensitive: !isCaseInsensitive,
        });
    }

    private createResolver(policy: PathComparisonSettings): StoragePathResolver {
        if (policy.pathNormalizationVersion !== 1) {
            throw new Error("The storage path resolver requires NFC path normalisation");
        }
        return createStoragePathResolver({
            readDirectory: (path) => this.storage.readDirectory(path),
            policy: {
                pathNormalizationVersion: 1,
                handleFilenameCaseSensitive: policy.handleFilenameCaseSensitive,
            },
        });
    }

    private groupStorageEntries(entries: readonly StorageEntry[]): { files: string[]; folders: string[] } {
        const files: string[] = [];
        const folders: string[] = [];
        for (const entry of entries) {
            if (entry.kind === "file") files.push(entry.path);
            else folders.push(entry.path);
        }
        return { files, folders };
    }
}
