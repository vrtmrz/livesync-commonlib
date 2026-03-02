import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StorageAccessManager } from "./StorageProcessingManager.ts";
import type { UXFileInfoStub, FileWithFileStat, FileWithStatAsProp } from "@lib/common/models/fileaccess.type";
import type { FilePath, FilePathWithPrefix } from "../common/types.ts";

describe("StorageAccessManager", () => {
    let storageAccessManager: StorageAccessManager;

    beforeEach(() => {
        storageAccessManager = new StorageAccessManager();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("Initialization", () => {
        it("should initialize with empty processingFiles set", () => {
            expect(storageAccessManager.processingFiles).toEqual(new Set());
        });

        it("should initialize with empty touchedFiles array", () => {
            expect((storageAccessManager as any).touchedFiles).toEqual([]);
        });
    });

    describe("processWriteFile", () => {
        it("should execute the processor function", async () => {
            const processor = vi.fn().mockResolvedValue("result");
            const filePath = "test/file.txt" as FilePathWithPrefix;

            const result = await storageAccessManager.processWriteFile(filePath, processor);

            expect(result).toBe("result");
            expect(processor).toHaveBeenCalledTimes(1);
        });

        it("should add file to processingFiles during execution", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const processor = vi.fn(() => {
                expect(storageAccessManager.processingFiles.has(filePath)).toBe(true);
                return Promise.resolve("result");
            });

            await storageAccessManager.processWriteFile(filePath, processor);

            expect(storageAccessManager.processingFiles.has(filePath)).toBe(false);
        });

        it("should remove file from processingFiles after execution", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const processor = vi.fn().mockResolvedValue("result");

            await storageAccessManager.processWriteFile(filePath, processor);

            expect(storageAccessManager.processingFiles.has(filePath)).toBe(false);
        });

        it("should handle processor function with UXFileInfoStub", async () => {
            const file: UXFileInfoStub = {
                path: "test/file.txt" as FilePath,
                name: "file.txt",
            } as UXFileInfoStub;
            const processor = vi.fn().mockResolvedValue("result");

            const result = await storageAccessManager.processWriteFile(file, processor);

            expect(result).toBe("result");
            expect(storageAccessManager.processingFiles.has("test/file.txt" as FilePathWithPrefix)).toBe(false);
        });

        it("should handle error in processor function", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const error = new Error("test error");
            const processor = vi.fn().mockRejectedValue(error);

            await expect(storageAccessManager.processWriteFile(filePath, processor)).rejects.toThrow("test error");

            expect(storageAccessManager.processingFiles.has(filePath)).toBe(false);
        });

        it("should support multiple sequential operations on different files", async () => {
            const processor1 = vi.fn().mockResolvedValue("result1");
            const processor2 = vi.fn().mockResolvedValue("result2");

            const result1 = await storageAccessManager.processWriteFile("file1.txt" as FilePathWithPrefix, processor1);
            const result2 = await storageAccessManager.processWriteFile("file2.txt" as FilePathWithPrefix, processor2);

            expect(result1).toBe("result1");
            expect(result2).toBe("result2");
            expect(storageAccessManager.processingFiles.size).toBe(0);
        });
    });

    describe("processReadFile", () => {
        it("should execute the processor function", async () => {
            const processor = vi.fn().mockResolvedValue("data");
            const filePath = "test/file.txt" as FilePathWithPrefix;

            const result = await storageAccessManager.processReadFile(filePath, processor);

            expect(result).toBe("data");
            expect(processor).toHaveBeenCalledTimes(1);
        });

        it("should add file to processingFiles during execution", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const processor = vi.fn(() => {
                expect(storageAccessManager.processingFiles.has(filePath)).toBe(true);
                return Promise.resolve("data");
            });

            await storageAccessManager.processReadFile(filePath, processor);

            expect(storageAccessManager.processingFiles.has(filePath)).toBe(false);
        });

        it("should handle processor function with UXFileInfoStub", async () => {
            const file: UXFileInfoStub = {
                path: "test/file.txt" as FilePath,
                name: "file.txt",
            } as UXFileInfoStub;
            const processor = vi.fn().mockResolvedValue("data");

            const result = await storageAccessManager.processReadFile(file, processor);

            expect(result).toBe("data");
        });

        it("should handle error in processor function", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const error = new Error("read error");
            const processor = vi.fn().mockRejectedValue(error);

            await expect(storageAccessManager.processReadFile(filePath, processor)).rejects.toThrow("read error");

            expect(storageAccessManager.processingFiles.has(filePath)).toBe(false);
        });
    });

    describe("isFileProcessing", () => {
        it("should return false for non-processing file", () => {
            const result = storageAccessManager.isFileProcessing("test/file.txt" as FilePathWithPrefix);

            expect(result).toBe(false);
        });

        it("should return true for file in processingFiles", async () => {
            const filePath = "test/file.txt" as FilePathWithPrefix;
            const processor = vi.fn(async () => {
                expect(storageAccessManager.isFileProcessing(filePath)).toBe(true);
                await Promise.resolve();
            });

            await storageAccessManager.processWriteFile(filePath, processor);

            expect(storageAccessManager.isFileProcessing(filePath)).toBe(false);
        });

        it("should accept both string and UXFileInfoStub", () => {
            const file: UXFileInfoStub = {
                path: "test/file.txt" as FilePath,
                name: "file.txt",
            } as UXFileInfoStub;

            expect(storageAccessManager.isFileProcessing("test/file.txt" as FilePathWithPrefix)).toBe(false);
            expect(storageAccessManager.isFileProcessing(file)).toBe(false);
        });
    });

    describe("touch", () => {
        it("should track touched file with stat property", () => {
            const file: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 2000,
                    size: 100,
                    type: "file",
                } as any,
            };

            storageAccessManager.touch(file);

            expect(storageAccessManager.recentlyTouched(file)).toBe(true);
        });

        it("should track touched file with mtime and size as properties", () => {
            const file: FileWithFileStat = {
                path: "test/file.txt" as FilePath,
                mtime: 2000,
                ctime: 1000,
                size: 100,
            };

            storageAccessManager.touch(file);

            expect(storageAccessManager.recentlyTouched(file)).toBe(true);
        });

        it("should maintain most recent files in order", () => {
            const files: FileWithStatAsProp[] = [
                { path: "file1.txt" as FilePath, stat: { ctime: 1000, mtime: 1000, size: 100 } as any },
                { path: "file2.txt" as FilePath, stat: { ctime: 2000, mtime: 2000, size: 200 } as any },
                { path: "file3.txt" as FilePath, stat: { ctime: 3000, mtime: 3000, size: 300 } as any },
            ];

            files.forEach((file) => storageAccessManager.touch(file));

            expect(storageAccessManager.recentlyTouched(files[0])).toBe(true);
            expect(storageAccessManager.recentlyTouched(files[1])).toBe(true);
            expect(storageAccessManager.recentlyTouched(files[2])).toBe(true);
        });

        it("should limit touched files to 100", () => {
            const files: FileWithStatAsProp[] = [];
            for (let i = 0; i < 150; i++) {
                files.push({
                    path: `file${i}.txt` as FilePath,
                    stat: {
                        ctime: i * 1000,
                        mtime: i * 1000,
                        size: i * 100,
                    } as any,
                });
            }

            files.forEach((file) => storageAccessManager.touch(file));

            // First 50 files should be evicted
            expect(storageAccessManager.recentlyTouched(files[0])).toBe(false);
            expect(storageAccessManager.recentlyTouched(files[49])).toBe(false);

            // Last 100 files should be present
            expect(storageAccessManager.recentlyTouched(files[50])).toBe(true);
            expect(storageAccessManager.recentlyTouched(files[149])).toBe(true);
        });

        it("should distinguish between files with different mtimes", () => {
            const file1: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    mtime: 1000,
                    ctime: 1000,
                    size: 100,
                },
            };
            const file2: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 2000,
                    size: 100,
                },
            };

            storageAccessManager.touch(file1);

            expect(storageAccessManager.recentlyTouched(file1)).toBe(true);
            expect(storageAccessManager.recentlyTouched(file2)).toBe(false);
        });

        it("should distinguish between files with different sizes", () => {
            const file1: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 1000,
                    size: 100,
                },
            };
            const file2: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 1000,
                    size: 200,
                },
            };

            storageAccessManager.touch(file1);

            expect(storageAccessManager.recentlyTouched(file1)).toBe(true);
            expect(storageAccessManager.recentlyTouched(file2)).toBe(false);
        });
    });

    describe("recentlyTouched", () => {
        it("should return false for untouched file", () => {
            const file: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 1000,
                    size: 100,
                },
            };

            expect(storageAccessManager.recentlyTouched(file)).toBe(false);
        });

        it("should return true for touched file", () => {
            const file: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 1000,
                    size: 100,
                },
            };

            storageAccessManager.touch(file);

            expect(storageAccessManager.recentlyTouched(file)).toBe(true);
        });

        it("should work with FileWithFileStat type", () => {
            const file: FileWithFileStat = {
                path: "test/file.txt" as FilePath,
                ctime: 1000,
                mtime: 2000,
                size: 100,
                type: "file",
            } as any;

            storageAccessManager.touch(file);

            expect(storageAccessManager.recentlyTouched(file)).toBe(true);
        });
    });

    describe("clearTouched", () => {
        it("should clear all touched file records", () => {
            const files: FileWithStatAsProp[] = [
                { path: "file1.txt" as FilePath, stat: { ctime: 1000, mtime: 1000, size: 100 } },
                { path: "file2.txt" as FilePath, stat: { ctime: 2000, mtime: 2000, size: 200 } },
            ];

            files.forEach((file) => storageAccessManager.touch(file));

            expect(storageAccessManager.recentlyTouched(files[0])).toBe(true);

            storageAccessManager.clearTouched();

            expect(storageAccessManager.recentlyTouched(files[0])).toBe(false);
            expect(storageAccessManager.recentlyTouched(files[1])).toBe(false);
        });

        it("should allow re-touching after clear", () => {
            const file: FileWithStatAsProp = {
                path: "test/file.txt" as FilePath,
                stat: {
                    ctime: 1000,
                    mtime: 1000,
                    size: 100,
                },
            };

            storageAccessManager.touch(file);
            storageAccessManager.clearTouched();
            storageAccessManager.touch(file);

            expect(storageAccessManager.recentlyTouched(file)).toBe(true);
        });
    });

    describe("Integration tests", () => {
        it("should handle concurrent operations on different files", async () => {
            const file1Path = "file1.txt" as FilePath;
            const file2Path = "file2.txt" as FilePath;

            const processor1 = vi.fn().mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return "result1";
            });

            const processor2 = vi.fn().mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return "result2";
            });

            const [result1, result2] = await Promise.all([
                storageAccessManager.processWriteFile(file1Path, processor1),
                storageAccessManager.processWriteFile(file2Path, processor2),
            ]);

            expect(result1).toBe("result1");
            expect(result2).toBe("result2");
            expect(storageAccessManager.processingFiles.size).toBe(0);
        });

        it("should handle touch and recentlyTouched together", () => {
            const files: FileWithStatAsProp[] = [
                { path: "file1.txt" as FilePath, stat: { ctime: 1000, mtime: 1000, size: 100 } },
                { path: "file2.txt" as FilePath, stat: { ctime: 2000, mtime: 2000, size: 200 } },
                { path: "file3.txt" as FilePath, stat: { ctime: 3000, mtime: 3000, size: 300 } },
            ];

            files.forEach((file) => storageAccessManager.touch(file));

            // All files should be recently touched
            files.forEach((file) => {
                expect(storageAccessManager.recentlyTouched(file)).toBe(true);
            });

            // Clear and verify
            storageAccessManager.clearTouched();
            files.forEach((file) => {
                expect(storageAccessManager.recentlyTouched(file)).toBe(false);
            });
        });
    });
});
