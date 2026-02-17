import type { FilePathWithPrefix } from "@lib/common/models/db.type";
import type { UXFileInfoStub } from "@lib/common/models/fileaccess.type";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import { serialized } from "octagonal-wheels/concurrency/lock";

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
}
