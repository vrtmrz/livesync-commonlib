import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileAccessBase, type FileAccessBaseDependencies, toArrayBuffer } from "./FileAccessBase";
import type {
    IFileSystemAdapter,
    IPathAdapter,
    ITypeGuardAdapter,
    IConversionAdapter,
    IStorageAdapter,
    IVaultAdapter,
} from "./adapters";
import type { FilePath, UXDataWriteOptions, UXFileInfoStub, UXFolderInfo, UXStat } from "@lib/common/types";
import { compareFileFreshnessGeneric } from "../services/implements/injectable/InjectablePathService";

// Mock file types
interface MockFile {
    path: string;
    name: string;
    stat: MockStat;
    content: string;
}

interface MockFolder {
    path: string;
    name: string;
    children: (MockFile | MockFolder)[];
    parent: MockFolder | null;
    stat: MockStat;
}

type MockAbstractFile = MockFile | MockFolder;

interface MockStat extends UXStat {
    ctime: number;
    mtime: number;
    size: number;
    type: "file" | "folder";
}

// Mock Adapter implementations
class MockPathAdapter implements IPathAdapter<MockAbstractFile> {
    getPath(file: MockAbstractFile | string): FilePath {
        return (typeof file === "string" ? file : file.path) as FilePath;
    }

    normalisePath(path: string): string {
        return path.replace(/\\/g, "/");
    }
}

class MockTypeGuardAdapter implements ITypeGuardAdapter<MockFile, MockFolder> {
    isFile(file: any): file is MockFile {
        return file && typeof file === "object" && "content" in file && !("children" in file);
    }

    isFolder(item: any): item is MockFolder {
        return item && typeof item === "object" && "children" in item;
    }
}

class MockConversionAdapter implements IConversionAdapter<MockFile, MockFolder> {
    nativeFileToUXFileInfoStub(file: MockFile): UXFileInfoStub {
        return {
            name: file.name,
            path: file.path as FilePath,
            isFolder: false,
            stat: {
                ...file.stat,
                type: "file",
            },
        };
    }

    nativeFolderToUXFolder(folder: MockFolder): UXFolderInfo {
        return {
            name: folder.name,
            path: folder.path as FilePath,
            isFolder: true,
            children: [],
            parent: folder.parent?.path as FilePath | undefined,
        };
    }
}

class MockStorageAdapter implements IStorageAdapter<MockStat> {
    private files = new Map<string, string>();
    private binaryFiles = new Map<string, ArrayBuffer>();
    private stats = new Map<string, MockStat>();

    exists(path: string): Promise<boolean> {
        return Promise.resolve(this.files.has(path) || this.binaryFiles.has(path));
    }

    async trystat(path: string): Promise<MockStat | null> {
        if (!(await this.exists(path))) return null;
        return this.stat(path);
    }

    stat(path: string): Promise<MockStat | null> {
        return Promise.resolve(this.stats.get(path) || null);
    }

    async mkdir(path: string): Promise<void> {
        // Mock implementation
    }

    remove(path: string): Promise<void> {
        this.files.delete(path);
        this.binaryFiles.delete(path);
        this.stats.delete(path);
        return Promise.resolve();
    }

    read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) return Promise.reject(new Error(`File not found: ${path}`));
        return Promise.resolve(content);
    }

    readBinary(path: string): Promise<ArrayBuffer> {
        const content = this.binaryFiles.get(path);
        if (content === undefined) return Promise.reject(new Error(`File not found: ${path}`));
        return Promise.resolve(content);
    }

    write(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        this.files.set(path, data);
        const now = options?.mtime || Date.now();
        this.stats.set(path, {
            ctime: options?.ctime || now,
            mtime: now,
            size: data.length,
            type: "file",
        });
        return Promise.resolve();
    }

    writeBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        this.binaryFiles.set(path, data);
        const now = options?.mtime || Date.now();
        this.stats.set(path, {
            ctime: options?.ctime || now,
            mtime: now,
            size: data.byteLength,
            type: "file",
        });
        return Promise.resolve();
    }

    async append(path: string, data: string, options?: UXDataWriteOptions): Promise<void> {
        const existing = this.files.get(path) || "";
        await this.write(path, existing + data, options);
    }

    list(basePath: string): Promise<{ files: string[]; folders: string[] }> {
        const files: string[] = [];
        const folders: string[] = [];
        // Simple mock implementation
        return Promise.resolve({ files, folders });
    }
}

