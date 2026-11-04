import { getPathNormalizationVersion as getSupportedPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import { createStoragePathResolver, type StoragePathResolver } from "../storagePathResolution.ts";
import { parseFilePath } from "../pathComparison.ts";
import type { FilePath, StoragePath } from "../pathTypes.ts";
import { NodeStorageAdapter } from "./storage.ts";

type PathResolutionSettings = Readonly<{
    pathNormalizationVersion: 0 | 1;
    caseInsensitive: boolean;
}>;

/**
 * Resolve NFC-equivalent logical paths against current Node directory names.
 *
 * @remarks
 * Each operation snapshots Unicode and case settings. Version `0` delegates to
 * the existing adapter; version `1` resolves names and rejects observed aliases
 * before I/O. Physical spelling and the host adapter's mutation semantics remain
 * unchanged. Resolution does not reserve paths against concurrent changes.
 */
export class UnicodeResolvingNodeStorageAdapter extends NodeStorageAdapter {
    /**
     * Bind a host-owned root and callbacks for each operation's comparison settings.
     *
     * @param rootPath - Host-selected storage directory.
     * @param getPathNormalizationVersion - Supplies `0` or `1`; defaults to Legacy `0`.
     * @param isCaseInsensitive - Whether comparisons ignore case; defaults to false.
     */
    constructor(
        rootPath: string,
        private readonly getPathNormalizationVersion: () => number = () => 0,
        private readonly isCaseInsensitive: () => boolean = () => false
    ) {
        super(rootPath);
    }

    /** Whether the current settings select NFC path resolution. */
    get isUnicodePathNormalizationEnabled(): boolean {
        return this.getPathNormalizationVersionSnapshot() === 1;
    }

    /** Read metadata for an entry already resolved or obtained from a storage listing. */
    async statExact(path: StoragePath) {
        const settings = this.getSettings();
        if (settings.pathNormalizationVersion === 0) return await super.trystat(path);
        return await super.statResolved(this.asStoragePath(path));
    }

    /** Inspect a physical directory once before descending into its enumerated entries. */
    async listExact(path: StoragePath): Promise<{ files: StoragePath[]; folders: StoragePath[] }> {
        const settings = this.getSettings();
        if (settings.pathNormalizationVersion === 0) {
            const entries = await super.list(path);
            return {
                files: entries.files.map((entry) => this.asStoragePath(entry)),
                folders: entries.folders.map((entry) => this.asStoragePath(entry)),
            };
        }
        return await this.listPhysicalDirectory(this.asStoragePath(path), settings);
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
        const settings = this.getSettings(caseInsensitive);
        const filePath = parseFilePath(path);
        if (settings.pathNormalizationVersion === 0) return filePath as StoragePath;
        await this.preflightRequestedPath(filePath);
        const resolver = this.createResolver(settings);
        return allowMissing ? await resolver.resolveForWrite(filePath) : await resolver.resolveExisting(filePath);
    }

    /** Check whether the logical path exists under the current Unicode policy. */
    override async exists(path: string, caseInsensitive?: boolean): Promise<boolean> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.exists(path);
        await this.preflightRequestedPath(path);
        const resolver = this.createResolver(settings);
        const resolvedPath = await resolver.resolveExisting(parseFilePath(path));
        if (resolvedPath === null) return false;
        return (await super.statResolved(resolvedPath)) !== null;
    }

    /** Read logical-path metadata, retaining Legacy adapter behaviour in version `0`. */
    override async trystat(path: string, caseInsensitive?: boolean) {
        const settings = this.getSettings(caseInsensitive);
        return await this.statWithSettings(path, settings);
    }

    /** Read logical-path metadata, retaining Legacy adapter behaviour in version `0`. */
    override async stat(path: string, caseInsensitive?: boolean) {
        const settings = this.getSettings(caseInsensitive);
        return await this.statWithSettings(path, settings);
    }

    /** Create a directory at the resolved write target. */
    override async mkdir(path: string, caseInsensitive?: boolean): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.mkdir(path);
        await this.preflightRequestedPath(path);
        const resolvedPath = await this.createResolver(settings).resolveForWrite(parseFilePath(path));
        await super.mkdirResolved(resolvedPath);
    }

    /** Remove the entry at its resolved physical path. */
    override async remove(path: string, caseInsensitive?: boolean): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.remove(path);
        const resolvedPath = await this.requireExistingPath(path, this.createResolver(settings));
        await super.removeResolved(resolvedPath);
    }

    /** Read text from the resolved physical file. */
    override async read(path: string, caseInsensitive?: boolean): Promise<string> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.read(path);
        const resolvedPath = await this.requireExistingPath(path, this.createResolver(settings));
        return await super.readResolved(resolvedPath);
    }

    /** Read bytes from the resolved physical file. */
    override async readBinary(path: string, caseInsensitive?: boolean): Promise<ArrayBuffer> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.readBinary(path);
        const resolvedPath = await this.requireExistingPath(path, this.createResolver(settings));
        return await super.readBinaryResolved(resolvedPath);
    }

    /** Write text at the resolved target while retaining existing physical spelling. */
    override async write(
        path: string,
        data: string,
        options?: Parameters<NodeStorageAdapter["write"]>[2],
        caseInsensitive?: boolean
    ): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.write(path, data, options);
        await this.preflightRequestedPath(path);
        const resolvedPath = await this.createResolver(settings).resolveForWrite(parseFilePath(path));
        await super.writeResolved(resolvedPath, data, options);
    }

    /** Write bytes at the resolved target while retaining existing physical spelling. */
    override async writeBinary(
        path: string,
        data: ArrayBuffer,
        options?: Parameters<NodeStorageAdapter["writeBinary"]>[2],
        caseInsensitive?: boolean
    ): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.writeBinary(path, data, options);
        await this.preflightRequestedPath(path);
        const resolvedPath = await this.createResolver(settings).resolveForWrite(parseFilePath(path));
        await super.writeBinaryResolved(resolvedPath, data, options);
    }

    /** Append text at the resolved target using the host adapter semantics. */
    override async append(
        path: string,
        data: string,
        options?: Parameters<NodeStorageAdapter["append"]>[2],
        caseInsensitive?: boolean
    ): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.append(path, data, options);
        await this.preflightRequestedPath(path);
        const resolvedPath = await this.createResolver(settings).resolveForWrite(parseFilePath(path));
        await super.appendResolved(resolvedPath, data, options);
    }

    /** Resolve and perform an explicit rename, including a requested leaf spelling change. */
    override async rename(sourcePath: string, targetPath: string, caseInsensitive?: boolean): Promise<void> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.rename(sourcePath, targetPath);
        await this.preflightRequestedPath(sourcePath, false);
        await this.preflightRequestedPath(targetPath, false);
        const resolver = this.createResolver(settings);
        const resolved = await resolver.resolveRename(parseFilePath(sourcePath), parseFilePath(targetPath));
        if (resolved === null) throw this.missingPathError(sourcePath);
        await super.renameResolved(resolved.source, resolved.target);
    }

    /** List logical directory contents, checking equivalent child names in NFC mode. */
    override async list(basePath: string, caseInsensitive?: boolean): Promise<{ files: string[]; folders: string[] }> {
        const settings = this.getSettings(caseInsensitive);
        if (settings.pathNormalizationVersion === 0) return await super.list(basePath);
        await this.preflightRequestedPath(basePath);
        const resolver = this.createResolver(settings);
        const resolvedPath = await resolver.resolveExisting(parseFilePath(basePath));
        if (resolvedPath === null) return { files: [], folders: [] };
        return await this.listPhysicalDirectory(resolvedPath, settings, resolver);
    }

    private async statWithSettings(path: string, settings: PathResolutionSettings) {
        if (settings.pathNormalizationVersion === 0) return await super.trystat(path);
        await this.preflightRequestedPath(path);
        const resolvedPath = await this.createResolver(settings).resolveExisting(parseFilePath(path));
        if (resolvedPath === null) return null;
        return await super.statResolved(resolvedPath);
    }

    private async requireExistingPath(path: string, resolver: StoragePathResolver): Promise<StoragePath> {
        await this.preflightRequestedPath(path);
        const resolvedPath = await resolver.resolveExisting(parseFilePath(path));
        if (resolvedPath === null) throw this.missingPathError(path);
        return resolvedPath;
    }

    private async preflightRequestedPath(path: string, allowRoot = true): Promise<void> {
        try {
            await this.resolvePath(path, allowRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return;
            throw error;
        }
    }

    private async listPhysicalDirectory(
        path: StoragePath,
        settings: PathResolutionSettings,
        resolver = this.createResolver(settings)
    ): Promise<{ files: StoragePath[]; folders: StoragePath[] }> {
        const entries = await resolver.listResolvedDirectory(path);
        const files: StoragePath[] = [];
        const folders: StoragePath[] = [];
        for (const entry of entries ?? []) {
            if (entry.kind === "directory") folders.push(entry.path);
            else files.push(entry.path);
        }
        return { files, folders };
    }

    private createResolver(settings: PathResolutionSettings): StoragePathResolver {
        return createStoragePathResolver({
            readDirectory: async (path) => await super.readDirectory(path),
            policy: {
                pathNormalizationVersion: 1,
                handleFilenameCaseSensitive: !settings.caseInsensitive,
            },
        });
    }

    private getSettings(caseInsensitive?: boolean): PathResolutionSettings {
        const pathNormalizationVersion = this.getPathNormalizationVersionSnapshot();
        return {
            pathNormalizationVersion,
            caseInsensitive: caseInsensitive ?? this.isCaseInsensitive(),
        };
    }

    private getPathNormalizationVersionSnapshot(): 0 | 1 {
        return getSupportedPathNormalizationVersion({
            pathNormalizationVersion: this.getPathNormalizationVersion(),
        });
    }

    private asStoragePath(path: string): StoragePath {
        return parseFilePath(path) as StoragePath;
    }

    private missingPathError(path: string): NodeJS.ErrnoException {
        const error = new Error("ENOENT: no such file or directory, " + path) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        error.path = path;
        return error;
    }
}
