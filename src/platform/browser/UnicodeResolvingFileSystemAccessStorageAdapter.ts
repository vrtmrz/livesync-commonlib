import type { UXDataWriteOptions } from "@lib/common/types.ts";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { parseFilePath } from "../pathComparison.ts";
import type { FilePath, PathComparisonSettings, StorageEntry, StoragePath } from "../pathTypes.ts";
import { createStoragePathResolver, type StoragePathResolver } from "../storagePathResolution.ts";
import { FileSystemAccessStorageAdapter, type FileSystemAccessStorageStat } from "./storage.ts";

/** Browser storage adapter which resolves NFC paths against actual directory names. */
export class UnicodeResolvingFileSystemAccessStorageAdapter implements IStorageAdapter<FileSystemAccessStorageStat> {
    private readonly storage: FileSystemAccessStorageAdapter;

    constructor(
        rootHandle: FileSystemDirectoryHandle,
        private readonly getPathNormalizationVersion: () => number = () => 0,
        private readonly isCaseInsensitive: () => boolean = () => false
    ) {
        this.storage = new FileSystemAccessStorageAdapter(rootHandle);
    }

    get isUnicodePathNormalizationEnabled(): boolean {
        return this.snapshotPolicy().pathNormalizationVersion === 1;
    }

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

    async statExact(path: StoragePath): Promise<FileSystemAccessStorageStat | null> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.trystat(path);
        return await this.storage.statResolved(path);
    }

    async listExact(path: StoragePath): Promise<{ files: string[]; folders: string[] }> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.list(path);
        const entries = await this.createResolver(policy).listResolvedDirectory(path);
        return this.groupStorageEntries(entries ?? []);
    }

    async exists(path: string): Promise<boolean> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.exists(path);
        return (await this.createResolver(policy).resolveExisting(parseFilePath(path))) !== null;
    }

    async trystat(path: string): Promise<FileSystemAccessStorageStat | null> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.trystat(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        return resolved === null ? null : await this.storage.statResolved(resolved);
    }

    async stat(path: string): Promise<FileSystemAccessStorageStat | null> {
        return await this.trystat(path);
    }

    async mkdir(path: string): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.mkdir(path);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.mkdirResolved(resolved);
    }

    async remove(path: string): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.remove(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved !== null) await this.storage.removeResolved(resolved);
    }

    async read(path: string): Promise<string> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.read(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved === null) throw new Error(`File not found: ${path}`);
        return await this.storage.readResolved(resolved);
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.readBinary(path);
        const resolved = await this.createResolver(policy).resolveExisting(parseFilePath(path));
        if (resolved === null) throw new Error(`File not found: ${path}`);
        return await this.storage.readBinaryResolved(resolved);
    }

    async write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.write(path, data, options);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.writeResolved(resolved, data, options);
    }

    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) {
            return await this.storage.writeBinary(path, data, options);
        }
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.writeBinaryResolved(resolved, data, options);
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const policy = this.snapshotPolicy();
        if (policy.pathNormalizationVersion === 0) return await this.storage.append(path, data, options);
        const resolved = await this.createResolver(policy).resolveForWrite(parseFilePath(path));
        await this.storage.appendResolved(resolved, data, options);
    }

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
