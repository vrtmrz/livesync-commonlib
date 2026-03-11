import { describe, it, expect, beforeAll, vi } from "vitest";

import {
    collectDeletedFiles,
    getPathFromEntry,
    syncFileBetweenDBandStorage,
    canProceedScan,
    convertCase,
    collectFilesOnStorage,
    collectDatabaseFiles,
    updateToDatabase,
    updateToStorage,
    syncStorageAndDatabase,
    performFullScan,
    useOfflineScanner,
} from "./offlineScanner";
import { prepareDatabaseForUse } from "./prepareDatabaseForUse";
import { type LogFunction, createInstanceLogFunction } from "@lib/services/lib/logUtils";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import type { MetaEntry, UXFileInfoStub, FilePathWithPrefix, ObsidianLiveSyncSettings } from "@lib/common/types";
import { LOG_LEVEL_DEBUG, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE } from "@lib/common/types";

const APIServiceMock = {
    addLog(message: string, level?: any) {
        console.log(`${message}`);
    },
};

function createLogger(name: string): LogFunction {
    return createInstanceLogFunction(name, APIServiceMock as any);
}

describe("convertCase", () => {
    it("should return path as-is when handleFilenameCaseSensitive is true", () => {
        const settings = {
            handleFilenameCaseSensitive: true,
        } as ObsidianLiveSyncSettings;

        const path = "Test/File.md" as FilePathWithPrefix;
        const result = convertCase(settings, path);

        expect(result).toBe(path);
    });

    it("should return lowercase path when handleFilenameCaseSensitive is false", () => {
        const settings = {
            handleFilenameCaseSensitive: false,
        } as ObsidianLiveSyncSettings;

        const path = "Test/File.md" as FilePathWithPrefix;
        const result = convertCase(settings, path);

        expect(result).toBe("test/file.md");
    });
});

describe("getPathFromEntry", () => {
    // let logger: LogFunction;

    // beforeAll(() => {
    //     logger = createLogger("TestLogger");
    // });

    it("should extract path from meta entry using path service", () => {
        const mockPath = {
            getPath: vi.fn().mockReturnValue("test/file.md"),
        };

        const host = {
            services: {
                path: mockPath,
            },
            serviceModules: {},
        } as any;

        const doc = {
            path: "test/file.md",
        } as MetaEntry;

        const result = getPathFromEntry(host, doc);

        expect(mockPath.getPath).toHaveBeenCalledWith(doc);
        expect(result).toBe("test/file.md");
    });
});

describe("canProceedScan", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should return false if LiveSync is not configured", () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                keyValueDB: {},
                setting: {
                    currentSettings: () => ({
                        isConfigured: false,
                    }),
                },
            },
            serviceModules: {},
        } as any;

        const result = canProceedScan(host, errorManager as any, logger, false, false);

        expect(result).toBe(false);
        expect(errorManager.showError).toHaveBeenCalledWith(expect.stringContaining("not configured"), LOG_LEVEL_INFO);
    });

    it("should return false if file watching is suspended", () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                keyValueDB: {},
                setting: {
                    currentSettings: () => ({
                        isConfigured: true,
                        suspendFileWatching: true,
                        maxMTimeForReflectEvents: 0,
                    }),
                },
            },
            serviceModules: {},
        } as any;

        const result = canProceedScan(host, errorManager as any, logger, false, false);

        expect(result).toBe(false);
        expect(errorManager.showError).toHaveBeenCalledWith(expect.stringContaining("suspending"), LOG_LEVEL_INFO);
    });

    it("should return true if file watching is suspended but ignoreSuspending is true", () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                keyValueDB: {},
                setting: {
                    currentSettings: () => ({
                        isConfigured: true,
                        suspendFileWatching: true,
                        maxMTimeForReflectEvents: 0,
                    }),
                },
            },
            serviceModules: {},
        } as any;

        const result = canProceedScan(host, errorManager as any, logger, false, true);

        expect(result).toBe(true);
        expect(errorManager.clearError).toHaveBeenCalled();
    });

    it("should return false if in remediation mode", () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                keyValueDB: {},
                setting: {
                    currentSettings: () => ({
                        isConfigured: true,
                        suspendFileWatching: false,
                        maxMTimeForReflectEvents: 100,
                    }),
                },
            },
            serviceModules: {},
        } as any;

        const result = canProceedScan(host, errorManager as any, logger, false, false);

        expect(result).toBe(false);
        expect(errorManager.showError).toHaveBeenCalledWith(expect.stringContaining("remediation"), LOG_LEVEL_NOTICE);
    });

    it("should return true when all checks pass", () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                keyValueDB: {},
                setting: {
                    currentSettings: () => ({
                        isConfigured: true,
                        suspendFileWatching: false,
                        maxMTimeForReflectEvents: 0,
                    }),
                },
            },
            serviceModules: {},
        } as any;

        const result = canProceedScan(host, errorManager as any, logger, false, false);

        expect(result).toBe(true);
        expect(errorManager.clearError).toHaveBeenCalledTimes(3);
    });
});

