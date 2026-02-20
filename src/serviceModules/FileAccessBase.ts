import { isPlainText } from "@lib/string_and_binary/path.ts";
import type { FilePath, UXDataWriteOptions, UXFileInfoStub, UXFolderInfo, UXStat } from "@lib/common/types.ts";
import { createBinaryBlob, isDocContentSame } from "@lib/common/utils.ts";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess.ts";
import type { IAPIService, ISettingService, IVaultService } from "@lib/services/base/IService.ts";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils.ts";
import type { FileWithFileStat } from "../common/models/fileaccess.type";

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
    APIService: IAPIService;
}

export interface AbstractInfo {
    parent: AbstractFolder | null;
    path: string;
}

export interface AbstractFile extends AbstractInfo {
    stat: Omit<UXStat, "type">;
}
export interface AbstractFolder<TItems extends AbstractInfo = AbstractInfo> extends AbstractInfo {
    children: TItems[];
}

export abstract class FileAccessBase<
    TNativeAbstractFile extends AbstractInfo = AbstractInfo,
    TNativeFile extends TNativeAbstractFile & AbstractFile = TNativeAbstractFile & AbstractFile,
    TNativeFolder extends TNativeAbstractFile & AbstractFolder<TNativeAbstractFile> = TNativeAbstractFile &
        AbstractFolder<TNativeAbstractFile>,
    TStat extends UXStat = UXStat,
