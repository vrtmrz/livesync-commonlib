import type { UXDataWriteOptions, UXStat } from "@lib/common/types.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import type { DirectoryEntry, StoragePath } from "../pathTypes.ts";
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

    private async getStrictDirectoryHandle(path: StoragePath): Promise<FileSystemDirectoryHandle | null> {
        validateStoragePath(path);
        let currentHandle = this.rootHandle;
        for (const part of path.split("/").filter((segment) => segment !== "")) {
            try {
                currentHandle = await currentHandle.getDirectoryHandle(part);
            } catch (error) {
                if (isNamedError(error, "NotFoundError")) return null;
                throw error;
            }
        }
        return currentHandle;
    }

    private async getStrictFileHandle(path: StoragePath): Promise<FileSystemFileHandle | null> {
        validateStoragePath(path, false);
        const parts = path.split("/").filter((part) => part !== "");
        const name = parts.pop()!;
        const dirHandle = await this.getStrictDirectoryHandle(parts.join("/") as StoragePath);
        if (!dirHandle) return null;
        try {
            return await dirHandle.getFileHandle(name);
        } catch (error) {
            if (isNamedError(error, "NotFoundError")) return null;
            throw error;
        }
    }

    private async requireStrictFileHandle(path: StoragePath): Promise<FileSystemFileHandle> {
        const handle = await this.getStrictFileHandle(path);
        if (!handle) throw new Error(`File not found: ${path}`);
        return handle;
    }

    private async getStrictWritableFileHandle(path: StoragePath): Promise<FileSystemFileHandle> {
        validateStoragePath(path, false);
        const parts = path.split("/").filter((part) => part !== "");
        const name = parts.pop()!;
        const parentPath = parts.join("/");
        await this.mkdir(parentPath);
        const dirHandle = await this.getStrictDirectoryHandle(parentPath as StoragePath);
        if (!dirHandle) throw new Error(`Invalid path: ${path}`);
        return await dirHandle.getFileHandle(name, { create: true });
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

    /** Enumerate one directory without converting permission or type errors into absence. */
    async readDirectory(path: StoragePath): Promise<readonly DirectoryEntry[] | null> {
        const dirHandle = await this.getStrictDirectoryHandle(path);
        if (!dirHandle) return null;
        const entries: DirectoryEntry[] = [];
        for await (const [name, entry] of (
            dirHandle as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries()) {
            if (entry.kind === "directory" || entry.kind === "file") {
                entries.push({ name, kind: entry.kind });
            }
        }
        return entries;
    }

    /** Stat a path using its exact physical spelling and preserve non-missing errors. */
    async statResolved(path: StoragePath): Promise<FileSystemAccessStorageStat | null> {
        validateStoragePath(path);
        if (path === "") {
            const now = Date.now();
            return { size: 0, mtime: now, ctime: now, type: "folder" };
        }

        const parts = path.split("/");
        const name = parts.pop()!;
        const parentHandle = await this.getStrictDirectoryHandle(parts.join("/") as StoragePath);
        if (!parentHandle) return null;

        let fileHandle: FileSystemFileHandle;
        try {
            fileHandle = await parentHandle.getFileHandle(name);
        } catch (error) {
            if (isNamedError(error, "NotFoundError")) return null;
            if (!isNamedError(error, "TypeMismatchError")) throw error;
            try {
                await parentHandle.getDirectoryHandle(name);
            } catch (directoryError) {
                if (isNamedError(directoryError, "NotFoundError")) return null;
                throw directoryError;
            }
            const now = Date.now();
            return { size: 0, mtime: now, ctime: now, type: "folder" };
        }

        const file = await fileHandle.getFile();
        return {
            size: file.size,
            mtime: file.lastModified,
            ctime: file.lastModified,
            type: "file",
        };
    }

    /** Read an exact resolved file path while preserving missing, type, and permission errors. */
    async readResolved(path: StoragePath): Promise<string> {
        const handle = await this.requireStrictFileHandle(path);
        return await (await handle.getFile()).text();
    }

    /** Read an exact resolved file path as bytes while preserving host errors. */
    async readBinaryResolved(path: StoragePath): Promise<ArrayBuffer> {
        const handle = await this.requireStrictFileHandle(path);
        return await (await handle.getFile()).arrayBuffer();
    }

    /** Write an exact resolved file path, creating missing parent directories. */
    async writeResolved(path: StoragePath, data: string, _options?: UXDataWriteOptions): Promise<void> {
        const handle = await this.getStrictWritableFileHandle(path);
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    /** Write bytes to an exact resolved file path, creating missing parent directories. */
    async writeBinaryResolved(path: StoragePath, data: ArrayBuffer, _options?: UXDataWriteOptions): Promise<void> {
        const handle = await this.getStrictWritableFileHandle(path);
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    /** Append through strict reads and writes so denied reads cannot become truncating writes. */
    async appendResolved(path: StoragePath, data: string, options?: UXDataWriteOptions): Promise<void> {
        const handle = await this.getStrictFileHandle(path);
        const existing = handle ? await (await handle.getFile()).text() : "";
        await this.writeResolved(path, existing + data, options);
    }

    /** Remove an exact resolved path, retaining the adapter's no-op behaviour when it is absent. */
    async removeResolved(path: StoragePath): Promise<void> {
        validateStoragePath(path, false);
        const parts = path.split("/").filter((part) => part !== "");
        const name = parts.pop()!;
        const dirHandle = await this.getStrictDirectoryHandle(parts.join("/") as StoragePath);
        if (!dirHandle) return;
        try {
            await dirHandle.removeEntry(name, { recursive: true });
        } catch (error) {
            if (isNamedError(error, "NotFoundError")) return;
            throw error;
        }
    }

    /** Create an exact resolved directory path without hiding browser errors. */
    async mkdirResolved(path: StoragePath): Promise<void> {
        await this.mkdir(path);
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

function isNamedError(error: unknown, name: string): boolean {
    return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

export { validateStoragePath } from "../storagePath.ts";