describe("collectDeletedFiles", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should skip collection if limitDays is <= 0", async () => {
        const host = {
            services: {
                setting: {
                    currentSettings: () => ({
                        automaticallyDeleteMetadataOfDeletedFiles: 0,
                    }),
                },
                database: {
                    localDatabase: {
                        findAllDocs: vi.fn(),
                    },
                },
            },
            serviceModules: {},
        } as any;

        await collectDeletedFiles(host, logger);

        expect(host.services.database.localDatabase.findAllDocs).not.toHaveBeenCalled();
    });

    it("should collect and delete expired files", async () => {
        const now = Date.now();
        const expiredTime = now - 100 * 86400 * 1000; // 100 days ago

        const expiredDoc = {
            _id: "expired",
            path: "expired.md",
            deleted: true,
            mtime: expiredTime,
            type: "newnote",
        };

        const recentDoc = {
            _id: "recent",
            path: "recent.md",
            deleted: true,
            mtime: now,
            type: "newnote",
        };

        async function* mockFindAllDocs() {
            yield expiredDoc;
            yield recentDoc;
            await Promise.resolve(); // Ensure this is treated as async
        }

        const putRawMock = vi.fn();

        const host = {
            services: {
                setting: {
                    currentSettings: () => ({
                        automaticallyDeleteMetadataOfDeletedFiles: 30,
                    }),
                },
                database: {
                    localDatabase: {
                        findAllDocs: vi.fn().mockReturnValue(mockFindAllDocs()),
                        putRaw: putRawMock,
                    },
                },
            },
            serviceModules: {},
        } as any;

        await collectDeletedFiles(host, logger);

        expect(putRawMock).toHaveBeenCalledTimes(1);
        expect(putRawMock).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: "expired",
                _deleted: true,
            })
        );
    });

    it("should collect and delete expired files", async () => {
        const now = Date.now();
        const recentDoc = {
            _id: "recent",
            path: "recent.md",
            deleted: true,
            mtime: now,
            type: "newnote",
        };

        async function* mockFindAllDocs() {
            yield recentDoc;
            await Promise.resolve(); // Ensure this is treated as async
        }

        const putRawMock = vi.fn();

        const host = {
            services: {
                setting: {
                    currentSettings: () => ({
                        automaticallyDeleteMetadataOfDeletedFiles: 30,
                    }),
                },
                database: {
                    localDatabase: {
                        findAllDocs: vi.fn().mockReturnValue(mockFindAllDocs()),
                        putRaw: putRawMock,
                    },
                },
            },
            serviceModules: {},
        } as any;

        await collectDeletedFiles(host, logger);

        expect(putRawMock).not.toHaveBeenCalled();
    });
});

