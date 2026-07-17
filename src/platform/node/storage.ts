import * as nodeFsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import type { UXDataWriteOptions, UXStat } from "@lib/common/types.ts";
import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { validateStoragePath } from "../storagePath.ts";

export type NodeStorageStat = UXStat;

export interface CreateNodeStorageOptions {
    /** Absolute or process-relative directory which bounds every adapter operation. */
    rootPath: string;
}

/** Rooted storage adapter backed by Node's file-system APIs. */
export class NodeStorageAdapter implements IStorageAdapter<NodeStorageStat> {
    constructor(private readonly rootPath: string) {}

    private resolvePath(path: string, allowRoot = true): string {
        return nodePath.join(this.rootPath, validateStoragePath(path, allowRoot));
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = this.resolvePath(path);
        try {
            await nodeFsPromises.access(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    async trystat(path: string): Promise<NodeStorageStat | null> {
        try {
            const stat = await nodeFsPromises.stat(this.resolvePath(path));
            return {
                size: stat.size,
                mtime: Math.floor(stat.mtimeMs),
                ctime: Math.floor(stat.ctimeMs),
                type: stat.isDirectory() ? "folder" : "file",
            };
        } catch {
            return null;
        }
    }

    async stat(path: string): Promise<NodeStorageStat | null> {
        return await this.trystat(path);
    }

    async mkdir(path: string): Promise<void> {
        await nodeFsPromises.mkdir(this.resolvePath(path), { recursive: true });
    }

    async remove(path: string): Promise<void> {
        const fullPath = this.resolvePath(path, false);
        const stat = await nodeFsPromises.stat(fullPath);
        if (stat.isDirectory()) {
            await nodeFsPromises.rm(fullPath, { recursive: true, force: true });
        } else {
            await nodeFsPromises.unlink(fullPath);
        }
    }

    async read(path: string): Promise<string> {
        return await nodeFsPromises.readFile(this.resolvePath(path, false), "utf-8");
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const buffer = await nodeFsPromises.readFile(this.resolvePath(path, false));
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    }

    async write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await nodeFsPromises.writeFile(fullPath, data, "utf-8");
        await this.applyTimes(fullPath, options);
    }

    async writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await nodeFsPromises.writeFile(fullPath, new Uint8Array(data));
        await this.applyTimes(fullPath, options);
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const fullPath = this.resolvePath(path, false);
        await nodeFsPromises.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await nodeFsPromises.appendFile(fullPath, data, "utf-8");
        await this.applyTimes(fullPath, options);
    }

    async list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        try {
            const entries = await nodeFsPromises.readdir(this.resolvePath(basePath), { withFileTypes: true });
            const files: string[] = [];
            const folders: string[] = [];
            for (const entry of entries) {
                const entryPath = nodePath.join(basePath, entry.name).replace(/\\/g, "/");
                if (entry.isDirectory()) folders.push(entryPath);
                else if (entry.isFile()) files.push(entryPath);
            }
            return { files, folders };
        } catch {
            return { files: [], folders: [] };
        }
    }

    private async applyTimes(fullPath: string, options?: UXDataWriteOptions): Promise<void> {
        if (!options?.mtime && !options?.ctime) return;
        const accessTime = options.mtime ? new Date(options.mtime) : new Date();
        const modificationTime = options.mtime ? new Date(options.mtime) : new Date();
        await nodeFsPromises.utimes(fullPath, accessTime, modificationTime);
    }
}

/** Bind a Node storage adapter to an explicitly selected root directory. */
export function createNodeStorage({ rootPath }: CreateNodeStorageOptions): NodeStorageAdapter {
    return new NodeStorageAdapter(rootPath);
}

export { validateStoragePath } from "../storagePath.ts";
