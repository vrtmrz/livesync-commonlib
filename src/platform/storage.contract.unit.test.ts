import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IStorageAdapter } from "@lib/serviceModules/adapters/IStorageAdapter.ts";
import { createFileSystemAccessStorage } from "./browser/index.ts";
import { createNodeStorage } from "./node/index.ts";

type ContractCase = {
    name: string;
    run(adapter: IStorageAdapter): Promise<void>;
};

async function expectRejected(operation: () => Promise<unknown>): Promise<void> {
    await expect(operation()).rejects.toBeDefined();
}

const contractCases: readonly ContractCase[] = [
    {
        name: "reports missing paths consistently",
        async run(adapter) {
            await expect(adapter.exists("missing.txt")).resolves.toBe(false);
            await expect(adapter.stat("missing.txt")).resolves.toBeNull();
            await expect(adapter.trystat("missing.txt")).resolves.toBeNull();
        },
    },
    {
        name: "creates parent directories and round-trips text and binary data",
        async run(adapter) {
            await adapter.write("notes/nested/note.md", "hello");
            await expect(adapter.read("notes/nested/note.md")).resolves.toBe("hello");
            const expected = Uint8Array.from([0x00, 0x7f, 0x80, 0xff, 0x42]);
            await adapter.writeBinary("binary/blob.bin", expected.buffer.slice(0));
            const actual = await adapter.readBinary("binary/blob.bin");
            expect([...new Uint8Array(actual)]).toEqual([...expected]);
            expect(actual.byteLength).toBe(expected.byteLength);
        },
    },
    {
        name: "creates and extends text through append",
        async run(adapter) {
            await adapter.append("logs/events.log", "first");
            await adapter.append("logs/events.log", ":second");
            await expect(adapter.read("logs/events.log")).resolves.toBe("first:second");
        },
    },
    {
        name: "lists and removes direct entries",
        async run(adapter) {
            await adapter.mkdir("listing/folder");
            await adapter.write("listing/file.txt", "content");
            const listed = await adapter.list("listing");
            expect([...listed.files].sort()).toEqual(["listing/file.txt"]);
            expect([...listed.folders].sort()).toEqual(["listing/folder"]);
            await adapter.remove("listing/folder");
            await adapter.remove("listing/file.txt");
            await expect(adapter.list("listing")).resolves.toEqual({ files: [], folders: [] });
        },
    },
    {
        name: "contains all operations inside the injected root",
        async run(adapter) {
            await expectRejected(() => adapter.exists("../outside"));
            await expectRejected(() => adapter.write("nested/../outside", "content"));
            await expectRejected(() => adapter.read("/absolute"));
            await expectRejected(() => adapter.read("C:\\absolute"));
            await expectRejected(() => adapter.read("nested\\outside"));
            await expectRejected(() => adapter.remove(""));
        },
    },
    {
        name: "uses the empty path only for root-safe operations",
        async run(adapter) {
            await adapter.mkdir("");
            await expect(adapter.exists("")).resolves.toBe(true);
            await expect(adapter.stat("")).resolves.toEqual(expect.objectContaining({ type: "folder" }));
            await expect(adapter.list("")).resolves.toEqual({ files: [], folders: [] });
            await expectRejected(() => adapter.write("", "content"));
            await expectRejected(() => adapter.append("", "content"));
        },
    },
];

class MemoryFileHandle {
    readonly kind = "file";
    private data = new Uint8Array();

    constructor(readonly name: string) {}

    async getFile(): Promise<File> {
        return new File([this.data], this.name, { lastModified: 1 });
    }

    async createWritable(): Promise<FileSystemWritableFileStream> {
        const handle = this;
        return {
            async write(data: FileSystemWriteChunkType) {
                if (typeof data === "string") handle.data = new TextEncoder().encode(data);
                else if (data instanceof ArrayBuffer) handle.data = new Uint8Array(data.slice(0));
                else if (ArrayBuffer.isView(data)) {
                    handle.data = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                } else throw new TypeError("Unsupported in-memory write type");
            },
            async close() {},
        } as FileSystemWritableFileStream;
    }
}

