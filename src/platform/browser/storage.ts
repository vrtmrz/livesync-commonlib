import type { UXDataWriteOptions, UXStat } from "@lib/common/types.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { validateStoragePath } from "../storagePath.ts";

export type FileSystemAccessStorageStat = UXStat;

export interface CreateFileSystemAccessStorageOptions {
    /** A directory handle already selected and authorised by the host application. */
    rootHandle: FileSystemDirectoryHandle;
}

/** Rooted storage adapter backed by the browser File System Access API. */
export class FileSystemAccessStorageAdapter implements IStorageAdapter<FileSystemAccessStorageStat> {
    constructor(private readonly rootHandle: FileSystemDirectoryHandle) {}

    private async resolvePath(
        path: string
    ): Promise<{ dirHandle: FileSystemDirectoryHandle; fileName: string } | null> {
        validateStoragePath(path, false);
        try {
            const parts = path.split("/").filter((part) => part !== "");
            let currentHandle = this.rootHandle;
            const fileName = parts[parts.length - 1];
            for (let index = 0; index < parts.length - 1; index++) {
                currentHandle = await currentHandle.getDirectoryHandle(parts[index]);
            }
            return { dirHandle: currentHandle, fileName };
        } catch {
            return null;
        }
    }

    private async getFileHandle(path: string): Promise<FileSystemFileHandle | null> {
        validateStoragePath(path);
        if (path === "") return null;
        const resolved = await this.resolvePath(path);
        if (!resolved) return null;
        try {
            return await resolved.dirHandle.getFileHandle(resolved.fileName);
        } catch {
            return null;
        }
    }

    private async getDirectoryHandle(path: string): Promise<FileSystemDirectoryHandle | null> {
        validateStoragePath(path);
        try {
            const parts = path.split("/").filter((part) => part !== "");
            let currentHandle = this.rootHandle;
            for (const part of parts) currentHandle = await currentHandle.getDirectoryHandle(part);
            return currentHandle;
        } catch {
            return null;
        }
    }

    private async resolveWritablePath(
        path: string
    ): Promise<{ dirHandle: FileSystemDirectoryHandle; fileName: string } | null> {
        validateStoragePath(path, false);
        const parts = path.split("/").filter((part) => part !== "");
        const fileName = parts.pop()!;
        const parentPath = parts.join("/");
        await this.mkdir(parentPath);
        const dirHandle = await this.getDirectoryHandle(parentPath);
        return dirHandle ? { dirHandle, fileName } : null;
    }

    async exists(path: string): Promise<boolean> {
        return (await this.getFileHandle(path)) !== null || (await this.getDirectoryHandle(path)) !== null;
    }

    async trystat(path: string): Promise<FileSystemAccessStorageStat | null> {
        const fileHandle = await this.getFileHandle(path);
        if (fileHandle) {
            const file = await fileHandle.getFile();
            return {
                size: file.size,
                mtime: file.lastModified,
                ctime: file.lastModified,
                type: "file",
            };
        }
        if (await this.getDirectoryHandle(path)) {
            return { size: 0, mtime: Date.now(), ctime: Date.now(), type: "folder" };
        }
        return null;
    }

    async stat(path: string): Promise<FileSystemAccessStorageStat | null> {
        return await this.trystat(path);
    }

    async mkdir(path: string): Promise<void> {
        validateStoragePath(path);
        let currentHandle = this.rootHandle;
        for (const part of path.split("/").filter((part) => part !== "")) {
            currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
        }
    }

    async remove(path: string): Promise<void> {
        const resolved = await this.resolvePath(path);
        if (!resolved) return;
        await resolved.dirHandle.removeEntry(resolved.fileName, { recursive: true });
    }

    async read(path: string): Promise<string> {
        const handle = await this.requireFileHandle(path);
        return await (await handle.getFile()).text();
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const handle = await this.requireFileHandle(path);
        return await (await handle.getFile()).arrayBuffer();
    }

    async write(path: string, data: string, _options?: UXDataWriteOptions): Promise<void> {
        await this.writeValue(path, data);
    }

    async writeBinary(path: string, data: ArrayBuffer, _options?: UXDataWriteOptions): Promise<void> {
        await this.writeValue(path, data);
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        await this.write(path, (await this.exists(path)) ? (await this.read(path)) + data : data, options);
    }

    async list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        const dirHandle = await this.getDirectoryHandle(basePath);
        if (!dirHandle) return { files: [], folders: [] };
        const files: string[] = [];
        const folders: string[] = [];
        for await (const [name, entry] of (
            dirHandle as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries()) {
            const entryPath = basePath ? `${basePath}/${name}` : name;
            if (entry.kind === "directory") folders.push(entryPath);
            else if (entry.kind === "file") files.push(entryPath);
        }
        return { files, folders };
    }

    private async requireFileHandle(path: string): Promise<FileSystemFileHandle> {
        const handle = await this.getFileHandle(path);
        if (!handle) throw new Error(`File not found: ${path}`);
        return handle;
    }

    private async writeValue(path: string, data: string | ArrayBuffer): Promise<void> {
        const resolved = await this.resolveWritablePath(path);
        if (!resolved) throw new Error(`Invalid path: ${path}`);
        const handle = await resolved.dirHandle.getFileHandle(resolved.fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    }
}

/** Bind a browser storage adapter to an explicitly selected and authorised directory handle. */
export function createFileSystemAccessStorage({
    rootHandle,
}: CreateFileSystemAccessStorageOptions): FileSystemAccessStorageAdapter {
    return new FileSystemAccessStorageAdapter(rootHandle);
}

export { validateStoragePath } from "../storagePath.ts";
