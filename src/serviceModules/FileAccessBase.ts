import { isPlainText } from "@lib/string_and_binary/path.ts";
import type { FilePath, UXDataWriteOptions, UXFileInfoStub, UXFolderInfo } from "@lib/common/types.ts";
import { createBinaryBlob, isDocContentSame } from "@lib/common/utils.ts";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess.ts";
import type { IAPIService, IPathService, ISettingService, IVaultService } from "@lib/services/base/IService.ts";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils.ts";
import type { FileWithFileStat } from "../common/models/fileaccess.type";
import type { IFileSystemAdapter } from "./adapters";

export function toArrayBuffer(arr: Uint8Array<ArrayBuffer> | ArrayBuffer | DataView<ArrayBuffer>): ArrayBuffer {
    if (arr instanceof Uint8Array) {
        return arr.buffer;
    }
    if (arr instanceof DataView) {
        return arr.buffer;
    }
    return arr;
}

export interface FileAccessBaseDependencies {
    vaultService: IVaultService;
    storageAccessManager: IStorageAccessManager;
    settingService: ISettingService;
    pathService: IPathService;
    APIService: IAPIService;
}

/**
 * Type helper to extract the abstract file type from a file system adapter
 */
export type ExtractAbstractFile<T> = T extends IFileSystemAdapter<infer A, any, any, any> ? A : never;

/**
 * Type helper to extract the file type from a file system adapter
 */
export type ExtractFile<T> = T extends IFileSystemAdapter<any, infer F, any, any> ? F : never;

/**
 * Type helper to extract the folder type from a file system adapter
 */
export type ExtractFolder<T> = T extends IFileSystemAdapter<any, any, infer D, any> ? D : never;

/**
 * Type helper to extract the stat type from a file system adapter
 */
export type ExtractStat<T> = T extends IFileSystemAdapter<any, any, any, infer S> ? S : never;

/**
 * Base class for file access operations
 * Uses adapter pattern for platform-specific implementations
 *
 * @template TAdapter - The file system adapter type, which determines all native file types
 */
export class FileAccessBase<TAdapter extends IFileSystemAdapter<any, any, any, any>> {
    protected storageAccessManager: IStorageAccessManager;
    protected vaultService: IVaultService;
    protected settingService: ISettingService;
    protected APIService: IAPIService;
    protected path: IPathService;
    protected adapter: TAdapter;

    _log: ReturnType<typeof createInstanceLogFunction>;

    constructor(adapter: TAdapter, dependencies: FileAccessBaseDependencies) {
        this.adapter = adapter;
        this.storageAccessManager = dependencies.storageAccessManager;
        this.vaultService = dependencies.vaultService;
        this.settingService = dependencies.settingService;
        this.APIService = dependencies.APIService;
        this.path = dependencies.pathService;
        this._log = createInstanceLogFunction("FileAccess", this.APIService);
    }

    // Delegated methods to adapter
    isFile(
        file:
            | UXFileInfoStub
            | ExtractAbstractFile<TAdapter>
            | FilePath
            | ExtractFolder<TAdapter>
            | ExtractFile<TAdapter>
            | null
    ): file is ExtractFile<TAdapter> {
        return this.adapter.typeGuard.isFile(file);
    }

    isFolder(
        item:
            | UXFileInfoStub
            | ExtractAbstractFile<TAdapter>
            | FilePath
            | ExtractFolder<TAdapter>
            | ExtractFile<TAdapter>
            | null
    ): item is ExtractFolder<TAdapter> {
        return this.adapter.typeGuard.isFolder(item);
    }

    getPath(file: ExtractAbstractFile<TAdapter> | string): FilePath {
        return this.adapter.path.getPath(file);
    }

    nativeFileToUXFileInfoStub(file: ExtractFile<TAdapter>): UXFileInfoStub {
        return this.adapter.conversion.nativeFileToUXFileInfoStub(file);
    }