class MemoryDirectoryHandle {
    readonly kind = "directory";
    private readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

    constructor(readonly name: string) {}

    async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions
    ): Promise<FileSystemDirectoryHandle> {
        const existing = this.children.get(name);
        if (existing instanceof MemoryDirectoryHandle) return existing as unknown as FileSystemDirectoryHandle;
        if (existing !== undefined || !options?.create) throw new DOMException("Directory not found", "NotFoundError");
        const directory = new MemoryDirectoryHandle(name);
        this.children.set(name, directory);
        return directory as unknown as FileSystemDirectoryHandle;
    }

    async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
        const existing = this.children.get(name);
        if (existing instanceof MemoryFileHandle) return existing as unknown as FileSystemFileHandle;
        if (existing !== undefined || !options?.create) throw new DOMException("File not found", "NotFoundError");
        const file = new MemoryFileHandle(name);
        this.children.set(name, file);
        return file as unknown as FileSystemFileHandle;
    }

    async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
        const existing = this.children.get(name);
        if (existing === undefined) throw new DOMException("Entry not found", "NotFoundError");
        if (existing instanceof MemoryDirectoryHandle && !options?.recursive && existing.children.size > 0) {
            throw new DOMException("Directory is not empty", "InvalidModificationError");
        }
        this.children.delete(name);
    }

    async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
        for (const [name, entry] of this.children) yield [name, entry as unknown as FileSystemHandle];
    }
}

describe("rooted storage adapters", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            temporaryDirectories.splice(0).map((path) => nodeFs.rm(path, { recursive: true, force: true }))
        );
    });

    for (const contractCase of contractCases) {
        it(`Node: ${contractCase.name}`, async () => {
            const rootPath = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "commonlib-storage-"));
            temporaryDirectories.push(rootPath);
            await contractCase.run(createNodeStorage({ rootPath }));
        });

        it(`File System Access: ${contractCase.name}`, async () => {
            const rootHandle = new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle;
            await contractCase.run(createFileSystemAccessStorage({ rootHandle }));
        });
    }

    it("Node: rejects writes through a symbolic link which leaves the injected root", async () => {
        const rootPath = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "commonlib-storage-"));
        const outsidePath = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "commonlib-storage-outside-"));
        temporaryDirectories.push(rootPath, outsidePath);
        await nodeFs.writeFile(nodePath.join(outsidePath, "victim.txt"), "before", "utf8");
        await nodeFs.symlink(
            outsidePath,
            nodePath.join(rootPath, "linked"),
            process.platform === "win32" ? "junction" : "dir"
        );

        const adapter = createNodeStorage({ rootPath });

        await expect(adapter.write("linked/victim.txt", "after")).rejects.toThrow(/symbolic link/i);
        await expect(nodeFs.readFile(nodePath.join(outsidePath, "victim.txt"), "utf8")).resolves.toBe("before");
    });

    it("Node: renames entries atomically without following symbolic links", async () => {
        const rootPath = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "commonlib-storage-"));
        const outsidePath = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "commonlib-storage-outside-"));
        temporaryDirectories.push(rootPath, outsidePath);
        await nodeFs.writeFile(nodePath.join(rootPath, "source.txt"), "content", "utf8");
        await nodeFs.symlink(
            outsidePath,
            nodePath.join(rootPath, "linked"),
            process.platform === "win32" ? "junction" : "dir"
        );
        const adapter = createNodeStorage({ rootPath });

        await adapter.rename("source.txt", "renamed.txt");
        await expect(adapter.read("renamed.txt")).resolves.toBe("content");
        await expect(adapter.rename("renamed.txt", "linked/moved.txt")).rejects.toThrow(/symbolic link/i);
        await expect(adapter.read("renamed.txt")).resolves.toBe("content");
        await expect(nodeFs.stat(nodePath.join(outsidePath, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    });
});