class MockVaultAdapter implements IVaultAdapter<MockFile> {
    private mockFiles = new Map<string, MockFile>();

    setMockFile(path: string, file: MockFile) {
        this.mockFiles.set(path, file);
    }

    read(file: MockFile): Promise<string> {
        return Promise.resolve(`content of ${file.path}`);
    }

    cachedRead(file: MockFile): Promise<string> {
        return this.read(file);
    }

    async readBinary(file: MockFile): Promise<ArrayBuffer> {
        const str = await this.read(file);
        return new TextEncoder().encode(str).buffer;
    }

    async modify(file: MockFile, data: string, options?: UXDataWriteOptions): Promise<void> {
        // Mock implementation
    }

    async modifyBinary(file: MockFile, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<void> {
        // Mock implementation
    }

    create(path: string, data: string, options?: UXDataWriteOptions): Promise<MockFile> {
        const file: MockFile = {
            path,
            name: path.split("/").pop() || "",
            stat: {
                ctime: options?.ctime || Date.now(),
                mtime: options?.mtime || Date.now(),
                size: data.length,
                type: "file",
            },
            content: data,
        };
        this.mockFiles.set(path, file);
        return Promise.resolve(file);
    }

    createBinary(path: string, data: ArrayBuffer, options?: UXDataWriteOptions): Promise<MockFile> {
        const content = new TextDecoder().decode(data);
        const file: MockFile = {
            path,
            name: path.split("/").pop() || "",
            stat: {
                ctime: options?.ctime || Date.now(),
                mtime: options?.mtime || Date.now(),
                size: data.byteLength,
                type: "file",
            },
            content,
        };
        this.mockFiles.set(path, file);
        return Promise.resolve(file);
    }

    async delete(file: any, force?: boolean): Promise<void> {
        // Mock implementation
    }

    async trash(file: any, force?: boolean): Promise<void> {
        // Mock implementation
    }

    trigger(name: string, ...data: any[]): any {
        // Mock implementation
    }
}

class MockFileSystemAdapter implements IFileSystemAdapter<MockAbstractFile, MockFile, MockFolder, MockStat> {
    readonly path: IPathAdapter<MockAbstractFile>;
    readonly typeGuard: ITypeGuardAdapter<MockFile, MockFolder>;
    readonly conversion: IConversionAdapter<MockFile, MockFolder>;
    readonly storage: MockStorageAdapter;
    readonly vault: MockVaultAdapter;

    private files = new Map<string, MockAbstractFile>();

    constructor() {
        this.path = new MockPathAdapter();
        this.typeGuard = new MockTypeGuardAdapter();
        this.conversion = new MockConversionAdapter();
        this.storage = new MockStorageAdapter();
        this.vault = new MockVaultAdapter();
    }

    setMockFile(path: string, file: MockAbstractFile) {
        this.files.set(path, file);
        if (this.typeGuard.isFile(file)) {
            this.vault.setMockFile(path, file);
        }
    }

    getAbstractFileByPath(path: FilePath | string): MockAbstractFile | null {
        return this.files.get(path) || null;
    }

    getAbstractFileByPathInsensitive(path: FilePath | string): MockAbstractFile | null {
        const lowerPath = path.toLowerCase();
        for (const [key, value] of this.files.entries()) {
            if (key.toLowerCase() === lowerPath) {
                return value;
            }
        }
        return null;
    }

