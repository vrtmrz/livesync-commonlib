import { describe, expect, it } from "vitest";

import { parseFilePath } from "../pathComparison.ts";
import { AmbiguousNormalisedPathError } from "../storagePathResolution.ts";
import type { StoragePath } from "../pathTypes.ts";
import { FileSystemAccessStorageAdapter } from "./storage.ts";
import { UnicodeResolvingFileSystemAccessStorageAdapter } from "./UnicodeResolvingFileSystemAccessStorageAdapter.ts";

class MemoryFileHandle {
    readonly kind = "file";
    private data: Uint8Array;
    getFileError: unknown;

    constructor(
        readonly name: string,
        data = ""
    ) {
        this.data = new TextEncoder().encode(data);
    }

    async getFile(): Promise<File> {
        if (this.getFileError) throw this.getFileError;
        const copy = new Uint8Array(this.data.byteLength);
        copy.set(this.data);
        return new File([copy.buffer], this.name, { lastModified: 1 });
    }

    async createWritable(): Promise<FileSystemWritableFileStream> {
        const handle = this;
        return {
            async write(data: FileSystemWriteChunkType) {
                if (typeof data === "string") handle.data = new TextEncoder().encode(data);
                else if (data instanceof ArrayBuffer) handle.data = new Uint8Array(data.slice(0));
                else if (ArrayBuffer.isView(data)) {
                    handle.data = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                } else if (data instanceof Blob) {
                    handle.data = new Uint8Array(await data.arrayBuffer());
                } else {
                    throw new TypeError("Unsupported in-memory write type");
                }
            },
            async close() {},
        } as FileSystemWritableFileStream;
    }

    async text(): Promise<string> {
        return new TextDecoder().decode(this.data);
    }
}

class MemoryDirectoryHandle {
    readonly kind = "directory";
    readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
    entriesError: unknown;
    readonly directoryLookupErrors = new Map<string, { afterCalls: number; error: unknown }>();
    private readonly directoryLookupCounts = new Map<string, number>();
    readonly fileLookupErrors = new Map<string, { allowCreate: boolean; error: unknown }>();

    constructor(readonly name: string) {}

    addDirectory(name: string): MemoryDirectoryHandle {
        const child = new MemoryDirectoryHandle(name);
        this.children.set(name, child);
        return child;
    }

    addFile(name: string, content = ""): MemoryFileHandle {
        const child = new MemoryFileHandle(name, content);
        this.children.set(name, child);
        return child;
    }

    async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions
    ): Promise<FileSystemDirectoryHandle> {
        const calls = (this.directoryLookupCounts.get(name) ?? 0) + 1;
        this.directoryLookupCounts.set(name, calls);
        const failure = this.directoryLookupErrors.get(name);
        if (failure && calls > failure.afterCalls) throw failure.error;
        const existing = this.children.get(name);
        if (existing instanceof MemoryDirectoryHandle) return existing as unknown as FileSystemDirectoryHandle;
        if (existing !== undefined) throw new DOMException("Entry is a file", "TypeMismatchError");
        if (!options?.create) throw new DOMException("Directory not found", "NotFoundError");
        return this.addDirectory(name) as unknown as FileSystemDirectoryHandle;
    }

    async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
        const failure = this.fileLookupErrors.get(name);
        if (failure && (!options?.create || !failure.allowCreate)) throw failure.error;
        const existing = this.children.get(name);
        if (existing instanceof MemoryFileHandle) return existing as unknown as FileSystemFileHandle;
        if (existing !== undefined) throw new DOMException("Entry is a directory", "TypeMismatchError");
        if (!options?.create) throw new DOMException("File not found", "NotFoundError");
        return this.addFile(name) as unknown as FileSystemFileHandle;
    }

    async removeEntry(name: string, _options?: FileSystemRemoveOptions): Promise<void> {
        if (!this.children.delete(name)) throw new DOMException("Entry not found", "NotFoundError");
    }

    async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
        if (this.entriesError) throw this.entriesError;
        for (const [name, entry] of this.children) yield [name, entry as unknown as FileSystemHandle];
    }
}

function asStoragePath(path: string): StoragePath {
    return path as StoragePath;
}

function browserAdapter(
    root: MemoryDirectoryHandle,
    version: () => number = () => 1,
    isCaseInsensitive: () => boolean = () => false
): UnicodeResolvingFileSystemAccessStorageAdapter {
    return new UnicodeResolvingFileSystemAccessStorageAdapter(
        root as unknown as FileSystemDirectoryHandle,
        version,
        isCaseInsensitive
    );
}

