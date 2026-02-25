import { describe, it, expect, beforeAll } from "vitest";

import { isAcceptedAlwaysFactory } from "./targetFilter";
import { type LogFunction, createInstanceLogFunction } from "@lib/services/lib/logUtils";
const APIServiceMock = {
    addLog(message: string, level?: any) {
        // For testing, we can simply log to console or store logs in an array if needed.
        console.log(`${message}`);
    },
};
function createLogger(name: string): LogFunction {
    return createInstanceLogFunction(name, APIServiceMock as any);
}
describe("isAcceptedAlways", () => {
    let logger: LogFunction;
    beforeAll(() => {
        logger = createLogger("TestLogger");
    });
    it("should always return true", async () => {
        const handler = isAcceptedAlwaysFactory(
            {
                services: {},
                serviceModules: {},
            },
            logger
        );
        const result = await handler("a.txt");
        expect(result).toBe(true);
    });
    // Mock vault, fileProcessing, storageAccess to test isAcceptedInFilenameDuplicationFactory, isAcceptedByIgnoreFilesFactory
});
import { isAcceptedInFilenameDuplicationFactory } from "./targetFilter";
const mockVault = {
    _caseSensitivityDisabled: false,
    shouldCheckCaseInsensitively() {
        return this._caseSensitivityDisabled;
    },
};
const mockStorageAccess = {
    _files: ["a.md", "A.md", "b.txt", "c.txt", "c.md"],
    getFileNames: () => mockStorageAccess._files,
};
const mockFileProcessing = {
    totalStorageFileEventCount: 0,
};
describe("isAcceptedInFilenameDuplication", () => {
    let logger: LogFunction;
    beforeAll(() => {
        logger = createLogger("TestLogger");
    });
    function createHost({ caseInsensitive = false } = {}) {
        mockVault._caseSensitivityDisabled = caseInsensitive;
        return {
            services: {
                vault: mockVault,
                fileProcessing: mockFileProcessing,
            },
            serviceModules: {
                storageAccess: mockStorageAccess,
            },
        } as any;
    }
    it("should accept duplicates and return true for duplicated files (case-sensitive setting, environment)", async () => {
        const host = createHost();
        const handler = isAcceptedInFilenameDuplicationFactory(host, logger);
        expect(await handler("a.md")).toBe(true);
        expect(await handler("A.md")).toBe(true);
        expect(await handler("b.md")).toBe(true);
    });
    it("should detect duplicates and return false for duplicated files (case-insensitive setting, environment)", async () => {
        const host = createHost({ caseInsensitive: true });
        const handler = isAcceptedInFilenameDuplicationFactory(host, logger);
        expect(await handler("a.md")).toBe(false);
        expect(await handler("A.md")).toBe(false);
        expect(await handler("b.txt")).toBe(true);
    });
    it("should memorise file count map and update only when totalStorageFileEventCount changes", async () => {
        const host = createHost({ caseInsensitive: true });
        const handler = isAcceptedInFilenameDuplicationFactory(host, logger);
        expect(await handler("a.md")).toBe(false);
        expect(await handler("A.md")).toBe(false);
        expect(await handler("b.txt")).toBe(true);
        host.serviceModules.storageAccess._files.push("B.txt");
        // still should return false because the file count map is memorised and not updated yet
        expect(await handler("b.txt")).toBe(true);
        // update totalStorageFileEventCount to trigger file count map update
        host.services.fileProcessing.totalStorageFileEventCount++;
        expect(await handler("b.txt")).toBe(false);
    });
});