    getFiles(): MockFile[] {
        const result: MockFile[] = [];
        for (const file of this.files.values()) {
            if (this.typeGuard.isFile(file)) {
                result.push(file);
            }
        }
        return result;
    }

    statFromNative(file: MockFile): Promise<MockStat> {
        return Promise.resolve(file.stat);
    }

    async reconcileInternalFile(path: string): Promise<void> {
        // Mock implementation
    }
}

// Mock dependencies
function createMockDependencies(): FileAccessBaseDependencies {
    return {
        vaultService: {
            isStorageInsensitive: vi.fn().mockReturnValue(false),
        } as any,
        storageAccessManager: {
            processWriteFile: vi.fn((path, callback) => callback()),
            processReadFile: vi.fn((path, callback) => callback()),
            touch: vi.fn(),
            recentlyTouched: vi.fn().mockReturnValue(false),
            clearTouched: vi.fn(),
        } as any,
        settingService: {
            currentSettings: vi.fn().mockReturnValue({
                handleFilenameCaseSensitive: true,
            }),
        } as any,
        APIService: {
            addLog: vi.fn(),
        } as any,
        pathService: {
            compareFileFreshness: compareFileFreshnessGeneric,
            markChangesAreSame: vi.fn().mockReturnValue(false),
            isMarkedAsSameChanges: vi.fn().mockReturnValue(undefined),
            unmarkChanges: vi.fn(),
        } as any,
    };
}

describe("FileAccessBase", () => {
    let adapter: MockFileSystemAdapter;
    let dependencies: FileAccessBaseDependencies;
    let fileAccess: FileAccessBase<MockFileSystemAdapter>;

    beforeEach(() => {
        adapter = new MockFileSystemAdapter();
        dependencies = createMockDependencies();
        fileAccess = new FileAccessBase(adapter, dependencies);
    });

    describe("Type Guards", () => {
        it("should correctly identify files", () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            expect(fileAccess.isFile(file)).toBe(true);
        });

        it("should correctly identify folders", () => {
            const folder: MockFolder = {
                path: "folder",
                name: "folder",
                children: [],
                parent: null,
                stat: { ctime: 0, mtime: 0, size: 0, type: "folder" },
            };
            expect(fileAccess.isFolder(folder)).toBe(true);
        });

        it("should return false for non-files", () => {
            const folder: MockFolder = {
                path: "folder",
                name: "folder",
                children: [],
                parent: null,
                stat: { ctime: 0, mtime: 0, size: 0, type: "folder" },
            };
            expect(fileAccess.isFile(folder)).toBe(false);
        });
    });

    describe("Path operations", () => {
        it("should get path from file object", () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            expect(fileAccess.getPath(file)).toBe("test.md");
        });

        it("should return path string as-is", () => {
            expect(fileAccess.getPath("test.md")).toBe("test.md");
        });

        it("should normalize paths", () => {
            expect(fileAccess.normalisePath("test\\file.md")).toBe("test/file.md");
        });
    });

