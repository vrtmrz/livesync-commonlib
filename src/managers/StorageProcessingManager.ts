import type { FilePathWithPrefix } from "@lib/common/models/db.type";
import type { UXFileInfoStub } from "@lib/common/models/fileaccess.type";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import { serialized } from "octagonal-wheels/concurrency/lock";
import type { FileWithFileStat, FileWithStatAsProp } from "@lib/common/models/fileaccess.type";
const fileLockPrefix = "file-lock:";

export class StorageAccessManager implements IStorageAccessManager {
    processingFiles: Set<FilePathWithPrefix> = new Set();
    processWriteFile<T>(file: UXFileInfoStub | FilePathWithPrefix, proc: () => Promise<T>): Promise<T> {
        const path = typeof file === "string" ? file : file.path;
        return serialized(`${fileLockPrefix}${path}`, async () => {
            try {
                this.processingFiles.add(path);
                return await proc();
            } finally {
                this.processingFiles.delete(path);
            }
        });
    }
    processReadFile<T>(file: UXFileInfoStub | FilePathWithPrefix, proc: () => Promise<T>): Promise<T> {
        const path = typeof file === "string" ? file : file.path;
        return serialized(`${fileLockPrefix}${path}`, async () => {
            try {
                this.processingFiles.add(path);
                return await proc();
            } finally {
                this.processingFiles.delete(path);
            }
        });
    }
    isFileProcessing(file: UXFileInfoStub | FilePathWithPrefix): boolean {
        const path = typeof file === "string" ? file : file.path;
        return this.processingFiles.has(path);
    }
    private touchedFiles: string[] = [];

    touch(file: FileWithFileStat | FileWithStatAsProp): void {
        const key =
            "stat" in file
                ? `${file.path}-${file.stat.mtime}-${file.stat.size}`
                : `${file.path}-${file.mtime}-${file.size}`;
        this.touchedFiles.unshift(key);
        this.touchedFiles = this.touchedFiles.slice(0, 100);
    }

    recentlyTouched(file: FileWithStatAsProp | FileWithFileStat) {
        const key =
            "stat" in file
                ? `${file.path}-${file.stat.mtime}-${file.stat.size}`
                : `${file.path}-${file.mtime}-${file.size}`;
        if (this.touchedFiles.indexOf(key) == -1) return false;
        return true;
    }
    clearTouched() {
        this.touchedFiles = [];
    }
}
