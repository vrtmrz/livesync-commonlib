import { describe, it, expect, beforeAll, vi } from "vitest";

import {
    collectDeletedFiles,
    ExtraOnLocal,
    ExtraOnRemote,
    FilePairProcessResults,
    FullScanModes,
    normaliseFullScanOptions,
    getFilePairState,
    getPathFromEntry,
    inspectMetadataDocumentIdentity,
    resolveFilePairAction,
    syncFileBetweenDBandStorage,
    synchroniseAllFilesBetweenDBandStorage,
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
import { createServiceContext } from "@lib/services/base/ServiceBase";

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
                context: createServiceContext(),
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

describe("inspectMetadataDocumentIdentity", () => {
    it.each([
        ["i:settings-entry", "i:.obsidian/settings.json", "internal"],
        ["ix:customisation-entry", "ix:plugin/data.md", "customisation"],
        ["ps:plugin-entry", "ps:plugin/data.md", "plugin-storage"],
    ])(
        "should delegate %s Metadata when its identifier and path use the same special namespace",
        async (actualDocumentId, declaredPath, namespace) => {
            const path2id = vi.fn();
            const host = {
                services: {
                    context: createServiceContext(),
                    path: {
                        getPath: vi.fn((doc: MetaEntry) => doc.path),
                        path2id,
                    },
                },
                serviceModules: {},
            } as any;
            const doc = {
                _id: actualDocumentId,
                path: declaredPath,
                type: "newnote",
                children: [],
            } as MetaEntry;

            await expect(inspectMetadataDocumentIdentity(host, doc)).resolves.toEqual({
                status: "excluded",
                actualDocumentId,
                declaredPath,
                namespace,
            });
            expect(path2id).not.toHaveBeenCalled();
        }
    );

    it("should leave a cross-namespace Metadata entry unresolved", async () => {
        const path2id = vi.fn();
        const host = {
            services: {
                context: createServiceContext(),
                path: {
                    getPath: vi.fn((doc: MetaEntry) => doc.path),
                    path2id,
                },
            },
            serviceModules: {},
        } as any;
        const doc = {
            _id: "i:settings-entry",
            path: "ordinary.md",
            type: "newnote",
            children: [],
        } as MetaEntry;

        await expect(inspectMetadataDocumentIdentity(host, doc)).resolves.toEqual({
            status: "unresolved",
            diagnostic: {
                reason: "namespace-mismatch",
                actualDocumentId: "i:settings-entry",
                declaredPath: "ordinary.md",
                actualNamespace: "internal",
                declaredPathNamespace: "normal",
            },
        });
        expect(path2id).not.toHaveBeenCalled();
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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
                context: createServiceContext(),
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

    it("should quarantine an expired logical deletion whose document ID does not represent its path", async () => {
        const expiredDoc = {
            _id: "f:stale",
            _rev: "4-stale",
            path: "renamed.md",
            deleted: true,
            mtime: Date.now() - 100 * 86400 * 1000,
            type: "plain",
            children: [],
            eden: {},
        };

        async function* mockFindAllDocs() {
            yield expiredDoc;
        }

        const putRawMock = vi.fn();
        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        automaticallyDeleteMetadataOfDeletedFiles: 30,
                    }),
                },
                path: {
                    getPath: vi.fn((doc: typeof expiredDoc) => doc.path),
                    path2id: vi.fn(async () => "f:renamed"),
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
                context: createServiceContext(),
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

    it("should omit built-in ignored files even when the vault accepts them", async () => {
        const mockFiles = [
            { path: "ordinary.md", stat: { size: 100 } },
            { path: "livesync_log_2024-09-30.md", stat: { size: 200 } },
            { path: "LIVESYNC_LOG_2024-09-30.md", stat: { size: 300 } },
            { path: "redflag.md", stat: { size: 0 } },
        ];

        const host = {
            services: {
                context: createServiceContext(),
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
            handleFilenameCaseSensitive: true,
        } as ObsidianLiveSyncSettings;

        const result = await collectFilesOnStorage(host, settings, logger);

        expect(result.storageFileNames).toEqual(["ordinary.md"]);
    });

    it("should handle case-insensitive filenames", async () => {
        const mockFiles = [
            { path: "File1.md", stat: { size: 100 } },
            { path: "FILE2.MD", stat: { size: 200 } },
        ];

        const host = {
            services: {
                context: createServiceContext(),
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
            { _id: "file1.md", path: "file1.md", size: 100, type: "newnote", mtime: 1000, ctime: 900, children: [] },
            { _id: "file2.txt", path: "file2.txt", size: 200, type: "newnote", mtime: 2000, ctime: 1900, children: [] },
        ];

        async function* mockFindAllNormalDocs() {
            yield mockDocs[0];
            yield mockDocs[1];
            await Promise.resolve(); // Ensure this is treated as async
        }

        const getPathMock = vi.fn((doc: any) => doc.path);

        const host = {
            services: {
                context: createServiceContext(),
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
                    path2id: vi.fn(async (path: string) => path),
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

    it("should omit built-in ignored documents even when the vault accepts them", async () => {
        const mockDocs = [
            {
                _id: "ordinary.md",
                path: "ordinary.md",
                size: 100,
                type: "newnote",
                mtime: 1000,
                ctime: 900,
                children: [],
            },
            {
                _id: "livesync_log_2024-09-30.md",
                path: "livesync_log_2024-09-30.md",
                size: 200,
                type: "newnote",
                mtime: 2000,
                ctime: 1900,
                children: [],
            },
            {
                _id: "LIVESYNC_LOG_2024-09-30.md",
                path: "LIVESYNC_LOG_2024-09-30.md",
                size: 300,
                type: "newnote",
                mtime: 3000,
                ctime: 2900,
                children: [],
            },
            {
                _id: "redflag.md",
                path: "redflag.md",
                size: 0,
                type: "newnote",
                mtime: 4000,
                ctime: 3900,
                children: [],
            },
        ];

        async function* mockFindAllNormalDocs() {
            for (const doc of mockDocs) {
                yield doc;
            }
        }

        const host = {
            services: {
                context: createServiceContext(),
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
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
            },
            serviceModules: {},
        } as any;

        const settings = {
            handleFilenameCaseSensitive: true,
        } as ObsidianLiveSyncSettings;

        const result = await collectDatabaseFiles(host, settings, logger, false);

        expect(result.databaseFileNames).toEqual(["ordinary.md"]);
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
                context: createServiceContext(),
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

        await expect(updateToDatabase(host, logger, LOG_LEVEL_INFO, file)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(storeFileToDBMock).toHaveBeenCalledWith(file);
    });

    it("should skip file if size is too large", async () => {
        const storeFileToDBMock = vi.fn();

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(updateToDatabase(host, logger, LOG_LEVEL_INFO, file)).resolves.toBe(
            FilePairProcessResults.SKIPPED
        );

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
                context: createServiceContext(),
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

        await expect(updateToStorage(host, logger, LOG_LEVEL_INFO, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(dbToStorageMock).toHaveBeenCalledWith("test.md", null, true);
    });

    it("should skip if document is deleted", async () => {
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(updateToStorage(host, logger, LOG_LEVEL_INFO, doc)).resolves.toBe(FilePairProcessResults.SKIPPED);

        expect(dbToStorageMock).not.toHaveBeenCalled();
    });

    it("should skip if document has conflicts", async () => {
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(updateToStorage(host, logger, LOG_LEVEL_INFO, doc)).resolves.toBe(FilePairProcessResults.SKIPPED);

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
                context: createServiceContext(),
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

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(storeFileToDBMock).toHaveBeenCalled();
    });

    it("should sync from database to storage when database is newer", async () => {
        const dbToStorageMock = vi.fn().mockResolvedValue(true);
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(dbToStorageMock).toHaveBeenCalledWith(doc, "test.md", false);
    });

    it("should do nothing when files are equal", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
    it("should handle if document cannot be found in database", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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
    it("should not require refetching file stub from storage", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");
        const compareFileFreshnessMock = vi.fn().mockReturnValue(EVEN);

        const host = {
            services: {
                context: createServiceContext(),
                vault: {
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    compareFileFreshness: compareFileFreshnessMock,
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
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );
        expect(compareFileFreshnessMock).toHaveBeenCalledWith(file, doc);
    });
    it("should handle if storage file is too large", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.SKIPPED
        );
        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });
    it("should handle if database file is too large", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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
        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.SKIPPED
        );
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
                context: createServiceContext(),
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
        await expect(syncStorageAndDatabase(host, xLogger, file, LOG_LEVEL_INFO, doc)).resolves.toBe(
            FilePairProcessResults.SKIPPED
        );
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("has conflicts."), LOG_LEVEL_INFO);
    });

    it("should skip sync if file size is too large", async () => {
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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

        await expect(syncStorageAndDatabase(host, logger, file, LOG_LEVEL_INFO, doc)).resolves.toBe(
            FilePairProcessResults.SKIPPED
        );

        // expect(syncMock).not.toHaveBeenCalled();
    });
    it("should perform sync when conditions are met", async () => {
        const syncMock = vi.fn();
        const getPathMock = vi.fn().mockReturnValue("test.md");

        const host = {
            services: {
                context: createServiceContext(),
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
        await expect(syncStorageAndDatabase(host, xLogger, file, LOG_LEVEL_INFO, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("STORAGE == DB :"), LOG_LEVEL_DEBUG);
        expect(syncMock).not.toHaveBeenCalled();
    });
});

describe("getFilePairState", () => {
    it("should classify storage-only pairs", () => {
        const result = getFilePairState({
            file: { path: "local.md", stat: { size: 10, mtime: 100 } } as UXFileInfoStub,
            doc: undefined,
        });

        expect(result).toBe("storage-only");
    });

    it("should classify deleted database pairs that exist on both sides", () => {
        const result = getFilePairState({
            file: { path: "local.md", stat: { size: 10, mtime: 100 } } as UXFileInfoStub,
            doc: { path: "local.md", mtime: 50, deleted: true } as MetaEntry,
        });

        expect(result).toBe("both-db-deleted");
    });

    it("should classify database-only pairs", () => {
        const result = getFilePairState({
            file: undefined,
            doc: { path: "remote.md", mtime: 50, deleted: false } as MetaEntry,
        });

        expect(result).toBe("db-only");
    });

    it("should classify deleted database-only pairs", () => {
        const result = getFilePairState({
            file: undefined,
            doc: { path: "remote.md", mtime: 50, _deleted: true } as MetaEntry,
        });

        expect(result).toBe("db-only-deleted");
    });

    it("should throw when pair is corrupted", () => {
        expect(() => getFilePairState({ file: undefined, doc: undefined } as any)).toThrow("Corrupted file pair");
    });
});

describe("resolveFilePairAction", () => {
    const states = ["storage-only", "db-only", "db-only-deleted", "both", "both-db-deleted"] as const;
    const modes = [FullScanModes.DB_APPLY, FullScanModes.NEWER_WINS] as const;
    const extraOnRemoteValues = [undefined, ExtraOnRemote.DELETE_LOCAL_MISSING] as const;
    const extraOnLocalValues = [
        undefined,
        ExtraOnLocal.DELETE_DB_DELETED,
        ExtraOnLocal.DELETE_DB_MISSING,
        ExtraOnLocal.APPEND_STORAGE_ONLY,
    ] as const;

    function expectedAction(
        state: (typeof states)[number],
        mode: (typeof modes)[number],
        extraOnRemote: (typeof extraOnRemoteValues)[number],
        extraOnLocal: (typeof extraOnLocalValues)[number]
    ) {
        const deleteWhenRemoteMissing =
            extraOnRemote === ExtraOnRemote.DELETE_LOCAL_MISSING || extraOnLocal === ExtraOnLocal.DELETE_DB_MISSING;
        const deleteWhenRemoteDeleted =
            extraOnRemote === ExtraOnRemote.DELETE_LOCAL_MISSING ||
            extraOnLocal === ExtraOnLocal.DELETE_DB_DELETED ||
            extraOnLocal === ExtraOnLocal.DELETE_DB_MISSING;

        if (mode === FullScanModes.DB_APPLY) {
            if (state === "both" || state === "db-only") return "update-storage";
            if (state === "storage-only") return deleteWhenRemoteMissing ? "delete-local" : "skip";
            if (state === "both-db-deleted") return deleteWhenRemoteDeleted ? "delete-local" : "skip";
            return "skip";
        }

        if (state === "both") return "sync-newer";
        if (state === "storage-only") return deleteWhenRemoteMissing ? "delete-local" : "update-db";
        if (state === "db-only") return "update-storage";
        if (state === "both-db-deleted") {
            if (deleteWhenRemoteDeleted) return "delete-local";
            return extraOnLocal === ExtraOnLocal.APPEND_STORAGE_ONLY ? "update-db" : "skip";
        }
        return "skip";
    }

    for (const mode of modes) {
        for (const state of states) {
            for (const extraOnRemote of extraOnRemoteValues) {
                for (const extraOnLocal of extraOnLocalValues) {
                    it(`should resolve mode=${mode}, state=${state}, remote=${extraOnRemote ?? "none"}, local=${extraOnLocal ?? "none"}`, () => {
                        const result = resolveFilePairAction(state, {
                            mode,
                            extraOnRemote,
                            extraOnLocal,
                        });

                        expect(result).toBe(expectedAction(state, mode, extraOnRemote, extraOnLocal));
                    });
                }
            }
        }
    }
});

describe("normaliseFullScanOptions", () => {
    it("should default to newer-wins and inherit object options", () => {
        const options = normaliseFullScanOptions({
            showingNotice: true,
            extraOnLocal: ExtraOnLocal.DELETE_DB_MISSING,
        });

        expect(options.mode).toBe(FullScanModes.NEWER_WINS);
        expect(options.showingNotice).toBe(true);
        expect(options.extraOnLocal).toBe(ExtraOnLocal.DELETE_DB_MISSING);
    });

    it("should map boolean arguments into options", () => {
        const options = normaliseFullScanOptions(true, true);

        expect(options.mode).toBe(FullScanModes.NEWER_WINS);
        expect(options.showingNotice).toBe(true);
        expect(options.ignoreSuspending).toBe(true);
    });
});

describe("synchroniseAllFilesBetweenDBandStorage", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should process mixed file-set actions in db-apply mode", async () => {
        const deleteMock = vi.fn().mockResolvedValue(undefined);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        const storageFiles = [
            { path: "local-only.md", stat: { size: 10, mtime: 20 } },
            { path: "both.md", stat: { size: 11, mtime: 21 } },
            { path: "both-deleted.md", stat: { size: 12, mtime: 22 } },
        ];

        async function* mockFindAllNormalDocs() {
            yield { _id: "both.md", path: "both.md", size: 11, mtime: 10, type: "newnote", children: [] };
            yield { _id: "db-only.md", path: "db-only.md", size: 13, mtime: 10, type: "newnote", children: [] };
            yield {
                _id: "both-deleted.md",
                path: "both-deleted.md",
                size: 12,
                mtime: 10,
                deleted: true,
                type: "newnote",
                children: [],
            };
            yield {
                _id: "db-only-deleted.md",
                path: "db-only-deleted.md",
                size: 12,
                mtime: 10,
                _deleted: true,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue(storageFiles),
                    delete: deleteMock,
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.DB_APPLY,
            extraOnRemote: ExtraOnRemote.DELETE_LOCAL_MISSING,
        });

        expect(deleteMock).toHaveBeenCalledTimes(2);
        expect(deleteMock).toHaveBeenCalledWith("local-only.md", true);
        expect(deleteMock).toHaveBeenCalledWith("both-deleted.md", true);
        expect(dbToStorageMock).toHaveBeenCalledTimes(2);
        expect(dbToStorageMock).toHaveBeenCalledWith("both.md", null, true);
        expect(dbToStorageMock).toHaveBeenCalledWith("db-only.md", null, true);
    });

    it("should continue even if one pair processing fails", async () => {
        const xLogger = vi.fn(logger);
        const deleteMock = vi.fn().mockRejectedValueOnce(new Error("delete failed")).mockResolvedValueOnce(undefined);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        const storageFiles = [
            { path: "local-only.md", stat: { size: 10, mtime: 20 } },
            { path: "both-deleted.md", stat: { size: 12, mtime: 22 } },
        ];

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "both-deleted.md",
                path: "both-deleted.md",
                size: 12,
                mtime: 10,
                deleted: true,
                type: "newnote",
                children: [],
            };
            yield { _id: "db-only.md", path: "db-only.md", size: 13, mtime: 10, type: "newnote", children: [] };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue(storageFiles),
                    delete: deleteMock,
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                },
            },
        } as any;

        await expect(
            synchroniseAllFilesBetweenDBandStorage(host, xLogger, {} as any, {
                mode: FullScanModes.DB_APPLY,
                extraOnRemote: ExtraOnRemote.DELETE_LOCAL_MISSING,
            })
        ).resolves.not.toThrow();

        expect(dbToStorageMock).toHaveBeenCalledWith("db-only.md", null, true);
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("Error processing"), LOG_LEVEL_NOTICE);
    });

    it("should skip conflicted entries before delete-local action", async () => {
        const deleteMock = vi.fn().mockResolvedValue(undefined);

        const storageFiles = [{ path: "both-deleted.md", stat: { size: 12, mtime: 22 } }];

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "both-deleted.md",
                path: "both-deleted.md",
                size: 12,
                mtime: 10,
                deleted: true,
                _conflicts: ["conflicted-rev"],
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue(storageFiles),
                    delete: deleteMock,
                },
                fileHandler: {
                    dbToStorage: vi.fn().mockResolvedValue(true),
                    storeFileToDB: vi.fn(),
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.DB_APPLY,
            extraOnRemote: ExtraOnRemote.DELETE_LOCAL_MISSING,
        });

        expect(deleteMock).not.toHaveBeenCalled();
    });

    it("should skip oversize entries inside mixed newer-wins file-set", async () => {
        const storeFileToDBMock = vi.fn();
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        const storageFiles = [
            { path: "storage-too-large.md", stat: { size: 5000, mtime: 20 } },
            { path: "both-too-large.md", stat: { size: 5000, mtime: 20 } },
            { path: "both-normal.md", stat: { size: 100, mtime: 20 } },
        ];

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "db-too-large.md",
                path: "db-too-large.md",
                size: 5000,
                mtime: 10,
                type: "newnote",
                children: [],
            };
            yield {
                _id: "both-too-large.md",
                path: "both-too-large.md",
                size: 100,
                mtime: 10,
                type: "newnote",
                children: [],
            };
            yield { _id: "both-normal.md", path: "both-normal.md", size: 50, mtime: 10, type: "newnote", children: [] };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn((size: number) => size > 1000),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                    compareFileFreshness: vi.fn((file: UXFileInfoStub) =>
                        file.path === "both-normal.md" ? BASE_IS_NEW : EVEN
                    ),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue(storageFiles),
                    getFileStub: vi.fn((path: string) => storageFiles.find((e) => e.path === path)),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: storeFileToDBMock,
                },
            },
        } as any;

        const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(result).toBe(true);
        expect(storeFileToDBMock).toHaveBeenCalledTimes(1);
        expect(storeFileToDBMock).toHaveBeenCalledWith(expect.objectContaining({ path: "both-normal.md" }));
        expect(storeFileToDBMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: "storage-too-large.md" }));
        expect(dbToStorageMock).not.toHaveBeenCalledWith("db-too-large.md", null, true);
    });

    it("should not record an oversized database-only entry as a reflected local file", async () => {
        vi.useFakeTimers();
        let sizeLimitActive = true;
        let persistedFileStatus: Record<string, number> = {};
        const dbToStorageMock = vi.fn().mockResolvedValue(true);
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "oversized.md",
                path: "oversized.md",
                size: 5000,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn((size: number) => sizeLimitActive && size > 1000),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockImplementation(() => mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockImplementation(async () => ({ ...persistedFileStatus })),
                        set: vi.fn().mockImplementation(async (key: string, value: Record<string, number>) => {
                            if (key === "fileStatusMap") persistedFileStatus = { ...value };
                        }),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        try {
            const firstResult = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.DB_APPLY,
            });
            await vi.runAllTimersAsync();
            const persistedAfterSkip = { ...persistedFileStatus };

            sizeLimitActive = false;
            const secondResult = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.NEWER_WINS,
            });

            expect(firstResult).toBe(true);
            expect(secondResult).toBe(true);
            expect(persistedAfterSkip).not.toHaveProperty("oversized.md");
            expect(dbToStorageMock).toHaveBeenCalledTimes(1);
            expect(deleteFileFromDBMock).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should fail when a newer database entry cannot replace an existing storage file", async () => {
        vi.useFakeTimers();
        let persistedFileStatus: Record<string, number> = {};
        const eventMock = vi.fn();
        const dbToStorageMock = vi.fn().mockResolvedValue(false);
        const storageFile = { path: "both.md", stat: { size: 100, mtime: 5000 } };

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "both.md",
                path: "both.md",
                size: 100,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: { events: { emitEvent: eventMock } },
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                    compareFileFreshness: vi.fn().mockReturnValue(TARGET_IS_NEW),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockImplementation(() => mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockImplementation(async () => ({ ...persistedFileStatus })),
                        set: vi.fn().mockImplementation(async (key: string, value: Record<string, number>) => {
                            if (key === "fileStatusMap") persistedFileStatus = { ...value };
                        }),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([storageFile]),
                    getFileStub: vi.fn().mockResolvedValue(storageFile),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: vi.fn(),
                },
            },
        } as any;

        try {
            const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.NEWER_WINS,
            });
            await vi.runAllTimersAsync();

            expect(result).toBe(false);
            expect(persistedFileStatus).toEqual({ "both.md": 5000 });
            expect(eventMock).not.toHaveBeenCalled();
            expect(dbToStorageMock).toHaveBeenCalledWith(
                expect.objectContaining({ path: "both.md" }),
                "both.md",
                false
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("should treat db-only entry as offline local deletion when last seen mtime is newer", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        async function* mockFindAllNormalDocs() {
            yield { _id: "gone.md", path: "gone.md", size: 100, mtime: 10000, type: "newnote", children: [] };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue({ "gone.md": 20000 }),
                        set: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(deleteFileFromDBMock).toHaveBeenCalledWith("gone.md");
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });

    it("should leave a mismatched metadata ID unresolved before an offline deletion decision", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "stale-document-id",
                path: "renamed.md",
                size: 100,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn().mockResolvedValue("renamed.md"),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue({ "renamed.md": 20000 }),
                        set: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(result).toBe(true);
        expect(deleteFileFromDBMock).not.toHaveBeenCalled();
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });

    it("should keep processing a resolvable path when stale Metadata also claims it", async () => {
        const storeFileToDB = vi.fn().mockResolvedValue(true);
        const dbToStorage = vi.fn().mockResolvedValue(true);
        const deleteFileFromDB = vi.fn().mockResolvedValue(true);

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "shared.md",
                path: "Shared.md",
                size: 100,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
            yield {
                _id: "stale-shared-id",
                path: "shared.md",
                size: 100,
                mtime: 9000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: false,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn().mockResolvedValue("shared.md"),
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue({}),
                        set: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([{ path: "Shared.md", stat: { size: 100, mtime: 10000 } }]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage,
                    storeFileToDB,
                    deleteFileFromDB,
                },
            },
        } as any;

        const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(result).toBe(true);
        expect(storeFileToDB).not.toHaveBeenCalled();
        expect(dbToStorage).not.toHaveBeenCalled();
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(host.services.path.compareFileFreshness).toHaveBeenCalledOnce();
    });

    it("should retry a failed database reflection instead of persisting it as a local deletion", async () => {
        vi.useFakeTimers();
        let persistedFileStatus: Record<string, number> = {};
        const dbToStorageMock = vi.fn().mockResolvedValue(false);
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const eventMock = vi.fn();
        const logSpy = vi.fn();

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "missing.md",
                path: "missing.md",
                size: 100,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: { events: { emitEvent: eventMock } },
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockImplementation(() => mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockImplementation(async () => ({ ...persistedFileStatus })),
                        set: vi.fn().mockImplementation(async (key: string, value: Record<string, number>) => {
                            if (key === "fileStatusMap") persistedFileStatus = { ...value };
                        }),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        try {
            const firstResult = await synchroniseAllFilesBetweenDBandStorage(
                host,
                logSpy as unknown as LogFunction,
                {} as any,
                { mode: FullScanModes.DB_APPLY }
            );
            await vi.runAllTimersAsync();
            const persistedAfterFailedReflection = { ...persistedFileStatus };

            const secondResult = await synchroniseAllFilesBetweenDBandStorage(
                host,
                logSpy as unknown as LogFunction,
                {} as any,
                { mode: FullScanModes.NEWER_WINS }
            );
            await vi.runAllTimersAsync();

            expect(firstResult).toBe(false);
            expect(secondResult).toBe(false);
            expect(persistedAfterFailedReflection).not.toHaveProperty("missing.md");
            expect(dbToStorageMock).toHaveBeenCalledTimes(2);
            expect(deleteFileFromDBMock).not.toHaveBeenCalled();
            expect(eventMock).not.toHaveBeenCalled();
            expect(
                logSpy.mock.calls.some(([message]) => String(message).includes("Check or pull from db:missing.md OK"))
            ).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("should keep the last-seen record when the database delete reports nothing was deleted", async () => {
        // Regression guard: when deleteFileFromDB returns false (nothing was
        // tombstoned), the delete-db path must not clear the file's last-seen
        // record. Otherwise the next scan reclassifies the doc as database-only
        // and resurrects the deleted file.
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(false);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);
        const kvDBSetMock = vi.fn().mockResolvedValue(undefined);
        const logSpy = vi.fn();

        async function* mockFindAllNormalDocs() {
            yield { _id: "gone.md", path: "gone.md", size: 100, mtime: 10000, type: "newnote", children: [] };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue({ "gone.md": 20000 }),
                        set: kvDBSetMock,
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        const result = await synchroniseAllFilesBetweenDBandStorage(host, logSpy as unknown as LogFunction, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(result).toBe(false);
        expect(deleteFileFromDBMock).toHaveBeenCalledWith("gone.md");
        // The no-op delete must be reported rather than silently dropping the record.
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("keeping last-seen record"), LOG_LEVEL_NOTICE);
        // The last-seen record for the still-present document must survive, so any
        // persisted file-status map continues to include it.
        for (const call of kvDBSetMock.mock.calls) {
            if (call[0] === "fileStatusMap") {
                expect(call[1]).toHaveProperty("gone.md");
            }
        }
        // No resurrection: the file is not written back to storage.
        expect(dbToStorageMock).not.toHaveBeenCalled();
    });

    it("should keep db-only entry when database mtime is newer than last seen", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const dbToStorageMock = vi.fn().mockResolvedValue(true);

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "remote-new.md",
                path: "remote-new.md",
                size: 100,
                mtime: 50000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: {
                    currentSettings: () => ({
                        handleFilenameCaseSensitive: true,
                    }),
                },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
                database: {
                    localDatabase: {
                        findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                    },
                },
                keyValueDB: {
                    kvDB: {
                        get: vi.fn().mockResolvedValue({ "remote-new.md": 10000 }),
                        set: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    delete: vi.fn(),
                },
                fileHandler: {
                    dbToStorage: dbToStorageMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(dbToStorageMock).toHaveBeenCalledWith("remote-new.md", null, true);
        expect(deleteFileFromDBMock).not.toHaveBeenCalled();
    });

    it("should persist file status map after deferred save", async () => {
        vi.useFakeTimers();
        const kvDBSetMock = vi.fn().mockResolvedValue(undefined);

        try {
            async function* mockFindAllNormalDocs() {
                // no db docs
            }

            const host = {
                services: {
                    context: createServiceContext(),
                    setting: {
                        currentSettings: () => ({
                            handleFilenameCaseSensitive: true,
                        }),
                    },
                    vault: {
                        isTargetFile: vi.fn().mockResolvedValue(true),
                        isValidPath: vi.fn().mockReturnValue(true),
                        isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                    },
                    path: {
                        getPath: vi.fn((doc: any) => doc.path),
                        path2id: vi.fn(async (path: string) => path),
                    },
                    fileProcessing: {},
                    database: {
                        localDatabase: {
                            findAllNormalDocs: vi.fn().mockReturnValue(mockFindAllNormalDocs()),
                        },
                    },
                    keyValueDB: {
                        kvDB: {
                            get: vi.fn().mockResolvedValue({}),
                            set: kvDBSetMock,
                        },
                    },
                },
                serviceModules: {
                    storageAccess: {
                        getFiles: vi.fn().mockResolvedValue([{ path: "local.md", stat: { size: 10, mtime: 123 } }]),
                        delete: vi.fn(),
                    },
                    fileHandler: {
                        dbToStorage: vi.fn().mockResolvedValue(true),
                        storeFileToDB: vi.fn().mockResolvedValue(true),
                        deleteFileFromDB: vi.fn().mockResolvedValue(true),
                    },
                },
            } as any;

            await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.NEWER_WINS,
            });

            await vi.advanceTimersByTimeAsync(1100);
            expect(kvDBSetMock).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
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
                context: createServiceContext(),
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
                _id: "file1.md",
                path: "file1.md",
                size: 100,
                type: "newnote",
            };
            await Promise.resolve(); // Ensure this is treated as async
        }

        const kvDBSetMock = vi.fn();

        const host = {
            services: {
                context: createServiceContext(),
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
                    path2id: vi.fn(async (path: string) => path),
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

    it("should accept the options object form", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        async function* mockFindAllDocs() {
            // Empty
        }

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "file1.md",
                path: "file1.md",
                size: 100,
                type: "newnote",
            };
            await Promise.resolve();
        }

        const host = {
            services: {
                context: createServiceContext(),
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
                        set: vi.fn(),
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
                    path2id: vi.fn(async (path: string) => path),
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                },
                fileProcessing: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockReturnValue([{ path: "file1.md", stat: { size: 100, mtime: 100 } }]),
                    restoreState: vi.fn(),
                    getFileStub: vi.fn().mockResolvedValue({ path: "file1.md", stat: { size: 100, mtime: 100 } }),
                },
                fileHandler: {
                    storeFileToDB: vi.fn(),
                    dbToStorage: vi.fn(),
                },
            },
        } as any;

        const result = await performFullScan(host, logger, errorManager as any, {
            mode: FullScanModes.NEWER_WINS,
            showingNotice: true,
        });

        expect(result).toBe(true);
        expect(host.serviceModules.storageAccess.restoreState).toHaveBeenCalled();
    });

    it("should return false after completing a scan which contains a failed reflection", async () => {
        const errorManager = {
            showError: vi.fn(),
            clearError: vi.fn(),
        };

        async function* mockFindAllDocs() {
            // Empty
        }

        async function* mockFindAllNormalDocs() {
            yield {
                _id: "missing.md",
                path: "missing.md",
                size: 100,
                mtime: 10000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
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
                        get: vi.fn().mockImplementation(async (key: string) => (key === "initialized" ? false : {})),
                        set: vi.fn(),
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
                    path2id: vi.fn(async (path: string) => path),
                },
                fileProcessing: {},
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([]),
                    restoreState: vi.fn(),
                },
                fileHandler: {
                    storeFileToDB: vi.fn(),
                    dbToStorage: vi.fn().mockResolvedValue(false),
                },
            },
        } as any;

        const result = await performFullScan(host, logger, errorManager as any, {
            mode: FullScanModes.DB_APPLY,
        });

        expect(result).toBe(false);
        expect(host.services.keyValueDB.kvDB.set).toHaveBeenCalledWith("initialized", true);
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
        const commitPendingMock = vi.fn().mockResolvedValue(true);
        const onDatabaseInitialisedMock = vi.fn().mockResolvedValue(true);

        const host = {
            services: {
                context: createServiceContext(),
                appLifecycle: {
                    resetIsReady: vi.fn(),
                    markIsReady: markIsReadyMock,
                },
                database: {
                    localDatabase: {
                        isReady: true,
                    },
                    isDatabaseReady: vi.fn(() => true),
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
                context: createServiceContext(),
                appLifecycle: {
                    resetIsReady: vi.fn(),
                    markIsReady: vi.fn(),
                },
                database: {
                    localDatabase: {
                        isReady: true,
                    },
                    isDatabaseReady: vi.fn(() => true),
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
                context: createServiceContext(),
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
