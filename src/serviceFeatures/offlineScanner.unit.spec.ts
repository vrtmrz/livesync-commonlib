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
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { cancelFileStatusSave, saveFileStatus } from "./offlineScanner/fileStatus";
import { prepareDatabaseForUse } from "./prepareDatabaseForUse";
import { type LogFunction, createInstanceLogFunction } from "@lib/services/lib/logUtils";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import type { MetaEntry, UXFileInfoStub, FilePathWithPrefix, ObsidianLiveSyncSettings } from "@lib/common/types";
import { LOG_LEVEL_DEBUG, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/types";
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

    it("normalises identity paths only in version one for both filename case modes", () => {
        const nfcPath = "Caf\u00e9/Note.md";
        const nfdPath = nfcPath.normalize("NFD");

        expect(
            convertCase(
                { handleFilenameCaseSensitive: true, pathNormalizationVersion: 0 } as ObsidianLiveSyncSettings,
                nfdPath as FilePathWithPrefix
            )
        ).toBe(nfdPath);
        expect(
            convertCase(
                { handleFilenameCaseSensitive: false, pathNormalizationVersion: 0 } as ObsidianLiveSyncSettings,
                nfdPath as FilePathWithPrefix
            )
        ).toBe(nfdPath.toLowerCase());
        expect(
            convertCase(
                { handleFilenameCaseSensitive: true, pathNormalizationVersion: 1 } as ObsidianLiveSyncSettings,
                nfdPath as FilePathWithPrefix
            )
        ).toBe(nfcPath);
        expect(
            convertCase(
                { handleFilenameCaseSensitive: false, pathNormalizationVersion: 1 } as ObsidianLiveSyncSettings,
                nfdPath as FilePathWithPrefix
            )
        ).toBe(nfcPath.toLowerCase());
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

describe("collector comparison path lookup", () => {
    it.each([true, false])(
        "keeps original paths and last colliding entry, case-sensitive=%s",
        async (caseSensitive) => {
            const paths = ["Folder/Note.md", "folder/note.md", "__proto__"];
            const files = paths.map((path) => ({
                path,
                name: path,
                stat: { type: "file", size: 1, ctime: 1, mtime: 1 },
            }));
            const docs = paths.map((path) => ({
                _id: path,
                path,
                type: "plain",
                size: 1,
                ctime: 1,
                mtime: 1,
                children: [],
            }));
            const settings = { handleFilenameCaseSensitive: caseSensitive } as ObsidianLiveSyncSettings;
            const host = {
                services: {
                    vault: { isTargetFile: async () => true, isValidPath: () => true },
                    database: { localDatabase: { findAllNormalDocs: () => docs } },
                    path: { getPath: (doc: { path: string }) => doc.path, path2id: async (path: string) => path },
                },
                serviceModules: { storageAccess: { getFiles: async () => files } },
            } as unknown as Parameters<typeof collectDatabaseFiles>[0] & Parameters<typeof collectFilesOnStorage>[0];
            const storage = await collectFilesOnStorage(host, settings, vi.fn());
            const database = await collectDatabaseFiles(host, settings, vi.fn(), false);
            const expected = Object.fromEntries(
                caseSensitive
                    ? paths.map((path) => [path, path])
                    : [
                          ["folder/note.md", "folder/note.md"],
                          ["__proto__", "__proto__"],
                      ]
            );
            expect(storage.storageFileNameCI2CS).toEqual(expected);
            expect(database.databaseFileNameCI2CS).toEqual(expected);
            expect(Object.hasOwn(storage.storageFileNameCI2CS, "__proto__")).toBe(true);
        }
    );
});

describe("updateToDatabase", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should store file to database if size is within limit", async () => {
        const storeFileToDBMock = vi.fn().mockResolvedValue(true);

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

    it("reports a failed storage write without emitting a success event", async () => {
        const events = { emitEvent: vi.fn() };
        const storeFileToDBMock = vi.fn().mockResolvedValue(false);
        const host = {
            services: {
                context: { events },
                vault: { isFileSizeTooLarge: vi.fn().mockReturnValue(false) },
            },
            serviceModules: { fileHandler: { storeFileToDB: storeFileToDBMock } },
        } as any;
        const file = { path: "test.md", stat: { size: 100 } } as UXFileInfoStub;

        await expect(updateToDatabase(host, logger, LOG_LEVEL_INFO, file)).resolves.toBe(FilePairProcessResults.FAILED);

        expect(storeFileToDBMock).toHaveBeenCalledWith(file);
        expect(events.emitEvent).not.toHaveBeenCalled();
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
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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

        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(expect.objectContaining({ path: "test.md" }), null, true, undefined);
    });

    it("should skip if document is deleted", async () => {
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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

        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });

    it("should skip if document has conflicts", async () => {
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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

        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });
});

describe("syncFileBetweenDBandStorage", () => {
    let logger: LogFunction;

    beforeAll(() => {
        logger = createLogger("TestLogger");
    });

    it("should sync from storage to database when storage is newer", async () => {
        const storeFileToDBMock = vi.fn().mockResolvedValue(true);
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

    it("reports an unsuccessful ordinary save when storage is newer", async () => {
        const storeFileToDBMock = vi.fn().mockResolvedValue(false);
        const host = {
            services: {
                vault: { isFileSizeTooLarge: vi.fn().mockReturnValue(false) },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(BASE_IS_NEW),
                    getPath: vi.fn().mockReturnValue("test.md"),
                },
            },
            serviceModules: { fileHandler: { storeFileToDB: storeFileToDBMock } },
        } as any;
        const file = { path: "test.md", stat: { size: 100 } } as UXFileInfoStub;
        const doc = { _id: "test", path: "test.md", size: 90 } as MetaEntry;

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(FilePairProcessResults.FAILED);
        expect(storeFileToDBMock).toHaveBeenCalledWith(file);
    });

    it("should sync from database to storage when database is newer", async () => {
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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

        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(doc, "test.md", false, undefined);
    });

    it("checks missing file provenance when modification times are equal", async () => {
        const storeFileToDBMock = vi.fn();
        const reflectDatabaseEntryMock = vi.fn();
        const tryRecordUntrackedFileRevision = vi.fn().mockResolvedValue(true);
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
                    tryRecordUntrackedFileRevision,
                },
            },
        } as any;

        const file = {
            path: "test.md",
            stat: { size: 100 },
        } as UXFileInfoStub;

        const doc = {
            _id: "test",
            _rev: "2-current",
            path: "test.md",
            size: 100,
        } as MetaEntry;

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
            FilePairProcessResults.COMPLETED
        );

        expect(storeFileToDBMock).not.toHaveBeenCalled();
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
        expect(tryRecordUntrackedFileRevision).toHaveBeenCalledExactlyOnceWith(file, "2-current");
    });

    it("uses an ordinary save when equal-time provenance is not established", async () => {
        const storeFileToDBMock = vi.fn().mockResolvedValue(false);
        const tryRecordUntrackedFileRevision = vi.fn().mockResolvedValue(false);
        const host = {
            services: {
                vault: { isFileSizeTooLarge: vi.fn().mockReturnValue(false) },
                path: {
                    compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                    getPath: vi.fn().mockReturnValue("test.md"),
                },
            },
            serviceModules: {
                fileHandler: { storeFileToDB: storeFileToDBMock, tryRecordUntrackedFileRevision },
            },
        } as any;
        const file = { path: "test.md", stat: { size: 100 } } as UXFileInfoStub;
        const doc = { _id: "test", _rev: "2-current", path: "test.md", size: 100 } as MetaEntry;

        await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(FilePairProcessResults.FAILED);

        expect(tryRecordUntrackedFileRevision).toHaveBeenCalledExactlyOnceWith(file, "2-current");
        expect(storeFileToDBMock).toHaveBeenCalledExactlyOnceWith(file, false, false, { revalidateStorage: true });
    });

    it("does not start a content save after stop interrupts equal-time provenance", async () => {
        let stopping = false;
        const started = promiseWithResolvers<void>();
        const provenance = promiseWithResolvers<boolean>();
        const storeFileToDB = vi.fn(async () => true);
        const host = {
            services: {
                vault: { isFileSizeTooLarge: () => false },
                path: { compareFileFreshness: () => EVEN, getPath: () => "test.md" },
            },
            serviceModules: {
                storageAccess: { isStopping: () => stopping },
                fileHandler: {
                    storeFileToDB,
                    tryRecordUntrackedFileRevision: () => {
                        started.resolve();
                        return provenance.promise;
                    },
                },
            },
        } as unknown as Parameters<typeof syncFileBetweenDBandStorage>[0];
        const file = { path: "test.md", stat: { size: 100 } } as UXFileInfoStub;
        const doc = { _id: "test", _rev: "2-current", path: "test.md", size: 100 } as MetaEntry;

        const sync = syncFileBetweenDBandStorage(host, logger, file, doc);
        await started.promise;
        stopping = true;
        provenance.resolve(false);
        await expect(sync).resolves.toBe(FilePairProcessResults.FAILED);
        expect(storeFileToDB).not.toHaveBeenCalled();
    });

    it.each([
        { oversizedSide: "storage", fileSize: 5000, docSize: 100 },
        { oversizedSide: "database", fileSize: 100, docSize: 5000 },
    ])(
        "skips equal-time reconciliation when the $oversizedSide size exceeds the limit",
        async ({ fileSize, docSize }) => {
            const isFileSizeTooLarge = vi.fn((size: number) => size > 1000);
            const tryRecordUntrackedFileRevision = vi.fn().mockResolvedValue(false);
            const storeFileToDB = vi.fn().mockResolvedValue(true);
            const reflectDatabaseEntry = vi.fn();
            const host = {
                services: {
                    context: createServiceContext(),
                    vault: { isFileSizeTooLarge },
                    path: {
                        compareFileFreshness: vi.fn().mockReturnValue(EVEN),
                        getPath: vi.fn().mockReturnValue("test.md"),
                    },
                },
                serviceModules: {
                    fileHandler: { tryRecordUntrackedFileRevision, storeFileToDB, reflectDatabaseEntry },
                },
            } as any;
            const file = { path: "test.md", stat: { size: fileSize } } as UXFileInfoStub;
            const doc = { _id: "test", _rev: "2-current", path: "test.md", size: docSize } as MetaEntry;

            await expect(syncFileBetweenDBandStorage(host, logger, file, doc)).resolves.toBe(
                FilePairProcessResults.SKIPPED
            );

            expect(isFileSizeTooLarge).toHaveBeenCalledWith(fileSize);
            if (fileSize <= 1000) {
                expect(isFileSizeTooLarge).toHaveBeenCalledWith(docSize);
            }
            expect(tryRecordUntrackedFileRevision).not.toHaveBeenCalled();
            expect(storeFileToDB).not.toHaveBeenCalled();
            expect(reflectDatabaseEntry).not.toHaveBeenCalled();
        }
    );

    it("should handle if document cannot be found in database", async () => {
        const storeFileToDBMock = vi.fn();
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        const storeFileToDBMock = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });
    it("should handle if database file is too large", async () => {
        const storeFileToDBMock = vi.fn();
        const reflectDatabaseEntryMock = vi.fn();
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
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
        const storeFileToDBMock = vi.fn().mockResolvedValue(true);
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
                fileHandler: { storeFileToDB: storeFileToDBMock },
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
        expect(xLogger).toHaveBeenCalledWith(expect.stringContaining("STORAGE ? DB :"), LOG_LEVEL_DEBUG);
        expect(storeFileToDBMock).toHaveBeenCalledWith(file, false, false, { revalidateStorage: true });
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

    it("keeps an equal-time content-read failure unresolved at the scan boundary", async () => {
        vi.useFakeTimers();
        const file = { path: "unreadable-content.md", stat: { size: 100, mtime: 10_000 } };
        const tryRecordUntrackedFileRevision = vi.fn().mockResolvedValue(false);
        const storeFileToDB = vi.fn().mockRejectedValue(new Error("content unavailable"));

        async function* mockFindAllNormalDocs() {
            yield {
                _id: file.path,
                _rev: "2-current",
                path: file.path,
                size: 100,
                mtime: 10_000,
                type: "newnote",
                children: [],
            };
        }

        const host = {
            services: {
                context: createServiceContext(),
                setting: { currentSettings: () => ({ handleFilenameCaseSensitive: true }) },
                vault: {
                    isTargetFile: vi.fn().mockResolvedValue(true),
                    isValidPath: vi.fn().mockReturnValue(true),
                    isFileSizeTooLarge: vi.fn().mockReturnValue(false),
                },
                path: {
                    getPath: vi.fn((doc: any) => doc.path),
                    path2id: vi.fn(async (path: string) => path),
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
                storageAccess: { getFiles: vi.fn().mockResolvedValue([file]) },
                fileHandler: { tryRecordUntrackedFileRevision, storeFileToDB },
            },
        } as any;

        try {
            const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.NEWER_WINS,
            });

            expect(result).toBe(false);
            expect(tryRecordUntrackedFileRevision).toHaveBeenCalledExactlyOnceWith(file, "2-current");
            expect(storeFileToDB).toHaveBeenCalledExactlyOnceWith(file, false, false, {
                revalidateStorage: true,
            });
        } finally {
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        }
    });

    it("deletes an NFD storage file when its NFC Metadata entry is deleted in path identity version one", async () => {
        vi.useFakeTimers();
        const nfcPath = "Caf\u00e9/Note.md";
        const nfdPath = nfcPath.normalize("NFD");
        const storageFile = { path: nfdPath, stat: { size: 100, mtime: 5000 } };
        const deleteStorageFile = vi.fn().mockResolvedValue(undefined);
        const storeFileToDB = vi.fn();
        const reflectDatabaseEntry = vi.fn();

        async function* mockFindAllNormalDocs() {
            yield {
                _id: nfcPath,
                path: nfcPath,
                size: 100,
                mtime: 10000,
                deleted: true,
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
                        pathNormalizationVersion: 1,
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
                        set: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
            serviceModules: {
                storageAccess: {
                    getFiles: vi.fn().mockResolvedValue([storageFile]),
                    delete: deleteStorageFile,
                },
                fileHandler: {
                    reflectDatabaseEntry,
                    storeFileToDB,
                    deleteFileFromDB: vi.fn(),
                },
            },
        } as any;

        try {
            const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
                mode: FullScanModes.NEWER_WINS,
                extraOnLocal: ExtraOnLocal.DELETE_DB_DELETED,
            });
            await vi.runAllTimersAsync();

            expect(result).toBe(true);
            expect(storeFileToDB).not.toHaveBeenCalled();
            expect(deleteStorageFile).toHaveBeenCalledOnce();
            expect(deleteStorageFile).toHaveBeenCalledWith(nfdPath, true);
            expect(reflectDatabaseEntry).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should process mixed file-set actions in db-apply mode", async () => {
        const deleteMock = vi.fn().mockResolvedValue(undefined);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).toHaveBeenCalledTimes(2);
        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(expect.objectContaining({ path: "both.md" }), null, true, undefined);
        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(expect.objectContaining({ path: "db-only.md" }), null, true, undefined);
    });

    it("should continue even if one pair processing fails", async () => {
        const xLogger = vi.fn(logger);
        const deleteMock = vi.fn().mockRejectedValueOnce(new Error("delete failed")).mockResolvedValueOnce(undefined);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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

        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(expect.objectContaining({ path: "db-only.md" }), null, true, undefined);
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
                    reflectDatabaseEntry: vi.fn().mockResolvedValue({ status: "completed" }),
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
        const storeFileToDBMock = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: "db-too-large.md" }), null, true, undefined);
    });

    it("should not record an oversized database-only entry as a reflected local file", async () => {
        vi.useFakeTimers();
        let sizeLimitActive = true;
        let persistedFileStatus: Record<string, number> = {};
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
            expect(reflectDatabaseEntryMock).toHaveBeenCalledTimes(1);
            expect(deleteFileFromDBMock).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should fail when a newer database entry cannot replace an existing storage file", async () => {
        vi.useFakeTimers();
        let persistedFileStatus: Record<string, number> = {};
        const eventMock = vi.fn();
        const reflectDatabaseEntryMock = vi.fn().mockRejectedValue(new Error("Synthetic reflection failure"));
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
            expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(
                expect.objectContaining({ path: "both.md" }),
                "both.md",
                false,
                undefined
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("should treat db-only entry as offline local deletion when last seen mtime is newer", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(deleteFileFromDBMock).toHaveBeenCalledWith("gone.md");
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });

    it("should leave a mismatched metadata ID unresolved before an offline deletion decision", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });

    it("should keep processing a resolvable path when stale Metadata also claims it", async () => {
        const storeFileToDB = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntry = vi.fn().mockResolvedValue({ status: "completed" });
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
                    reflectDatabaseEntry,
                    storeFileToDB,
                    deleteFileFromDB,
                },
            },
        } as any;

        const result = await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(result).toBe(true);
        expect(storeFileToDB).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ path: "Shared.md" }),
            false,
            false,
            { revalidateStorage: true }
        );
        expect(reflectDatabaseEntry).not.toHaveBeenCalled();
        expect(deleteFileFromDB).not.toHaveBeenCalled();
        expect(host.services.path.compareFileFreshness).toHaveBeenCalledOnce();
    });

    it("should retry a failed database reflection instead of persisting it as a local deletion", async () => {
        vi.useFakeTimers();
        let persistedFileStatus: Record<string, number> = {};
        const reflectDatabaseEntryMock = vi.fn().mockRejectedValue(new Error("Synthetic reflection failure"));
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
            expect(reflectDatabaseEntryMock).toHaveBeenCalledTimes(2);
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
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });
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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
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
        expect(reflectDatabaseEntryMock).not.toHaveBeenCalled();
    });

    it("should keep db-only entry when database mtime is newer than last seen", async () => {
        const deleteFileFromDBMock = vi.fn().mockResolvedValue(true);
        const reflectDatabaseEntryMock = vi.fn().mockResolvedValue({ status: "completed" });

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
                    reflectDatabaseEntry: reflectDatabaseEntryMock,
                    storeFileToDB: vi.fn(),
                    deleteFileFromDB: deleteFileFromDBMock,
                },
            },
        } as any;

        await synchroniseAllFilesBetweenDBandStorage(host, logger, {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });

        expect(reflectDatabaseEntryMock).toHaveBeenCalledWith(expect.objectContaining({ path: "remote-new.md" }), null, true, undefined);
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
                        reflectDatabaseEntry: vi.fn().mockResolvedValue({ status: "completed" }),
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

    it.each([false, true])("aborts a stopped scan before enumeration (initialised: %s)", async (initialised) => {
        let stopping = false;
        const initialisationRead = promiseWithResolvers<boolean>();
        const replayStarted = promiseWithResolvers<void>();
        const replay = promiseWithResolvers<void>();
        const kvDB = { get: vi.fn(() => initialisationRead.promise), set: vi.fn() };
        const localDatabase = { findAllDocs: vi.fn(), findAllNormalDocs: vi.fn() };
        const storageAccess = {
            isStopping: () => stopping,
            restoreState: vi.fn(() => {
                replayStarted.resolve();
                return replay.promise;
            }),
            getFiles: vi.fn(),
        };
        const host = {
            services: {
                setting: {
                    currentSettings: () => ({ isConfigured: true, automaticallyDeleteMetadataOfDeletedFiles: 1 }),
                },
                keyValueDB: { kvDB },
                database: { localDatabase },
            },
            serviceModules: { storageAccess },
        } as unknown as Parameters<typeof performFullScan>[0];
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];

        const scan = performFullScan(host, vi.fn(), errors);
        expect(kvDB.get).toHaveBeenCalledExactlyOnceWith("initialized");
        if (initialised) {
            initialisationRead.resolve(true);
            await replayStarted.promise;
            stopping = true;
            replay.resolve();
        } else {
            stopping = true;
            initialisationRead.resolve(false);
        }

        await expect(scan).resolves.toBe(false);
        expect(storageAccess.restoreState).toHaveBeenCalledTimes(initialised ? 1 : 0);
        expect(localDatabase.findAllDocs).not.toHaveBeenCalled();
        expect(localDatabase.findAllNormalDocs).not.toHaveBeenCalled();
        expect(storageAccess.getFiles).not.toHaveBeenCalled();
        expect(kvDB.set).not.toHaveBeenCalled();
    });

    it("does not start Metadata enumeration when stop interrupts the storage listing", async () => {
        let stopped = false;
        const listing = promiseWithResolvers<never[]>();
        const started = promiseWithResolvers<void>();
        const getFiles = vi.fn(() => {
            started.resolve();
            return listing.promise;
        });
        const findAllNormalDocs = vi.fn(() => []);
        const kvDB = { get: vi.fn(async () => true), set: vi.fn() };
        const host = {
            services: {
                setting: { currentSettings: () => ({ isConfigured: true, automaticallyDeleteMetadataOfDeletedFiles: 0 }) },
                keyValueDB: { kvDB },
                database: { localDatabase: { findAllNormalDocs } },
            },
            serviceModules: { storageAccess: { getFiles, isStopping: () => stopped, restoreState: async () => {} } },
        } as unknown as Parameters<typeof performFullScan>[0];
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];

        const scan = performFullScan(host, vi.fn(), errors);
        await started.promise;
        stopped = true;
        listing.resolve([]);
        await expect(scan).resolves.toBe(false);
        expect(findAllNormalDocs).not.toHaveBeenCalled();
        expect(kvDB.set).not.toHaveBeenCalled();
    });

    it("stops dispatching file pairs and aborts an initialised scan when unloading begins", async () => {
        let stopping = false;
        const files = Array.from({ length: 24 }, (_, index) => ({
            path: `pending-${index}.md`,
            stat: { size: 1, mtime: 100 },
        }));
        const storeFileToDB = vi.fn(async () => {
            stopping = true;
            return true;
        });
        const restoreState = vi.fn(async () => {});
        const write = vi.fn(async () => {});
        const host = {
            services: {
                context: createServiceContext(),
                setting: { currentSettings: () => ({ isConfigured: true, handleFilenameCaseSensitive: true, automaticallyDeleteMetadataOfDeletedFiles: 0 }) },
                keyValueDB: { kvDB: { get: async (key: string) => key === "initialized" ? true : {}, set: write } },
                vault: {
                    isTargetFile: async () => true,
                    isValidPath: () => true,
                    isFileSizeTooLarge: () => false,
                },
                database: { localDatabase: { isReady: true, findAllNormalDocs: (): never[] => [] } },
                path: { path2id: async (path: string) => path },
            },
            serviceModules: {
                storageAccess: { restoreState, isStopping: () => stopping, getFiles: async () => files },
                fileHandler: { storeFileToDB },
            },
        } as unknown as Parameters<typeof performFullScan>[0];
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];

        vi.useFakeTimers();
        try {
            await expect(performFullScan(host, vi.fn(), errors, { continueOnFileFailure: true })).resolves.toBe(false);
            expect(restoreState).toHaveBeenCalledOnce();
            expect(storeFileToDB).toHaveBeenCalledOnce();
            expect(write).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_250);
            expect(write).not.toHaveBeenCalledWith("fileStatusMap", expect.anything());
        } finally {
            vi.useRealTimers();
        }
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

        const result = await performFullScan(host, logger, errorManager as any, {
            mode: FullScanModes.NEWER_WINS,
            continueOnFileFailure: true,
        });

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
                    storeFileToDB: vi.fn().mockResolvedValue(true),
                    reflectDatabaseEntry: vi.fn(),
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
                    storeFileToDB: vi.fn().mockResolvedValue(true),
                    reflectDatabaseEntry: vi.fn(),
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

    it("keeps failed reflections strict by default but reports them to an ordinary readiness caller", async () => {
        const log = vi.fn() as unknown as LogFunction;
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
                        findAllDocs: vi.fn().mockImplementation(() => mockFindAllDocs()),
                        findAllNormalDocs: vi.fn().mockImplementation(() => mockFindAllNormalDocs()),
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
                    reflectDatabaseEntry: vi.fn().mockRejectedValue(new Error("Synthetic reflection failure")),
                },
            },
        } as any;

        const result = await performFullScan(host, log, errorManager as any, {
            mode: FullScanModes.DB_APPLY,
        });

        expect(result).toBe(false);
        expect(host.services.keyValueDB.kvDB.set).toHaveBeenCalledWith("initialized", true);

        const ordinaryStartupResult = await performFullScan(host, log, errorManager as any, {
            mode: FullScanModes.DB_APPLY,
            continueOnFileFailure: true,
        });

        expect(ordinaryStartupResult).toBe("completed-with-file-failures");
        expect(errorManager.showError).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            "Offline scan failed to synchronise missing.md between storage and the local database; this path remains eligible for a later scan.",
            LOG_LEVEL_VERBOSE
        );
        host.serviceModules.fileHandler.reflectDatabaseEntry.mockResolvedValue({ status: "completed" });

        await expect(
            performFullScan(host, log, errorManager as any, {
                mode: FullScanModes.DB_APPLY,
                continueOnFileFailure: true,
            })
        ).resolves.toBe(true);
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
        expect(errorManager.showError).not.toHaveBeenCalled();
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