describe("collectFilesOnStorage", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should collect files from storage that are target files", async () => {
        const mockFiles = [
            { path: "file1.md", stat: { size: 100 } },
            { path: "file2.txt", stat: { size: 200 } },
            { path: ".hidden", stat: { size: 50 } },
        ];

        const isTargetFileMock = vi.fn((path: string) => {
            return Promise.resolve(path.endsWith(".md") || path.endsWith(".txt"));
        });

        const host = {
            services: {
                vault: {
                    isTargetFile: isTargetFileMock,
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockReturnValue(mockFiles),
                },
            },
        } as any;

        const settings = {
            handleFilenameCaseSensitive: true,
        } as ObsidianLiveSyncSettings;

        const result = await collectFilesOnStorage(host, settings, logger);

        expect(result.storageFileNames).toHaveLength(2);
        expect(result.storageFileNames).toContain("file1.md");
        expect(result.storageFileNames).toContain("file2.txt");
        expect(result.storageFileNameMap).toHaveProperty("file1.md");
        expect(result.storageFileNameCI2CS).toHaveProperty("file1.md");
    });

    it("should handle case-insensitive filenames", async () => {
        const mockFiles = [
            { path: "File1.md", stat: { size: 100 } },
            { path: "FILE2.MD", stat: { size: 200 } },
        ];

        const host = {
            services: {
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockReturnValue(mockFiles),
                },
            },
        } as any;

        const settings = {
            handleFilenameCaseSensitive: false,
        } as ObsidianLiveSyncSettings;

        const result = await collectFilesOnStorage(host, settings, logger);

        expect(result.storageFileNameCI2CS).toHaveProperty("file1.md");
        expect(result.storageFileNameCI2CS).toHaveProperty("file2.md");
        expect(result.storageFileNameCI2CS["file1.md" as any]).toBe("File1.md");
        expect(result.storageFileNameCI2CS["file2.md" as any]).toBe("FILE2.MD");
    });
});

describe("collectDatabaseFiles", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should collect files from database that are target files", async () => {
        const mockDocs = [
            { _id: "doc1", path: "file1.md", size: 100, type: "newnote", mtime: 1000, ctime: 900, children: [] },
            { _id: "doc2", path: "file2.txt", size: 200, type: "newnote", mtime: 2000, ctime: 1900, children: [] },
        ];

        async function* mockFindAllNormalDocs() {
            yield mockDocs[0];
            yield mockDocs[1];
            await Promise.resolve(); // Ensure this is treated as async
        }

        const getPathMock = vi.fn((doc: any) => doc.path);

        const host = {
            services: {
                vault: {
                    isValidPath: vi.fn().mockReturnValue(true),
                    isTargetFile: vi.fn().mockResolvedValue(true),
                },
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                path: {
                    getPath: getPathMock,
                },
            },
            serviceModules: {},
        } as any;

        const settings = {
            handleFilenameCaseSensitive: true,
        } as ObsidianLiveSyncSettings;

        const result = await collectDatabaseFiles(host, settings, logger, false);

        expect(result.databaseFileNames).toHaveLength(2);
        expect(result.databaseFileNames).toContain("file1.md");
        expect(result.databaseFileNames).toContain("file2.txt");
    });
});

describe("updateToDatabase", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should store file to database if size is within limit", async () => {
        const storeFileToDBMock = vi.fn();

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
            },
            serviceModules: {
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        await updateToDatabase(host, logger, LOG_LEVEL_INFO, file);

        expect(storeFileToDBMock).toHaveBeenCalledWith(file);
    });

    it("should skip file if size is too large", async () => {
        const storeFileToDBMock = vi.fn();

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(true),
                },
            },
            serviceModules: {
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                },
            },
        } as any;

        const file = {
            path: "large.md",
            stat: { size: 999999999 },
        } as UXFileInfoStub;

        await updateToDatabase(host, logger, LOG_LEVEL_INFO, file);

        expect(storeFileToDBMock).not.toHaveBeenCalled();
    });
});

describe("updateToStorage", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should update storage from database if conditions are met", async () => {
        const dbToStorageMock = vi.fn().mockResolvedValue(true);
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: getPathMock,
                },
            },
            serviceModules: {
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
            deleted: false,
            _deleted: false,
        } as MetaEntry;

        await updateToStorage(host, logger, LOG_LEVEL_INFO, doc);

        expect(dbToStorageMock).toHaveBeenCalledWith("test.md", null, true);
    });

    it("should skip if document is deleted", async () => {
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: getPathMock,
                },
            },
            serviceModules: {
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
            deleted: true,
        } as MetaEntry;

        await updateToStorage(host, logger, LOG_LEVEL_INFO, doc);

        expect(dbToStorageMock).not.toHaveBeenCalled();
    });

    it("should skip if document has conflicts", async () => {
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: getPathMock,
                },
            },
            serviceModules: {
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
            deleted: false,
            _conflicts: ["conflict1"],
        } as MetaEntry;

        await updateToStorage(host, logger, LOG_LEVEL_INFO, doc);

        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
});