    nativeFolderToUXFolder(file: ExtractFolder<TAdapter>): UXFolderInfo {
        return this.adapter.conversion.nativeFolderToUXFolder(file);
    }

    normalisePath(path: string): string {
        return this.adapter.path.normalisePath(path);
    }

    protected _writeOp<T extends ExtractAbstractFile<TAdapter> | string, U>(
        file: T,
        callback: (path: FilePath, file: T) => Promise<U>
    ): Promise<U> {
        const path = this.getPath(file);
        return this.storageAccessManager.processWriteFile(path, async () => await callback(path, file));
    }

    protected _readOp<T extends ExtractAbstractFile<TAdapter> | string, U>(
        file: T,
        callback: (path: FilePath, file: T) => Promise<U>
    ): Promise<U> {
        const path = this.getPath(file);
        return this.storageAccessManager.processReadFile(path, async () => await callback(path, file));
    }

    async tryAdapterStat(file: ExtractFile<TAdapter> | string) {
        return await this._readOp(file, async (path) => await this.adapter.storage.trystat(path));
    }

    async adapterStat(file: ExtractFile<TAdapter> | string): Promise<ExtractStat<TAdapter> | null> {
        return await this._readOp(file, async (path) => await this.adapter.storage.stat(path));
    }

    async adapterExists(file: ExtractFile<TAdapter> | string): Promise<boolean> {
        return await this._readOp(file, async (path) => await this.adapter.storage.exists(path));
    }

    async adapterRemove(file: ExtractFile<TAdapter> | string): Promise<void> {
        return await this._writeOp(file, async (path) => await this.adapter.storage.remove(path));
    }

    async adapterRead(file: ExtractFile<TAdapter> | string): Promise<string> {
        return await this._readOp(file, async (path) => await this.adapter.storage.read(path));
    }

    async adapterReadBinary(file: ExtractFile<TAdapter> | string): Promise<ArrayBuffer> {
        return await this._readOp(file, async (path) => await this.adapter.storage.readBinary(path));
    }

    async adapterReadAuto(file: ExtractFile<TAdapter> | string): Promise<string | ArrayBuffer> {
        const path = this.getPath(file);
        if (isPlainText(path)) {
            return await this._readOp(file, async (path) => await this.adapter.storage.read(path));
        }
        return await this._readOp(file, async (path) => await this.adapter.storage.readBinary(path));
    }

    async adapterWrite(
        file: ExtractFile<TAdapter> | string,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ): Promise<void> {
        if (typeof data === "string") {
            return await this._writeOp(file, async (path) => await this.adapter.storage.write(path, data, options));
        } else {
            return await this._writeOp(
                file,
                async (path) => await this.adapter.storage.writeBinary(path, toArrayBuffer(data), options)
            );
        }
    }

    adapterList(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        return this.adapter.storage.list(basePath);
    }

    async vaultCacheRead(file: ExtractFile<TAdapter>): Promise<string> {
        return await this._readOp(file, async (path) => await this.adapter.vault.cachedRead(file));
    }

    vaultRead(file: ExtractFile<TAdapter>): Promise<string> {
        return this._readOp(file, async (path) => await this.adapter.vault.read(file));
    }

    vaultReadBinary(file: ExtractFile<TAdapter>): Promise<ArrayBuffer> {
        return this._readOp(file, async (path) => await this.adapter.vault.readBinary(file));
    }

    async vaultReadAuto(file: ExtractFile<TAdapter>) {
        const path = this.getPath(file);
        if (isPlainText(path)) {
            return await this._readOp(path, async (path) => await this.adapter.vault.read(file));
        }
        return await this._readOp(path, async (path) => await this.adapter.vault.readBinary(file));
    }

