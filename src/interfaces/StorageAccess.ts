import type {
    FilePath,
    FilePathWithPrefix,
    UXDataWriteOptions,
    UXFileInfo,
    UXFileInfoStub,
    UXFolderInfo,
    UXStat,
} from "@lib/common/types";
import type { CustomRegExp } from "@lib/common/utils";
import type { FileWithFileStat, FileWithStatAsProp } from "@lib/common/models/fileaccess.type";
import type { FileNameLookup } from "@lib/platform/FilePathIndex.ts";
export interface IStorageAccessManager {
    processWriteFile<T>(file: UXFileInfoStub | FilePathWithPrefix, proc: () => Promise<T>): Promise<T>;
    processReadFile<T>(file: UXFileInfoStub | FilePathWithPrefix, proc: () => Promise<T>): Promise<T>;
    isFileProcessing(file: UXFileInfoStub | FilePathWithPrefix): boolean;
    recentlyTouched(file: FileWithStatAsProp | FileWithFileStat): boolean;
    touch(file: FileWithStatAsProp | FileWithFileStat): void;
    clearTouched(): void;
}
/**
 * Storage facade with the shared name-query contract available on every host.
 *
 * An adapter can omit its indexed lookup capability; the service facade supplies
 * the base fallback while retaining the FileNameLookup method contract.
 */
export interface StorageAccess extends FileNameLookup {
    normalisePath(path: string): string;

    restoreState(): Promise<void>;

    /** Includes queued, running, and failed work; absence requires a conservative content check. */
    hasPendingFileEvent?(path: FilePath): boolean;

    deleteVaultItem(file: FilePathWithPrefix | UXFileInfoStub | UXFolderInfo): Promise<void>;

    renameFile(file: UXFileInfoStub | FilePathWithPrefix, newPath: FilePathWithPrefix): Promise<UXFileInfoStub | null>;

    writeFileAuto(path: string, data: string | ArrayBuffer, opt?: UXDataWriteOptions): Promise<boolean>;

    readFileAuto(path: string): Promise<string | ArrayBuffer>;
    readFileText(path: string): Promise<string>;
    isExists(path: string): Promise<boolean>;
    writeHiddenFileAuto(path: string, data: string | ArrayBuffer, opt?: UXDataWriteOptions): Promise<boolean>;
    appendHiddenFile(path: string, data: string, opt?: UXDataWriteOptions): Promise<boolean>;

    stat(path: string): Promise<UXStat | null>;
    statHidden(path: string): Promise<UXStat | null>;
    removeHidden(path: string): Promise<boolean>;
    readHiddenFileAuto(path: string): Promise<string | ArrayBuffer>;
    readHiddenFileBinary(path: string): Promise<ArrayBuffer>;
    readHiddenFileText(path: string): Promise<string>;
    isExistsIncludeHidden(path: string): Promise<boolean>;
    // This could be work also for the hidden files.
    ensureDir(path: string): Promise<boolean>;
    triggerFileEvent(event: string, path: string): void;
    triggerHiddenFile(path: string): Promise<void>;

    getFileStub(path: string): Promise<UXFileInfoStub | null>;
    readStubContent(stub: UXFileInfoStub): Promise<UXFileInfo | false>;
    getStub(path: string): Promise<UXFileInfoStub | UXFolderInfo | null>;

    getFiles(): Promise<UXFileInfoStub[]>;

    touched(file: UXFileInfoStub | FilePathWithPrefix): Promise<void>;
    recentlyTouched(file: UXFileInfoStub | FilePathWithPrefix): Promise<boolean>;
    clearTouched(): void;

    // -- Low-Level
    delete(file: FilePathWithPrefix | UXFileInfoStub | string, force: boolean): Promise<void>;
    trash(file: FilePathWithPrefix | UXFileInfoStub | string, system: boolean): Promise<void>;

    getFilesIncludeHidden(
        basePath: string,
        includeFilter?: CustomRegExp[],
        excludeFilter?: CustomRegExp[],
        skipFolder?: string[]
    ): Promise<FilePath[]>;
}