describe("syncFileBetweenDBandStorage", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should sync from storage to database when storage is newer", async () => {
        const storeFileToDBMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(BASE_IS_NEW),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 90,
        } as MetaEntry;

        await syncFileBetweenDBandStorage(host, logger, file, doc);

        expect(storeFileToDBMock).toHaveBeenCalled();
    });

    it("should sync from database to storage when database is newer", async () => {
        const dbToStorageMock = vi.fn().mockResolvedValue(true);
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(TARGET_IS_NEW),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
        } as MetaEntry;

        await syncFileBetweenDBandStorage(host, logger, file, doc);

        expect(dbToStorageMock).toHaveBeenCalled();
    });

    it("should do nothing when files are equal", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
        } as MetaEntry;

        await syncFileBetweenDBandStorage(host, logger, file, doc);

        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
    it("should handle if document cannot be found in database", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        await expect(syncFileBetweenDBandStorage(host, logger, file, undefined!)).rejects.toThrow();
    });
    it("should handle if file cannot be found in storage", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue(null),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;
        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
        } as MetaEntry;
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).rejects.toThrow();
    });
    it("should handle if storage file is too large", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(true),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(BASE_IS_NEW),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;
        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
        } as MetaEntry;
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.not.toThrow();
        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
    it("should handle if database file is too large", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(true),
                },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(TARGET_IS_NEW),
                    getPath: getPathMock,
                },
                setting: {
                    currentSettings: () => ({}),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
                fileHandler: {
                    storeFileToDB: storeFileToDBMock,
                    dbToStorage: dbToStorageMock,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;
        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
        } as MetaEntry;
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.not.toThrow();
        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
});

describe("syncStorageAndDatabase", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should skip sync if document has conflicts", async () => {
        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
            },
            serviceModules: {},
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 100,
            _conflicts: ["conflict1"],
        } as MetaEntry;

        const xLogger = vi.fn(logger);
        await syncStorageAndDatabase(host, xLogger, file, LOG_LEVEL_INFO, doc);
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("has conflicts."), LOG_LEVEL_INFO);
    });

    it("should skip sync if file size is too large", async () => {
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn((size: number) => size > 1000),
                },
                path: {
                    getPath: getPathMock,
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                },
            },
            serviceModules: {},
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 9999 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 9999,
        } as MetaEntry;

        await syncStorageAndDatabase(host, logger, file, LOG_LEVEL_INFO, doc);

        // expect(syncMock).not.toHaveBeenCalled();
    });
    it("should perform sync when conditions are met", async () => {
        const syncMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                vault: {
                    isFileSizeTooLarge: vi.fn((size: number) => size > 10000),
                },
                path: {
                    getPath: getPathMock,
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                },
            },
            serviceModules: {
                storageAccess: {
                    getFileStub: vi.fn().mockReturnValue({
                        path: "test.md",
                        stat: { size: 100 },
                    }),
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 9999 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            path: "test.md",
            size: 9999,
        } as MetaEntry;

        const xLogger = vi.fn(logger);
        await syncStorageAndDatabase(host, xLogger, file, LOG_LEVEL_INFO, doc);
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("STORAGE == DB :"), LOG_LEVEL_DEBUG);
        expect(syncMock).not.toHaveBeenCalled();
    });
});