import { isAcceptedByLocalDBFactory } from "./targetFilter";
describe("isAcceptedByLocalDB", () => {
    let logger: LogFunction;
    beforeAll(() => {
        logger = createInstanceLogFunction("TestLogger");
    });
    // Similar approach to test isAcceptedByLocalDBFactory by mocking database service and testing the acceptance logic based on local DB state.
    it("should return true if local DB considers the file as target, false otherwise", async () => {
        const mockDatabase = {
            localDatabase: {
                isTargetFile: (filepath: string) => filepath === "target.md",
            },
        };
        let onDatabaseReadyHandler: (() => Promise<boolean>) | null = null;
        let onDatabaseUnloadHandler: (() => Promise<boolean>) | null = null;
        const mockDatabaseEvents = {
            onDatabaseHasReady: {
                addHandler: (handler: () => Promise<boolean>) => {
                    onDatabaseReadyHandler = handler;
                },
            },
            onUnloadDatabase: {
                addHandler: (handler: () => Promise<boolean>) => {
                    onDatabaseUnloadHandler = handler;
                },
            },
        };
        const host = {
            services: {
                database: mockDatabase,
                databaseEvents: mockDatabaseEvents,
            },
            serviceModules: {},
        } as any;
        const handler = isAcceptedByLocalDBFactory(host, logger);

        const p = handler("target.md");
        expect(await Promise.race([p, Promise.resolve("timeout")])).toBe("timeout"); // DB is not ready yet, should timeout
        await onDatabaseReadyHandler!(); // Simulate DB ready
        expect(await p).toBe(true); // Now it should return true for target.md
        expect(await handler("target.md")).toBe(true);
        expect(await handler("non-target.md")).toBe(false);
        await onDatabaseUnloadHandler!(); // Simulate DB unload
        const p2 = handler("target.md");
        expect(await Promise.race([p2, Promise.resolve("timeout")])).toBe("timeout"); // DB is unloaded, should timeout
        await onDatabaseReadyHandler!(); // Simulate DB ready again
        expect(await p2).toBe(true);
    });
});
import { isAcceptedByIgnoreFilesFactory } from "./targetFilter";
import type { UXFileInfoStub } from "@/lib/src/common/types";
describe("isAcceptedByIgnoreFiles", () => {
    const vaultFileMap = {
        "a.md": "", // ignored
        "b.md": "", // accepted
        ".gitignore": `a.md\nc.md\nf/*.bin\n!f/.gitkeep.md\n**/c.*`, // ignorefile itself
        "f/a.md": "", // accepted
        "f/a.bin": "", // ignored
        "f/.gitkeep.md": "", // accepted due to negation
        "f2/.obsidianignore": `b.md\n`, // another ignore file in subfolder.
        "f2/b.md": "", // ignored by .obsidianignore
        "f2/e.md": "", // accepted
        "f2/c.md": "", // ignored by .gitignore with wildcard
    } as Record<string, string>;
    const acceptMap = {
        "a.md": false, // ignored
        "b.md": true, // accepted
        ".gitignore": true, // ignorefile itself should not be ignored
        "f/a.md": true, // accepted
        "f/a.bin": false, // ignored
        "f/.gitkeep.md": true, // accepted due to negation
        "f2/.obsidianignore": true, // ignore file itself should not be ignored
        "f2/b.md": false, // ignored by .obsidianignore
        "f2/e.md": true, // accepted
        "f2/c.md": false, // ignored by .gitignore with wildcard
    } as Record<string, boolean>;
    const acceptMap2 = {
        ...acceptMap,
        "f2/b.md": true,
    } as Record<string, boolean>;
    let logger: LogFunction;
    beforeAll(() => {
        logger = createLogger("TestLogger");
    });
    // Similar approach to test isAcceptedByIgnoreFilesFactory by mocking setting service, storage access and testing the acceptance logic based on ignore file state.
    let handler: (file: string | UXFileInfoStub) => Promise<boolean>;
    let readCountMap: Map<string, number>;
    let mockHost: any;
    let useIgnoreFiles = true;
    let onSettingRealisedHandler: (() => Promise<boolean>) | null = null;
    let ignoreFiles = ".gitignore, .obsidianignore,.notexistignore,.errorfile"; // default ignore files for testing
    beforeAll(async () => {
        readCountMap = new Map<string, number>();
        const mockStorageAccess = {
            getFileNames: () => Object.keys(vaultFileMap),
            isExistsIncludeHidden(pathX: string) {
                if (pathX.indexOf(".errorfile") !== -1) {
                    return true;
                }
                const path = pathX.startsWith("/") ? pathX.substring(1) : pathX;
                return Promise.resolve(path in vaultFileMap);
            },
            readHiddenFileText(pathX: string) {
                if (pathX.indexOf(".errorfile") !== -1) {
                    throw new Error("Failed to read file: " + pathX);
                }
                const path = pathX.startsWith("/") ? pathX.substring(1) : pathX;
                if (path in vaultFileMap) {
                    const count = readCountMap.get(path) || 0;
                    readCountMap.set(path, count + 1);
                    return Promise.resolve(vaultFileMap[path]);
                }
                return Promise.reject(new Error("File not found: " + path));
            },
        };

        const mockSetting = {
            currentSettings() {
                return {
                    useIgnoreFiles: useIgnoreFiles,
                    ignoreFiles: ignoreFiles,
                };
            },
            onSettingRealised: {
                addHandler: (handler: () => Promise<boolean>) => {
                    onSettingRealisedHandler = handler;
                },
            },
        };
        const mockAppLifecycle = {
            onLoaded: {
                addHandler: (handler: () => Promise<boolean>) => {
                    void handler();
                },
            },
        };

        mockHost = {
            services: {
                setting: mockSetting,
                appLifecycle: mockAppLifecycle,
            },
            serviceModules: {
                storageAccess: mockStorageAccess,
            },
        } as any;
        handler = isAcceptedByIgnoreFilesFactory(mockHost, logger);
        await onSettingRealisedHandler!(); // Simulate settings realised to load ignore files
    });
    describe("acceptance based on ignore file settings and state", () => {
        useIgnoreFiles = true;
        ignoreFiles = ".gitignore, .obsidianignore,.notexistignore,.errorfile";
        it.each(Object.keys(acceptMap))(
            "should accept or reject files based on ignore file settings and state: %s",
            async (file) => {
                expect(await handler(file)).toBe(acceptMap[file]);
            }
        );
        it.afterAll(async () => {
            // "should cache ignore file content and avoid redundant reads"
            expect(readCountMap.get(".gitignore")).toBe(1); // .gitignore should be read once
            expect(readCountMap.get("f2/.obsidianignore")).toBe(1); // .obsidianignore should be read once
            expect(readCountMap.get(".notexistignore")).toBe(undefined);
            expect(readCountMap.get(".errorfile")).toBe(undefined);
            // Check ignore file directly invalidate cache and reload when file is changed
            await handler("/.gitignore"); // Access to cache the .gitignore
            expect(readCountMap.get(".gitignore")).toBe(2);
        });
    });
    describe("Changing ignore file settings", () => {
        it.beforeAll(async () => {
            useIgnoreFiles = true;
            ignoreFiles = ".gitignore,.notexistignore,.errorfile";
            await onSettingRealisedHandler!(); // Simulate settings change to update ignore files
        });
        it.each(Object.keys(acceptMap2))(
            "should accept or reject files based on ignore file settings and state: %s",
            async (file) => {
                expect(await handler(file)).toBe(acceptMap2[file]);
            }
        );
    });
    describe("disabling ignore files", () => {
        it("should accept all files when ignore files are disabled", async () => {
            useIgnoreFiles = false;
            await onSettingRealisedHandler!(); // Simulate settings change to disable ignore files
            for (const file of Object.keys(acceptMap)) {
                expect(await handler(file)).toBe(true);
            }
        });
    });
});