    describe("Conversion operations", () => {
        it("should convert native file to UXFileInfoStub", () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 1000, mtime: 2000, size: 100, type: "file" },
                content: "",
            };
            const result = fileAccess.nativeFileToUXFileInfoStub(file);
            expect(result.path).toBe("test.md");
            expect(result.name).toBe("test.md");
            expect(result.isFolder).toBe(false);
            expect(result.stat.type).toBe("file");
        });

        it("should convert native folder to UXFolderInfo", () => {
            const folder: MockFolder = {
                path: "folder",
                name: "folder",
                children: [],
                parent: null,
                stat: { ctime: 0, mtime: 0, size: 0, type: "folder" },
            };
            const result = fileAccess.nativeFolderToUXFolder(folder);
            expect(result.path).toBe("folder");
            expect(result.name).toBe("folder");
            expect(result.isFolder).toBe(true);
        });
    });

    describe("Storage operations", () => {
        it("should read text file", async () => {
            await adapter.storage.write("test.txt", "Hello World");
            const content = await fileAccess.adapterRead("test.txt");
            expect(content).toBe("Hello World");
        });

        it("should write text file", async () => {
            await fileAccess.adapterWrite("test.txt", "Hello World");
            const content = await adapter.storage.read("test.txt");
            expect(content).toBe("Hello World");
        });

        it("should read binary file", async () => {
            const data = new TextEncoder().encode("Binary content").buffer;
            await adapter.storage.writeBinary("test.bin", data);
            const result = await fileAccess.adapterReadBinary("test.bin");
            expect(result.byteLength).toBe(data.byteLength);
        });

        it("should write binary file", async () => {
            const data = new TextEncoder().encode("Binary content").buffer;
            await fileAccess.adapterWrite("test.bin", data);
            const result = await adapter.storage.readBinary("test.bin");
            expect(result.byteLength).toBe(data.byteLength);
        });

        it("should check file existence", async () => {
            await adapter.storage.write("test.txt", "content");
            expect(await fileAccess.adapterExists("test.txt")).toBe(true);
            expect(await fileAccess.adapterExists("nonexistent.txt")).toBe(false);
        });

        it("should remove files", async () => {
            await adapter.storage.write("test.txt", "content");
            expect(await fileAccess.adapterExists("test.txt")).toBe(true);
            await fileAccess.adapterRemove("test.txt");
            expect(await fileAccess.adapterExists("test.txt")).toBe(false);
        });

        it("should get file stats", async () => {
            const now = Date.now();
            await adapter.storage.write("test.txt", "content", { mtime: now, ctime: now });
            const stat = await fileAccess.adapterStat("test.txt");
            expect(stat).not.toBeNull();
            expect(stat?.mtime).toBe(now);
            expect(stat?.size).toBe(7); // "content".length
            expect(stat?.type).toBe("file");
        });

        it("should write Uint8Array data", async () => {
            const data = new Uint8Array([65, 66, 67]); // "ABC"
            await fileAccess.adapterWrite("uint8.bin", data);
            const result = await adapter.storage.readBinary("uint8.bin");
            expect(result.byteLength).toBe(3);
        });
    });

    describe("Vault operations", () => {
        it("should read file through vault", async () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "test content",
            };
            adapter.setMockFile("test.md", file);
            const content = await fileAccess.vaultRead(file);
            expect(content).toContain("test.md");
        });

        it("should create file through vault", async () => {
            const result = await fileAccess.vaultCreate("newfile.md", "New content");
            expect(result.path).toBe("newfile.md");
        });

        it("should create binary file through vault", async () => {
            const data = new TextEncoder().encode("Binary data").buffer;
            const result = await fileAccess.vaultCreate("newfile.bin", data);
            expect(result.path).toBe("newfile.bin");
        });
    });

    describe("File system operations", () => {
        it("should get file by path", () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            adapter.setMockFile("test.md", file);
            const result = fileAccess.getAbstractFileByPath("test.md");
            expect(result).toBe(file);
        });

        it("should get file by path case-insensitively when configured", () => {
            const file: MockFile = {
                path: "test.md",
                name: "test.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            adapter.setMockFile("test.md", file);

            // Configure case-insensitive
            dependencies.settingService.currentSettings = vi.fn().mockReturnValue({
                handleFilenameCaseSensitive: false,
            });

            const result = fileAccess.getAbstractFileByPath("TEST.MD");
            expect(result).toBe(file);
        });

        it("should get all files", () => {
            const file1: MockFile = {
                path: "file1.md",
                name: "file1.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            const file2: MockFile = {
                path: "file2.md",
                name: "file2.md",
                stat: { ctime: 0, mtime: 0, size: 200, type: "file" },
                content: "",
            };
            adapter.setMockFile("file1.md", file1);
            adapter.setMockFile("file2.md", file2);

            const files = fileAccess.getFiles();
            expect(files).toHaveLength(2);
            expect(files).toContain(file1);
            expect(files).toContain(file2);
        });

        it("should use case-insensitive search when storage is insensitive", () => {
            const file: MockFile = {
                path: "CaseSensitive.md",
                name: "CaseSensitive.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "",
            };
            adapter.setMockFile("CaseSensitive.md", file);

            dependencies.vaultService.isStorageInsensitive = vi.fn().mockReturnValue(true);

            const result = fileAccess.getAbstractFileByPath("casesensitive.md");
            expect(result).toBe(file);
        });
    });

    describe("Directory operations", () => {
        it("should ensure directory exists", async () => {
            const mkdirSpy = vi.spyOn(adapter.storage, "mkdir");
            await fileAccess.ensureDirectory("folder/subfolder/file.md");
            expect(mkdirSpy).toHaveBeenCalled();
        });

        it("should handle folder already exists error", async () => {
            const mkdirSpy = vi.spyOn(adapter.storage, "mkdir").mockRejectedValue(new Error("Folder already exists."));
            await fileAccess.ensureDirectory("existing/folder/file.md");
            expect(mkdirSpy).toHaveBeenCalled();
        });

        it("should log other mkdir errors", async () => {
            const mkdirSpy = vi.spyOn(adapter.storage, "mkdir").mockRejectedValue(new Error("Permission denied"));
            await fileAccess.ensureDirectory("denied/file.md");
            expect(mkdirSpy).toHaveBeenCalled();
            expect(dependencies.APIService.addLog).toHaveBeenCalled();
        });
    });

    describe("Read/Write operations with proper locking", () => {
        it("should call processReadFile for read operations", async () => {
            await adapter.storage.write("test.txt", "content");
            await fileAccess.adapterRead("test.txt");
            expect(dependencies.storageAccessManager.processReadFile).toHaveBeenCalled();
        });

        it("should call processWriteFile for write operations", async () => {
            await fileAccess.adapterWrite("test.txt", "content");
            expect(dependencies.storageAccessManager.processWriteFile).toHaveBeenCalled();
        });
    });

    describe("Additional storage operations", () => {
        it("should try to get stat (tryAdapterStat)", async () => {
            await adapter.storage.write("test.txt", "content");
            const stat = await fileAccess.tryAdapterStat("test.txt");
            expect(stat).not.toBeNull();
        });

        it("should return null for non-existent file (tryAdapterStat)", async () => {
            const stat = await fileAccess.tryAdapterStat("nonexistent.txt");
            expect(stat).toBeNull();
        });

        it("should auto-read text file", async () => {
            await adapter.storage.write("test.txt", "Text content");
            const content = await fileAccess.adapterReadAuto("test.txt");
            expect(typeof content).toBe("string");
            expect(content).toBe("Text content");
        });

        it("should auto-read binary file", async () => {
            const data = new TextEncoder().encode("Binary data").buffer;
            await adapter.storage.writeBinary("test.bin", data);
            const content = await fileAccess.adapterReadAuto("test.bin");
            expect(content instanceof ArrayBuffer).toBe(true);
        });

        it("should append data to file", async () => {
            await adapter.storage.write("test.txt", "Hello");
            await fileAccess.adapterAppend("test.txt", " World");
            const content = await adapter.storage.read("test.txt");
            expect(content).toBe("Hello World");
        });

        it("should list files and folders", async () => {
            const result = await fileAccess.adapterList("base/path");
            expect(result).toHaveProperty("files");
            expect(result).toHaveProperty("folders");
        });
    });

    describe("Additional vault operations", () => {
        it("should read file with cache", async () => {
            const file: MockFile = {
                path: "cached.md",
                name: "cached.md",
                stat: { ctime: 0, mtime: 0, size: 100, type: "file" },
                content: "cached",
            };
            adapter.setMockFile("cached.md", file);
            const content = await fileAccess.vaultCacheRead(file);
            expect(content).toContain("cached.md");
        });

        it("should read binary file through vault", async () => {
            const file: MockFile = {
                path: "binary.bin",
                name: "binary.bin",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "binary",
            };
            adapter.setMockFile("binary.bin", file);
            const content = await fileAccess.vaultReadBinary(file);
            expect(content instanceof ArrayBuffer).toBe(true);
        });

        it("should auto-read text file through vault", async () => {
            const file: MockFile = {
                path: "auto.txt",
                name: "auto.txt",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "auto",
            };
            adapter.setMockFile("auto.txt", file);
            const content = await fileAccess.vaultReadAuto(file);
            expect(typeof content).toBe("string");
        });

        it("should auto-read binary file through vault", async () => {
            const file: MockFile = {
                path: "auto.bin",
                name: "auto.bin",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "auto",
            };
            adapter.setMockFile("auto.bin", file);
            const content = await fileAccess.vaultReadAuto(file);
            expect(content instanceof ArrayBuffer).toBe(true);
        });

        it("should modify text file through vault", async () => {
            const file: MockFile = {
                path: "modify.md",
                name: "modify.md",
                stat: { ctime: 0, mtime: 0, size: 5, type: "file" },
                content: "old",
            };
            adapter.setMockFile("modify.md", file);
            const modifySpy = vi.spyOn(adapter.vault, "modify");
            await fileAccess.vaultModify(file, "new");
            expect(modifySpy).toHaveBeenCalledWith(file, "new", undefined);
        });

        it("should modify binary file through vault", async () => {
            const file: MockFile = {
                path: "modify.bin",
                name: "modify.bin",
                stat: { ctime: 0, mtime: 0, size: 5, type: "file" },
                content: "old",
            };
            adapter.setMockFile("modify.bin", file);
            const modifyBinarySpy = vi.spyOn(adapter.vault, "modifyBinary");
            const data = new TextEncoder().encode("new").buffer;
            await fileAccess.vaultModify(file, data);
            expect(modifyBinarySpy).toHaveBeenCalled();
        });

        it("should not modify when content is same (text)", async () => {
            const file: MockFile = {
                path: "same.md",
                name: "same.md",
                stat: { ctime: 0, mtime: 100, size: 7, type: "file" },
                content: "same",
            };
            adapter.setMockFile("same.md", file);
            vi.spyOn(adapter.vault, "read").mockResolvedValue("same");
            const modifySpy = vi.spyOn(adapter.vault, "modify");
            const markSpy = vi.spyOn(dependencies.pathService, "markChangesAreSame");
            await fileAccess.vaultModify(file, "same", { mtime: 200 });
            expect(modifySpy).not.toHaveBeenCalled();
            expect(markSpy).toHaveBeenCalledWith(file.path, 100, 200);
        });

        it("should not modify when binary content is same", async () => {
            const data = new TextEncoder().encode("same").buffer;
            const file: MockFile = {
                path: "same.bin",
                name: "same.bin",
                stat: { ctime: 0, mtime: 100, size: 4, type: "file" },
                content: "same",
            };
            adapter.setMockFile("same.bin", file);
            vi.spyOn(adapter.vault, "readBinary").mockResolvedValue(data);
            const modifyBinarySpy = vi.spyOn(adapter.vault, "modifyBinary");
            const markSpy = vi.spyOn(dependencies.pathService, "markChangesAreSame");
            await fileAccess.vaultModify(file, data, { mtime: 200 });
            expect(modifyBinarySpy).not.toHaveBeenCalled();
            expect(markSpy).toHaveBeenCalledWith(file.path, 100, 200);
        });

        it("should create text file with vaultCreate", async () => {
            const result = await fileAccess.vaultCreate("create.md", "New file");
            expect(result.path).toBe("create.md");
        });

        it("should create binary file with vaultCreate using Uint8Array", async () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const result = await fileAccess.vaultCreate("create.bin", data);
            expect(result.path).toBe("create.bin");
        });
    });

    describe("File deletion operations", () => {
        it("should delete file", async () => {
            const file: MockFile = {
                path: "delete.md",
                name: "delete.md",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "delete",
            };
            adapter.setMockFile("delete.md", file);
            const deleteSpy = vi.spyOn(adapter.vault, "delete");
            await fileAccess.delete(file);
            expect(deleteSpy).toHaveBeenCalledWith(file, undefined);
        });

        it("should delete file with force", async () => {
            const file: MockFile = {
                path: "force-delete.md",
                name: "force-delete.md",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "delete",
            };
            adapter.setMockFile("force-delete.md", file);
            const deleteSpy = vi.spyOn(adapter.vault, "delete");
            await fileAccess.delete(file, true);
            expect(deleteSpy).toHaveBeenCalledWith(file, true);
        });

        it("should move file to trash", async () => {
            const file: MockFile = {
                path: "trash.md",
                name: "trash.md",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "trash",
            };
            adapter.setMockFile("trash.md", file);
            const trashSpy = vi.spyOn(adapter.vault, "trash");
            await fileAccess.trash(file);
            expect(trashSpy).toHaveBeenCalledWith(file, undefined);
        });
    });

    describe("Touch operations", () => {
        it("should touch file with path", async () => {
            await adapter.storage.write("touch.txt", "content", { mtime: 1000, ctime: 1000 });
            await fileAccess.touch("touch.txt" as FilePath);
            expect(dependencies.storageAccessManager.touch).toHaveBeenCalled();
        });

        it("should touch file with file object", async () => {
            const file: MockFile = {
                path: "touch.md",
                name: "touch.md",
                stat: { ctime: 1000, mtime: 2000, size: 10, type: "file" },
                content: "touch",
            };
            await fileAccess.touch(file);
            expect(dependencies.storageAccessManager.touch).toHaveBeenCalledWith({
                path: "touch.md",
                stat: file.stat,
            });
        });

        it("should check if file was recently touched", () => {
            const file: MockFile = {
                path: "recent.md",
                name: "recent.md",
                stat: { ctime: 0, mtime: 0, size: 10, type: "file" },
                content: "recent",
            };
            fileAccess.recentlyTouched(file);
            expect(dependencies.storageAccessManager.recentlyTouched).toHaveBeenCalled();
        });

        it("should clear touched files", () => {
            fileAccess.clearTouched();
            expect(dependencies.storageAccessManager.clearTouched).toHaveBeenCalled();
        });
    });

    describe("Miscellaneous operations", () => {
        it("should trigger vault events", () => {
            const triggerSpy = vi.spyOn(adapter.vault, "trigger");
            fileAccess.trigger("test-event", "data1", "data2");
            expect(triggerSpy).toHaveBeenCalledWith("test-event", "data1", "data2");
        });

        it("should reconcile internal file", async () => {
            const reconcileSpy = vi.spyOn(adapter, "reconcileInternalFile");
            await fileAccess.reconcileInternalFile("internal.md");
            expect(reconcileSpy).toHaveBeenCalledWith("internal.md");
        });
    });
});

describe("toArrayBuffer utility function", () => {
    it("should convert Uint8Array to ArrayBuffer", () => {
        const uint8 = new Uint8Array([1, 2, 3, 4]);
        const result = toArrayBuffer(uint8);
        expect(result instanceof ArrayBuffer).toBe(true);
        expect(result.byteLength).toBe(4);
    });

    it("should convert DataView to ArrayBuffer", () => {
        const buffer = new ArrayBuffer(4);
        const dataView = new DataView(buffer);
        const result = toArrayBuffer(dataView);
        expect(result instanceof ArrayBuffer).toBe(true);
        expect(result).toBe(buffer);
    });

    it("should return ArrayBuffer as-is", () => {
        const buffer = new ArrayBuffer(8);
        const result = toArrayBuffer(buffer);
        expect(result).toBe(buffer);
    });
});