    async vaultModify(
        file: ExtractFile<TAdapter>,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ) {
        if (typeof data === "string") {
            return await this._writeOp(file, async (path) => {
                const oldData = await this.adapter.vault.read(file);
                if (data === oldData) {
                    const stat = await this.adapter.statFromNative(file);
                    if (options && options.mtime) this.path.markChangesAreSame(path, stat.mtime, options.mtime);
                    return true;
                }
                await this.adapter.vault.modify(file, data, options);
                return true;
            });
        } else {
            return await this._writeOp(file, async (path) => {
                const oldData = await this.adapter.vault.readBinary(file);
                if (await isDocContentSame(createBinaryBlob(oldData), createBinaryBlob(data))) {
                    const stat = await this.adapter.statFromNative(file);
                    if (options && options.mtime) this.path.markChangesAreSame(path, stat.mtime, options.mtime);
                    return true;
                }
                await this.adapter.vault.modifyBinary(file, toArrayBuffer(data), options);
                return true;
            });
        }
    }

    async vaultCreate(
        path: string,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ): Promise<ExtractFile<TAdapter>> {
        if (typeof data === "string") {
            return await this._writeOp(path as FilePath, () => this.adapter.vault.create(path, data, options));
        } else {
            return await this._writeOp(path as FilePath, () =>
                this.adapter.vault.createBinary(path, toArrayBuffer(data), options)
            );
        }
    }

    trigger(name: string, ...data: any[]) {
        return this.adapter.vault.trigger(name, ...data);
    }

    async reconcileInternalFile(path: string): Promise<void> {
        return await this.adapter.reconcileInternalFile(path);
    }

    /**
     * Append data to a file using the adapter's append method. This is useful for large files that cannot be read into memory.
     * Please note that this method does not check concurrent modifications.
     * @param normalizedPath
     * @param data
     * @param options
     * @returns
     */
    async adapterAppend(normalizedPath: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        return await this.adapter.storage.append(normalizedPath, data, options);
    }

    async delete(file: ExtractAbstractFile<TAdapter> | ExtractFolder<TAdapter>, force?: boolean): Promise<void> {
        return await this._writeOp(file, async (path, file) => await this.adapter.vault.delete(file, force));
    }

    async trash(file: ExtractAbstractFile<TAdapter> | ExtractFolder<TAdapter>, force?: boolean): Promise<void> {
        return await this._writeOp(file, async (path, file) => await this.adapter.vault.trash(file, force));
    }

    protected isStorageInsensitive(): boolean {
        return this.vaultService.isStorageInsensitive();
    }

    getAbstractFileByPath(path: FilePath | string): ExtractAbstractFile<TAdapter> | null {
        const setting = this.settingService.currentSettings();
        if (!setting.handleFilenameCaseSensitive || this.isStorageInsensitive()) {
            return this.adapter.getAbstractFileByPathInsensitive(path);
        }
        return this.adapter.getAbstractFileByPath(path);
    }

    getFiles(): ExtractFile<TAdapter>[] {
        return this.adapter.getFiles();
    }

    async ensureDirectory(fullPath: string) {
        const pathElements = fullPath.split("/");
        pathElements.pop();
        let c = "";
        for (const v of pathElements) {
            c += v;
            try {
                await this.adapter.storage.mkdir(c);
            } catch (ex: any) {
                if (ex?.message == "Folder already exists.") {
                    // Skip if already exists.
                } else {
                    this._log("Folder Create Error");
                    this._log(ex);
                }
            }
            c += "/";
        }
    }

    async touch(file: ExtractFile<TAdapter> | FilePath): Promise<void> {
        const path = this.getPath(file);
        const statOrg = this.isFile(file) ? file.stat : await this.adapter.storage.stat(path);
        return this.storageAccessManager.touch({ path, stat: statOrg || { ctime: 0, mtime: 0, size: 0 } });
    }

    recentlyTouched(file: ExtractFile<TAdapter> | UXFileInfoStub | FileWithFileStat) {
        const path = (file as any).path as FilePath;
        return this.storageAccessManager.recentlyTouched({ ...file, path });
    }
    clearTouched() {
        return this.storageAccessManager.clearTouched();
    }
}
