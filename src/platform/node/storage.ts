import { constants as nodeFsConstants } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as nodePath from "node:path";

import type { UXDataWriteOptions, UXStat } from "@lib/common/types.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { validateStoragePath } from "../storagePath.ts";

export type NodeStorageStat = UXStat;

const NO_FOLLOW = (nodeFsConstants as typeof nodeFsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

class SymbolicLinkStoragePathError extends Error {
    constructor(path: string) {
        super(`Storage paths must not contain symbolic links: ${path}`);
        this.name = "SymbolicLinkStoragePathError";
    }
}

export interface CreateNodeStorageOptions {
    /**
     * Host-selected root directory. Adapter paths are resolved relative to this root.
     *
     * The host owns this trust boundary. The adapter is not a filesystem sandbox against
     * an untrusted local process which can replace path components concurrently.
     */
    rootPath: string;
}

/** Rooted storage adapter backed by Node's file-system APIs. */
export class NodeStorageAdapter implements IStorageAdapter<NodeStorageStat> {
    private readonly rootPath: string;

    constructor(rootPath: string) {
        this.rootPath = nodePath.resolve(rootPath);
    }

    private async resolvePath(path: string, allowRoot = true): Promise<string> {
        const fullPath = nodePath.join(this.rootPath, validateStoragePath(path, allowRoot));
        await this.assertNoSymbolicLinks(fullPath);
        return fullPath;
    }

    private async assertNoSymbolicLinks(fullPath: string): Promise<void> {
        const relativePath = nodePath.relative(this.rootPath, fullPath);
        let currentPath = this.rootPath;
        for (const segment of relativePath.split(nodePath.sep).filter(Boolean)) {
            currentPath = nodePath.join(currentPath, segment);
            try {
                const stat = await nodeFsPromises.lstat(currentPath);
                if (stat.isSymbolicLink()) throw new SymbolicLinkStoragePathError(currentPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                throw error;
            }
        }
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = await this.resolvePath(path);
        try {
            await nodeFsPromises.access(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async trystat(path: string): Promise<NodeStorageStat | null> {
        try {
            const stat = await nodeFsPromises.stat(await this.resolvePath(path));
            return {
                size: stat.size,
                mtime: Math.floor(stat.mtimeMs),
                ctime: Math.floor(stat.ctimeMs),
                type: stat.isDirectory() ? "folder" : "file",
            };
        } catch (error) {
            if (error instanceof SymbolicLinkStoragePathError) throw error;
            return null;
        }
    }

    async stat(path: string): Promise<NodeStorageStat | null> {
        return await this.trystat(path);
    }

    async mkdir(path: string): Promise<void> {
        const fullPath = await this.resolvePath(path);
        await nodeFsPromises.mkdir(fullPath, { recursive: true });
        await this.assertNoSymbolicLinks(fullPath);
    }

    async remove(path: string): Promise<void> {
        const fullPath = await this.resolvePath(path, false);
        const stat = await nodeFsPromises.stat(fullPath);
        if (stat.isDirectory()) {
            await nodeFsPromises.rm(fullPath, { recursive: true, force: true });
        } else {
            await nodeFsPromises.unlink(fullPath);
        }
    }

    async read(path: string): Promise<string> {
        const handle = await nodeFsPromises.open(
            await this.resolvePath(path, false),
            nodeFsConstants.O_RDONLY | NO_FOLLOW
        );
        try {
            return await handle.readFile("utf-8");
        } finally {
            await handle.close();
        }
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const handle = await nodeFsPromises.open(
            await this.resolvePath(path, false),
            nodeFsConstants.O_RDONLY | NO_FOLLOW
        );
        try {
            const buffer = await handle.readFile();
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        } finally {
            await handle.close();
        }
    }

    async write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = await this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await this.writeFile(fullPath, data, options, false);
    }

    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = await this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await this.writeFile(fullPath, new Uint8Array(data), options, false);
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = await this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await this.writeFile(fullPath, data, options, true);
    }

    /** Atomically rename or move an entry without leaving the injected root. */
    async rename(sourcePath: string, targetPath: string): Promise<void> {
        const fullSourcePath = await this.resolvePath(sourcePath, false);
        const fullTargetPath = await this.resolvePath(targetPath, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullTargetPath), { recursive: true });
        await this.assertNoSymbolicLinks(fullSourcePath);
        await this.assertNoSymbolicLinks(fullTargetPath);
        await nodeFsPromises.rename(fullSourcePath, fullTargetPath);
    }

    async list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        try {
            const entries = await nodeFsPromises.readdir(await this.resolvePath(basePath), { withFileTypes: true });
            const files: string[] = [];
            const folders: string[] = [];
            for (const entry of entries) {
                const entryPath = nodePath.join(basePath, entry.name).replace(/\\/g, "/");
                if (entry.isDirectory()) folders.push(entryPath);
                else if (entry.isFile()) files.push(entryPath);
            }
            return { files, folders };
        } catch (error) {
            if (error instanceof SymbolicLinkStoragePathError) throw error;
            return { files: [], folders: [] };
        }
    }

    private async writeFile(
        fullPath: string,
        data: string | Uint8Array,
        options: UXDataWriteOptions | undefined,
        append: boolean
    ): Promise<void> {
        await this.assertNoSymbolicLinks(fullPath);
        const flags =
            nodeFsConstants.O_WRONLY |
            nodeFsConstants.O_CREAT |
            NO_FOLLOW |
            (append ? nodeFsConstants.O_APPEND : nodeFsConstants.O_TRUNC);
        const handle = await nodeFsPromises.open(fullPath, flags, 0o666);
        try {
            await handle.writeFile(data, typeof data === "string" ? "utf-8" : undefined);
            await this.applyTimes(handle, options);
        } finally {
            await handle.close();
        }
    }

    private async applyTimes(handle: FileHandle, options?: UXDataWriteOptions): Promise<void> {
        if (!options?.mtime && !options?.ctime) return;
        const accessTime = options.mtime ? new Date(options.mtime) : new Date();
        const modificationTime = options.mtime ? new Date(options.mtime) : new Date();
        await handle.utimes(accessTime, modificationTime);
    }
}

/** Bind a Node storage adapter to an explicitly selected root directory. */
export function createNodeStorage({ rootPath }: CreateNodeStorageOptions): NodeStorageAdapter {
    return new NodeStorageAdapter(rootPath);
}

export { validateStoragePath } from "../storagePath.ts";