describe("offline scanner content-read outcome", () => {
    it("forwards the startup read-failure observer through the registered scanVault port", async () => {
        const entry = {
            _id: "startup.md",
            _rev: "1-startup",
            path: "startup.md",
            type: "plain",
            size: 10,
            mtime: 20,
            ctime: 20,
            children: [] as string[],
        };
        const failure = { documentId: entry._id, revision: entry._rev, reason: "offline" };
        const onReflectionFailed = vi.fn(async () => undefined);
        let scan: ((...args: unknown[]) => Promise<unknown>) | undefined;
        const host = {
            services: {
                context: createServiceContext(),
                API: { addLog: vi.fn() },
                appLifecycle: { getUnresolvedMessages: { addHandler: vi.fn() } },
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
                    kvDB: { get: vi.fn(async (key: string) => (key === "initialized" ? false : {})), set: vi.fn() },
                },
                vault: {
                    scanVault: {
                        addHandler: (handler: typeof scan) => {
                            scan = handler;
                        },
                    },
                    isTargetFile: async () => true,
                    isValidPath: () => true,
                    isFileSizeTooLarge: () => false,
                },
                database: {
                    localDatabase: {
                        isReady: true,
                        findAllDocs: async function* () {},
                        findAllNormalDocs: async function* () {
                            yield entry;
                        },
                    },
                },
                path: { getPath: (doc: { path: string }) => doc.path, path2id: async (path: string) => path },
            },
            serviceModules: {
                storageAccess: { getFiles: async (): Promise<UXFileInfoStub[]> => [], restoreState: vi.fn() },
                fileHandler: {
                    reflectDatabaseEntry: vi.fn(async (...args: unknown[]) => {
                        throw failure;
                    }),
                },
            },
        };
        useOfflineScanner(host as never);
        if (!scan) {
            throw new Error("scanVault handler was not registered");
        }
        await expect(scan(false, false, true, { onReflectionFailed })).resolves.toBe("completed-with-file-failures");
        expect(onReflectionFailed).toHaveBeenCalledExactlyOnceWith({ documentId: failure.documentId, revision: failure.revision }, failure);
    });

    it("awaits reporting a failed database-to-storage read without reporting success", async () => {
        const doc = { _id: "pending.md", _rev: "2-pending", path: "pending.md", size: 10, mtime: 20 };
        const failure = { documentId: doc._id, revision: doc._rev, reason: "offline" as const };
        let reported = false;
        const onReflectionFailed = vi.fn(async () => {
            await Promise.resolve();
            reported = true;
        });
        const events = { emitEvent: vi.fn() };
        const host = {
            services: {
                context: { events },
                vault: { isFileSizeTooLarge: () => false },
                path: { getPath: (entry: { path: string }) => entry.path },
            },
            serviceModules: {
                fileHandler: {
                    reflectDatabaseEntry: vi.fn(async (...args: unknown[]) => {
                        throw failure;
                    }),
                },
            },
        };
        const result = await Reflect.apply(updateToStorage, undefined, [
            host,
            vi.fn(),
            LOG_LEVEL_INFO,
            doc,
            { onReflectionFailed },
        ]);

        expect(result).toBe(FilePairProcessResults.FAILED);
        expect(onReflectionFailed).toHaveBeenCalledExactlyOnceWith({ documentId: failure.documentId, revision: failure.revision }, failure);
        expect(reported).toBe(true);
        expect(events.emitEvent).not.toHaveBeenCalled();
    });

    it("clears pending state when saveFileStatus timer registration throws so a later ordinary save succeeds", async () => {
        const persisted = promiseWithResolvers<void>();
        const set = vi.fn(async () => {
            persisted.resolve();
        });
        const host = { services: { keyValueDB: { kvDB: { set } } } } as any;
        const timerError = new Error("timer registration failed");
        const setTimeoutSpy = vi.spyOn(compatGlobal, "setTimeout").mockImplementationOnce(() => {
            throw timerError;
        });
        try {
            expect(() => saveFileStatus(host, () => false)).toThrow(timerError);
            let scheduledCallback: (() => void) | undefined;
            setTimeoutSpy.mockImplementationOnce(((callback: () => void) => {
                scheduledCallback = callback;
                return 1 as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout);
            saveFileStatus(host, () => false);
            expect(scheduledCallback).toBeDefined();
            scheduledCallback!();
            await persisted.promise;
            expect(set).toHaveBeenCalledOnce();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("clears pending state when cancelFileStatusSave timer cancellation throws so a later ordinary save succeeds", async () => {
        const persisted = promiseWithResolvers<void>();
        const set = vi.fn(async () => {
            persisted.resolve();
        });
        const host = { services: { keyValueDB: { kvDB: { set } } } } as any;
        const clearError = new Error("clearTimeout failed");
        let scheduledCallback: (() => void) | undefined;
        const setTimeoutSpy = vi.spyOn(compatGlobal, "setTimeout").mockImplementation(((callback: () => void) => {
            scheduledCallback = callback;
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout);
        const clearTimeoutSpy = vi.spyOn(compatGlobal, "clearTimeout").mockImplementationOnce(() => {
            throw clearError;
        });
        try {
            saveFileStatus(host, () => false);
            expect(() => cancelFileStatusSave(host)).toThrow(clearError);
            scheduledCallback = undefined;
            saveFileStatus(host, () => false);
            expect(scheduledCallback).toBeDefined();
            scheduledCallback!();
            await persisted.promise;
            expect(set).toHaveBeenCalledOnce();
        } finally {
            clearTimeoutSpy.mockRestore();
            setTimeoutSpy.mockRestore();
        }
    });

    it("does not emit event-file-changed or onReflectionFailed after stop interrupts an in-flight save or reflection", async () => {
        let stopping = false;
        const saveDone = promiseWithResolvers<boolean>();
        const reflectDone = promiseWithResolvers<never>();
        const emitEvent = vi.fn();
        const onReflectionFailed = vi.fn();
        const host = {
            services: {
                context: { events: { emitEvent } },
                vault: { isFileSizeTooLarge: () => false },
                path: { getPath: (entry: { path: string }) => entry.path },
            },
            serviceModules: {
                storageAccess: { isStopping: () => stopping },
                fileHandler: {
                    storeFileToDB: vi.fn(() => saveDone.promise),
                    reflectDatabaseEntry: vi.fn(() => reflectDone.promise),
                },
            },
        } as any;
        const file = { path: "a.md", stat: { size: 10 } } as UXFileInfoStub;
        const doc = { _id: "a", _rev: "1-a", path: "a.md", size: 10 } as MetaEntry;

        const dbSave = updateToDatabase(host, vi.fn(), LOG_LEVEL_INFO, file);
        const storageReflect = updateToStorage(host, vi.fn(), LOG_LEVEL_INFO, doc, { onReflectionFailed });
        stopping = true;
        saveDone.resolve(true);
        reflectDone.reject(new Error("reflection failed after stop"));

        await expect(dbSave).resolves.toBe(FilePairProcessResults.FAILED);
        await expect(storageReflect).resolves.toBe(FilePairProcessResults.FAILED);
        expect(emitEvent).not.toHaveBeenCalled();
        expect(onReflectionFailed).not.toHaveBeenCalled();
    });
});