describe("performFullScan", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should return false if canProceedScan fails", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const host = {
            services: {
                setting: {
                    currentSettings: () => ({
                        isConfigured: false,
                    }),
                },
                keyValueDB: {},
            },
            serviceModules: {},
        } as any;

        const result = await performFullScan(host, logger, errorManager as any, false, false);

        expect(result).toBe(false);
    });

    it("should perform full scan when conditions are met", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        async function* mockFindAllDocs() {
            // Empty
        }

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "doc1",
                path: "file1.md",
                size: 100,
                type: "newnote",
            };
            await Promise.resolve(); // Ensure this is treated as async
        }

        const kvDBSetMock = vi.fn();

        const host = {
            services: {
                setting: {
                    currentSettings: () => ({
                        isConfigured: true,
                        suspendFileWatching: false,
                        maxMTimeForReflectEvents: 0,
                        handleFilenameCaseSensitive: true,
                        automaticallyDeleteMetadataOfDeletedFiles: 0,
                    }),
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue(true),
                        set: kvDBSetMock,
                    },
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                database: {
                    localDatabase: {
                        findAllDocs: vi.fn().mockReturnValue(mockFindAllDocs()),
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                        isReady: true,
                    },
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                },
                fileProcessing: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockReturnValue([{ path: "file1.md", stat: { size: 100 } }]),
                    restoreState: vi.fn(),
                },
                fileHandler: {
                    storeFileToDB: vi.fn(),
                    dbToStorage: vi.fn(),
                },
            },
        } as any;

        const result = await performFullScan(host, logger, errorManager as any, false, false);

        expect(result).toBe(true);
        expect(host.serviceModules.storageAccess.restoreState).toHaveBeenCalled();
    });
});

describe("prepareDatabaseForUse", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should initialize database and scan vault", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const scanVaultMock = vi.fn().mockResolvedValue(true);
        const markIsReadyMock = vi.fn();
        const commitPendingMock = vi.fn();
        const onDatabaseInitialisedMock = vi.fn().mockResolvedValue(true);

        const host = {
            services: {
                appLifecycle: {
                    resetIsReady: vi.fn(),
                    markIsReady: markIsReadyMock,
                },
                database: {
                    localDatabase: {
                        isReady: true,
                    },
                    openDatabase: vi.fn().mockResolvedValue(true),
                },
                vault: {
                    scanVault: scanVaultMock,
                },
                databaseEvents: {
                    onDatabaseInitialised: onDatabaseInitialisedMock,
                },
                fileProcessing: {
                    commitPendingFileEvents: commitPendingMock,
                },
            },
            serviceModules: {},
        } as any;

        const result = await prepareDatabaseForUse(host, logger, errorManager as any, false, true, false);

        expect(result).toBe(true);
        expect(scanVaultMock).toHaveBeenCalled();
        expect(markIsReadyMock).toHaveBeenCalled();
        expect(commitPendingMock).toHaveBeenCalled();
    });

    it("should handle initialization failure", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        const onDatabaseInitialisedMock = vi.fn().mockResolvedValue(false);

        const host = {
            services: {
                appLifecycle: {
                    resetIsReady: vi.fn(),
                    markIsReady: vi.fn(),
                },
                database: {
                    localDatabase: {
                        isReady: true,
                    },
                    openDatabase: vi.fn().mockResolvedValue(true),
                },
                vault: {
                    scanVault: vi.fn().mockResolvedValue(true),
                },
                databaseEvents: {
                    onDatabaseInitialised: onDatabaseInitialisedMock,
                },
                fileProcessing: {
                    commitPendingFileEvents: vi.fn(),
                },
            },
            serviceModules: {},
        } as any;

        const result = await prepareDatabaseForUse(host, logger, errorManager as any, false, true, false);

        expect(result).toBe(false);
        expect(errorManager.showError).toHaveBeenCalledWith(expect.stringContaining("failed"), LOG_LEVEL_NOTICE);
    });
});

describe("useOfflineScanner", () => {
    // let logger: LogFunction;

    // beforeAll(() => {
    //     logger = createLogger("TestLogger");
    // });

    it("should bind handlers to lifecycle events", () => {
        const addHandlerMock1 = vi.fn();

        const host = {
            services: {
                API: APIServiceMock,
                appLifecycle: {
                    getUnresolvedMessages: {
                        addHandler: vi.fn(),
                    },
                },
                databaseEvents: {
                    onDatabaseInitialised: {
                        addHandler: vi.fn(),
                    },
                },
                vault: {
                    scanVault: {
                        addHandler: addHandlerMock1,
                    },
                },
            },
            serviceModules: {},
        } as any;

        useOfflineScanner(host);
        expect(addHandlerMock1).toHaveBeenCalledWith(expect.any(Function));
    });
});