> {
    protected storageAccessManager: IStorageAccessManager;
    protected vaultService: IVaultService;
    protected settingService: ISettingService;
    protected APIService: IAPIService;

    _log: ReturnType<typeof createInstanceLogFunction>;

    // The following methods must be implemented by the subclass to provide the actual file access logic.

    abstract isFile(
        file: UXFileInfoStub | TNativeAbstractFile | FilePath | TNativeFolder | TNativeFile | null
    ): file is TNativeFile;
    abstract isFolder(
        item: UXFileInfoStub | TNativeAbstractFile | FilePath | TNativeFolder | TNativeFile | null
    ): item is TNativeFolder;
    protected abstract markChangesAreSame(path: string, mtime: number, newMtime: number): void;
    abstract getPath(file: TNativeAbstractFile | string): FilePath;

    abstract nativeFileToUXFileInfoStub(file: TNativeFile): UXFileInfoStub;
    abstract nativeFolderToUXFolder(file: TNativeFolder): UXFolderInfo;

    protected abstract _normalisePath(path: string): string;
    protected abstract _trash(file: TNativeAbstractFile, force?: boolean): Promise<void>;
    protected abstract _getAbstractFileByPathInsensitive(path: FilePath | string): TNativeAbstractFile | null;
    protected abstract _getAbstractFileByPath(path: FilePath | string): TNativeAbstractFile | null;
    protected abstract _getFiles(): TNativeFile[];
    protected abstract _adapterMkdir(path: string): Promise<void>;

    protected abstract _delete(file: TNativeAbstractFile, force?: boolean): Promise<void>;

    protected abstract _reconcileInternalFile(path: string): Promise<void>;
    protected abstract _trigger(name: string, ...data: any[]): any;
    protected abstract _vaultModify(file: TNativeFile, data: string, options?: UXDataWriteOptions): Promise<void>;
    protected abstract _vaultModifyBinary(
        file: TNativeFile,
        data: ArrayBuffer,
        options?: UXDataWriteOptions
    ): Promise<void>;
    protected abstract _vaultCreate(path: string, data: string, options?: UXDataWriteOptions): Promise<TNativeFile>;
    protected abstract _vaultCreateBinary(
        path: string,
        data: ArrayBuffer,
        options?: UXDataWriteOptions
    ): Promise<TNativeFile>;

    protected abstract _statFromNative(file: TNativeFile): Promise<TNativeFile["stat"]>;

    protected abstract _vaultRead(file: TNativeFile): Promise<string>;
    protected abstract _vaultCacheRead(file: TNativeFile): Promise<string>;
    protected abstract _vaultReadBinary(file: TNativeFile): Promise<ArrayBuffer>;

    protected abstract _adapterReadBinary(file: string): Promise<ArrayBuffer>;

    protected abstract _adapterAppend(
        normalizedPath: string,
        data: string,
        options?: UXDataWriteOptions
    ): Promise<void>;

    protected abstract _adapterWrite(file: string, data: string, options?: UXDataWriteOptions): Promise<void>;
    protected abstract _adapterWriteBinary(
        file: string,
        data: ArrayBuffer,
        options?: UXDataWriteOptions
    ): Promise<void>;
    protected abstract _tryAdapterStat(file: string): Promise<TStat | null>;
    protected abstract _adapterStat(file: string): Promise<TStat | null>;
    protected abstract _adapterExists(file: TNativeFile | string): Promise<boolean>;
    protected abstract _adapterRemove(file: string): Promise<void>;
    protected abstract _adapterRead(file: string): Promise<string>;

    protected abstract _adapterList(basePath: string): Promise<{ files: string[]; folders: string[] }>;

    // Default implementations. Probably should not be overridden, but can be if necessary.
    constructor(dependencies: FileAccessBaseDependencies) {
        this.storageAccessManager = dependencies.storageAccessManager;
        this.vaultService = dependencies.vaultService;
        this.settingService = dependencies.settingService;
        this.APIService = dependencies.APIService;
        this._log = createInstanceLogFunction("FileAccess", this.APIService);
    }

    normalisePath(path: string): string {
        return this._normalisePath(path);
    }

    protected _writeOp<T extends TNativeAbstractFile | string, U>(
        file: T,
        callback: (path: FilePath, file: T) => Promise<U>
    ): Promise<U> {
        const path = this.getPath(file);
        return this.storageAccessManager.processWriteFile(path, async () => await callback(path, file));
    }

    protected _readOp<T extends TNativeAbstractFile | string, U>(
        file: T,
        callback: (path: FilePath, file: T) => Promise<U>
    ): Promise<U> {
        const path = this.getPath(file);
        return this.storageAccessManager.processReadFile(path, async () => await callback(path, file));
    }

    async tryAdapterStat(file: TNativeFile | string) {
        return await this._readOp(file, async (path) => await this._tryAdapterStat(path));
    }

    async adapterStat(file: TNativeFile | string): Promise<TStat | null> {
        return await this._readOp(file, async (path) => await this._adapterStat(path));
    }

    async adapterExists(file: TNativeFile | string): Promise<boolean> {
        return await this._readOp(file, async (path) => await this._adapterExists(path));
    }

    async adapterRemove(file: TNativeFile | string): Promise<void> {
        return await this._writeOp(file, async (path) => await this._adapterRemove(path));
    }

    async adapterRead(file: TNativeFile | string): Promise<string> {
        return await this._readOp(file, async (path) => await this._adapterRead(path));
    }

    async adapterReadBinary(file: TNativeFile | string): Promise<ArrayBuffer> {
        return await this._readOp(file, async (path) => await this._adapterReadBinary(path));
    }

    async adapterReadAuto(file: TNativeFile | string): Promise<string | ArrayBuffer> {
        const path = this.getPath(file);
        if (isPlainText(path)) {
            return await this._readOp(file, async (path) => await this._adapterRead(path));
        }
        return await this._readOp(file, async (path) => await this._adapterReadBinary(path));
    }

    async adapterWrite(
        file: TNativeFile | string,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ): Promise<void> {
        if (typeof data === "string") {
            return await this._writeOp(file, async (path) => await this._adapterWrite(path, data, options));
        } else {
            return await this._writeOp(
                file,
                async (path) => await this._adapterWriteBinary(path, toArrayBuffer(data), options)
            );
        }
    }

    adapterList(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        return this._adapterList(basePath);
    }

    async vaultCacheRead(file: TNativeFile): Promise<string> {
        return await this._readOp(file, async (path) => await this._vaultCacheRead(file));
    }

    vaultRead(file: TNativeFile): Promise<string> {
        return this._readOp(file, async (path) => await this._vaultRead(file));
    }

    vaultReadBinary(file: TNativeFile): Promise<ArrayBuffer> {
        return this._readOp(file, async (path) => await this._vaultReadBinary(file));
    }

    async vaultReadAuto(file: TNativeFile) {
        const path = this.getPath(file);
        if (isPlainText(path)) {
            return await this._readOp(path, async (path) => await this._vaultRead(file));
        }
        return await this._readOp(path, async (path) => await this._vaultReadBinary(file));
    }

    async vaultModify(
        file: TNativeFile,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ) {
        if (typeof data === "string") {
            return await this._writeOp(file, async (path) => {
                const oldData = await this._vaultRead(file);
                if (data === oldData) {
                    const stat = await this._statFromNative(file);
                    if (options && options.mtime) this.markChangesAreSame(path, stat.mtime, options.mtime);
                    return true;
                }
                await this._vaultModify(file, data, options);
                return true;
            });
        } else {
            return await this._writeOp(file, async (path) => {
                const oldData = await this._vaultReadBinary(file);
                if (await isDocContentSame(createBinaryBlob(oldData), createBinaryBlob(data))) {
                    const stat = await this._statFromNative(file);
                    if (options && options.mtime) this.markChangesAreSame(path, stat.mtime, options.mtime);
                    return true;
                }
                await this._vaultModifyBinary(file, toArrayBuffer(data), options);
                return true;
            });
        }
    }

    async vaultCreate(
        path: string,
        data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
        options?: UXDataWriteOptions
    ): Promise<TNativeFile> {
        if (typeof data === "string") {
            return await this._writeOp(path as FilePath, () => this._vaultCreate(path, data, options));
        } else {
            return await this._writeOp(path as FilePath, () =>
                this._vaultCreateBinary(path, toArrayBuffer(data), options)
            );
        }
    }

    trigger(name: string, ...data: any[]) {
        return this._trigger(name, ...data);
    }

    async reconcileInternalFile(path: string): Promise<void> {
        return await this._reconcileInternalFile(path);
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
        return await this._adapterAppend(normalizedPath, data, options);
    }

    async delete(file: TNativeAbstractFile, force?: boolean): Promise<void> {
        return await this._writeOp(file, async (path, file) => await this._delete(file, force));
    }

    async trash(file: TNativeAbstractFile, force?: boolean): Promise<void> {
        return await this._writeOp(file, async (path, file) => await this._trash(file, force));
    }

    protected isStorageInsensitive(): boolean {
        return this.vaultService.isStorageInsensitive();
    }

    getAbstractFileByPath(path: FilePath | string): TNativeAbstractFile | null {
        const setting = this.settingService.currentSettings();
        if (!setting.handleFilenameCaseSensitive || this.isStorageInsensitive()) {
            return this._getAbstractFileByPathInsensitive(path);
        }
        return this._getAbstractFileByPath(path);
    }

    getFiles(): TNativeFile[] {
        return this._getFiles();
    }

    async ensureDirectory(fullPath: string) {
        const pathElements = fullPath.split("/");
        pathElements.pop();
        let c = "";
        for (const v of pathElements) {
            c += v;
            try {
                await this._adapterMkdir(c);
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

    async touch(file: TNativeFile | FilePath): Promise<void> {
        const path = this.getPath(file);
        const statOrg = this.isFile(file) ? file.stat : await this._adapterStat(path);
        return this.storageAccessManager.touch({ path, stat: statOrg || { ctime: 0, mtime: 0, size: 0 } });
    }

    recentlyTouched(file: TNativeFile | UXFileInfoStub | FileWithFileStat) {
        return this.storageAccessManager.recentlyTouched({ ...file, path: file.path as FilePath });
    }
    clearTouched() {
        return this.storageAccessManager.clearTouched();
    }
}