describe("File System Access storage path resolution", () => {
    it("resolves NFD files and parents for reads, updates, stats, and removals", async () => {
        const root = new MemoryDirectoryHandle("root");
        const physicalParent = "café".normalize("NFD");
        const physicalName = "naïve.md".normalize("NFD");
        const parent = root.addDirectory(physicalParent);
        parent.addFile(physicalName, "before");
        const adapter = browserAdapter(root);

        await expect(adapter.read("café/naïve.md")).resolves.toBe("before");
        await expect(adapter.exists("café/naïve.md")).resolves.toBe(true);
        await expect(adapter.stat("café/naïve.md")).resolves.toEqual(expect.objectContaining({ type: "file" }));
        await expect(adapter.list("café")).resolves.toEqual({
            files: [physicalParent + "/" + physicalName],
            folders: [],
        });
        await expect(adapter.statExact(asStoragePath(physicalParent + "/" + physicalName))).resolves.toEqual(
            expect.objectContaining({ type: "file" })
        );
        await adapter.write("café/naïve.md", "after");
        await expect((parent.children.get(physicalName) as MemoryFileHandle).text()).resolves.toBe("after");
        await adapter.remove("café/naïve.md");
        expect(parent.children.has(physicalName)).toBe(false);
    });

    it("retains requested spelling for new components under a resolved parent", async () => {
        const root = new MemoryDirectoryHandle("root");
        const parent = root.addDirectory("café".normalize("NFD"));
        const adapter = browserAdapter(root);

        await expect(adapter.resolveLogicalPath(parseFilePath("café/new-é.md"), undefined, true)).resolves.toBe(
            asStoragePath("café".normalize("NFD") + "/new-é.md")
        );
        await adapter.write("café/new-é.md", "new");
        await adapter.mkdir("café/new-folder");

        expect(parent.children.has("new-é.md")).toBe(true);
        expect(parent.children.has("new-folder")).toBe(true);
    });

    it("rejects collisions even when the requested spelling is an exact match", async () => {
        const root = new MemoryDirectoryHandle("root");
        root.addFile("é.md", "nfc");
        root.addFile("e\u0301.md", "nfd");
        const adapter = browserAdapter(root);

        await expect(adapter.read("é.md")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        await expect(adapter.write("é.md", "changed")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        await expect(adapter.remove("é.md")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        await expect(adapter.list("")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        await expect((root.children.get("é.md") as MemoryFileHandle).text()).resolves.toBe("nfc");
    });

    it("rejects a file-directory collision in a parent before creating descendants", async () => {
        const root = new MemoryDirectoryHandle("root");
        root.addFile("é", "file");
        const physicalDirectory = root.addDirectory("e\u0301");
        const adapter = browserAdapter(root);

        await expect(adapter.write("é/child.md", "content")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        expect(physicalDirectory.children.size).toBe(0);
    });

    it("observes external additions and collisions on later operations", async () => {
        const root = new MemoryDirectoryHandle("root");
        root.addFile("résumé.md", "original");
        const adapter = browserAdapter(root);

        await expect(adapter.read("résumé.md")).resolves.toBe("original");
        root.addFile("résumé.md".normalize("NFD"), "external");
        await expect(adapter.read("résumé.md")).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
    });

    it("applies explicit case handling independently of the configured setting", async () => {
        const root = new MemoryDirectoryHandle("root");
        root.addFile("README.md", "content");
        const adapter = browserAdapter(
            root,
            () => 1,
            () => true
        );

        await expect(adapter.read("readme.md")).resolves.toBe("content");
        await expect(adapter.resolveLogicalPath(parseFilePath("readme.md"), false, false)).resolves.toBeNull();
        await expect(adapter.resolveLogicalPath(parseFilePath("readme.md"), true, false)).resolves.toBe(
            asStoragePath("README.md")
        );
    });

    it("delegates Legacy paths without NFC matching", async () => {
        const root = new MemoryDirectoryHandle("root");
        const physicalName = "café.md".normalize("NFD");
        root.addFile(physicalName, "nfd");
        const adapter = browserAdapter(root, () => 0);

        await expect(adapter.read(physicalName)).resolves.toBe("nfd");
        await expect(adapter.read("café.md")).rejects.toThrow("File not found");
        await adapter.write("café.md", "nfc");
        expect(root.children.has("café.md")).toBe(true);
    });

    it("distinguishes missing paths from permission and parent type errors", async () => {
        const root = new MemoryDirectoryHandle("root");
        root.addDirectory("folder");
        root.addFile("not-a-directory", "value");
        const raw = new FileSystemAccessStorageAdapter(root as unknown as FileSystemDirectoryHandle);
        const adapter = browserAdapter(root);

        await expect(raw.readDirectory(asStoragePath(""))).resolves.toEqual([
            { name: "folder", kind: "directory" },
            { name: "not-a-directory", kind: "file" },
        ]);
        await expect(raw.readDirectory(asStoragePath("missing"))).resolves.toBeNull();
        await expect(raw.statResolved(asStoragePath("missing"))).resolves.toBeNull();
        await expect(raw.readDirectory(asStoragePath("not-a-directory"))).rejects.toMatchObject({
            name: "TypeMismatchError",
        });
        await expect(raw.statResolved(asStoragePath("not-a-directory/child"))).rejects.toMatchObject({
            name: "TypeMismatchError",
        });
        await expect(adapter.remove("missing")).resolves.toBeUndefined();

        root.entriesError = new DOMException("Access denied", "NotAllowedError");
        await expect(raw.readDirectory(asStoragePath(""))).rejects.toMatchObject({ name: "NotAllowedError" });
        await expect(adapter.exists("missing")).rejects.toMatchObject({ name: "NotAllowedError" });

        const deniedFile = root.addFile("denied-file", "value");
        deniedFile.getFileError = new DOMException("Access denied", "NotAllowedError");
        await expect(raw.statResolved(asStoragePath("denied-file"))).rejects.toMatchObject({
            name: "NotAllowedError",
        });
    });

    it("propagates a permission failure when the resolved file is removed", async () => {
        const root = new MemoryDirectoryHandle("root");
        const folder = root.addDirectory("folder");
        folder.addFile("note.md", "content");
        root.directoryLookupErrors.set("folder", {
            afterCalls: 1,
            error: new DOMException("Access denied", "NotAllowedError"),
        });
        const adapter = browserAdapter(root);

        await expect(adapter.remove("folder/note.md")).rejects.toMatchObject({ name: "NotAllowedError" });
        expect(folder.children.has("note.md")).toBe(true);
    });

    it("preserves read permission failures after path enumeration", async () => {
        const root = new MemoryDirectoryHandle("root");
        const folder = root.addDirectory("folder");
        folder.addFile("note.md", "content");
        root.directoryLookupErrors.set("folder", {
            afterCalls: 1,
            error: new DOMException("Access denied", "NotAllowedError"),
        });
        const adapter = browserAdapter(root);

        await expect(adapter.read("folder/note.md")).rejects.toMatchObject({ name: "NotAllowedError" });
    });

    it("preserves append read-permission failures without overwriting existing content", async () => {
        const root = new MemoryDirectoryHandle("root");
        const folder = root.addDirectory("folder");
        const file = folder.addFile("note.md", "before");
        folder.fileLookupErrors.set("note.md", {
            allowCreate: true,
            error: new DOMException("Access denied", "NotAllowedError"),
        });
        const adapter = browserAdapter(root);

        await expect(adapter.append("folder/note.md", "-after")).rejects.toMatchObject({
            name: "NotAllowedError",
        });
        await expect(file.text()).resolves.toBe("before");
    });

    it("uses one settings snapshot for append and write", async () => {
        const root = new MemoryDirectoryHandle("root");
        const physicalName = "café.md".normalize("NFD");
        const file = root.addFile(physicalName, "before");
        let appendVersionReads = 0;
        const appendAdapter = browserAdapter(root, () => (++appendVersionReads === 1 ? 1 : 0));

        await appendAdapter.append("café.md", "-append");
        expect(appendVersionReads).toBe(1);
        await expect(file.text()).resolves.toBe("before-append");

        let writeVersionReads = 0;
        const writeAdapter = browserAdapter(root, () => (++writeVersionReads === 1 ? 1 : 0));
        await writeAdapter.write("café.md", "updated");
        expect(writeVersionReads).toBe(1);
        await expect(file.text()).resolves.toBe("updated");
    });

    it("rejects unsupported path-normalisation versions", () => {
        const adapter = browserAdapter(new MemoryDirectoryHandle("root"), () => 2);
        expect(() => adapter.isUnicodePathNormalizationEnabled).toThrow(/Unsupported path normalisation version/);
    });
});
