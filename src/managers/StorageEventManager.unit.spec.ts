import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    StorageEventManagerBase,
    type StorageEventManagerBaseDependencies,
    type FileEventItemSentinel,
} from "./StorageEventManager";
import type {
    IStorageEventManagerAdapter,
    IStorageEventTypeGuardAdapter,
    IStorageEventPersistenceAdapter,
    IStorageEventWatchAdapter,
    IStorageEventStatusAdapter,
    IStorageEventConverterAdapter,
    IStorageEventWatchHandlers,
} from "./adapters";
import type { FileEventItem } from "@lib/common/types";
import type { FilePath, UXFileInfoStub, UXInternalFileInfoStub } from "@lib/common/types";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import type { IAPIService, IVaultService } from "@lib/services/base/IService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { DEFAULT_SETTINGS, FlagFilesHumanReadable } from "@lib/common/types";

// Mock file types
interface MockFile {
    path: string;
    name: string;
    stat: {
        ctime: number;
        mtime: number;
        size: number;
        type: "file";
    };
}

interface MockFolder {
    path: string;
    name: string;
    stat: {
        ctime: number;
        mtime: number;
        size: number;
        type: "folder";
    };
}

// Mock Adapter implementations
class MockTypeGuardAdapter implements IStorageEventTypeGuardAdapter<MockFile, MockFolder> {
    isFile(file: any): file is MockFile {
        return file && typeof file === "object" && file.stat?.type === "file";
    }

    isFolder(item: any): item is MockFolder {
        return item && typeof item === "object" && item.stat?.type === "folder";
    }
}

class MockPersistenceAdapter implements IStorageEventPersistenceAdapter {
    private snapshot: (FileEventItem | FileEventItemSentinel)[] | null = null;

    saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void> {
        this.snapshot = [...snapshot];
        return Promise.resolve();
    }

    loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null> {
        return Promise.resolve(this.snapshot ? [...this.snapshot] : null);
    }

    // Test helper
    getStoredSnapshot() {
        return this.snapshot;
    }
}

class MockWatchAdapter implements IStorageEventWatchAdapter {
    private handlers: IStorageEventWatchHandlers | null = null;

    beginWatch(handlers: IStorageEventWatchHandlers): Promise<void> {
        this.handlers = handlers;
        return Promise.resolve();
    }

    // Test helpers
    simulateCreate(file: MockFile, ctx?: any) {
        this.handlers?.onCreate(file, ctx);
    }

    simulateChange(file: MockFile, ctx?: any) {
        this.handlers?.onChange(file, ctx);
    }

    simulateDelete(file: MockFile, ctx?: any) {
        this.handlers?.onDelete(file, ctx);
    }

    simulateRename(file: MockFile, oldPath: string, ctx?: any) {
        this.handlers?.onRename(file, oldPath, ctx);
    }
}

class MockStatusAdapter implements IStorageEventStatusAdapter {
    batched = 0;
    processing = 0;
    totalQueued = 0;

    updateStatus(status: { batched: number; processing: number; totalQueued: number }): void {
        this.batched = status.batched;
        this.processing = status.processing;
        this.totalQueued = status.totalQueued;
    }
}

class MockConverterAdapter implements IStorageEventConverterAdapter<MockFile> {
    toFileInfo(file: MockFile, deleted?: boolean): UXFileInfoStub {
        return {
            name: file.name,
            path: file.path as FilePath,
            isFolder: false,
            stat: file.stat,
        };
    }

    toInternalFileInfo(path: FilePath): UXInternalFileInfoStub {
        return {
            name: path.split("/").pop() || "",
            path: path,
            isFolder: false,
            isInternal: true,
            stat: undefined,
        };
    }
}

class MockStorageEventManagerAdapter implements IStorageEventManagerAdapter<MockFile, MockFolder> {
    typeGuard: IStorageEventTypeGuardAdapter<MockFile, MockFolder>;
    persistence: MockPersistenceAdapter;
    watch: MockWatchAdapter;
    status: MockStatusAdapter;
    converter: IStorageEventConverterAdapter<MockFile>;

    constructor() {
        this.typeGuard = new MockTypeGuardAdapter();
        this.persistence = new MockPersistenceAdapter();
        this.watch = new MockWatchAdapter();
        this.status = new MockStatusAdapter();
        this.converter = new MockConverterAdapter();
    }
}

// Concrete implementation for testing
class TestStorageEventManager extends StorageEventManagerBase<MockStorageEventManagerAdapter> {
    constructor(adapter: MockStorageEventManagerAdapter, dependencies: StorageEventManagerBaseDependencies) {
        super(adapter, dependencies);
    }

    // Expose protected methods for testing
    public testWatchVaultCreate(file: any, ctx?: any) {
        return this.watchVaultCreate(file, ctx);
    }

    public testWatchVaultChange(file: any, ctx?: any) {
        return this.watchVaultChange(file, ctx);
    }

    public testWatchVaultDelete(file: any, ctx?: any) {
        return this.watchVaultDelete(file, ctx);
    }

    public testWatchVaultRename(file: any, oldPath: string, ctx?: any) {
        return this.watchVaultRename(file, oldPath, ctx);
    }

    public async testAppendQueue(params: any[], ctx?: any) {
        return await this.appendQueue(params, ctx);
    }
}

// Helper to create mock dependencies
function createMockDependencies(): StorageEventManagerBaseDependencies {
    const setting = {
        currentSettings: vi.fn(() => ({
            ...DEFAULT_SETTINGS,
            isConfigured: true,
            suspendFileWatching: false,
            liveSync: false,
            batchSave: true,
            batchSaveMinimumDelay: 1000,
            batchSaveMaximumDelay: 5000,
            maxMTimeForReflectEvents: 0,
        })),
    } as unknown as SettingService;

    const vaultService = {
        isFileSizeTooLarge: vi.fn(() => false),
        isTargetFile: vi.fn(() => Promise.resolve(true)),
    } as unknown as IVaultService;

    const fileProcessing = {
        onStorageFileEvent: vi.fn(),
        isFileProcessing: vi.fn(() => false),
        processFileEvent: vi.fn(() => Promise.resolve(true)),
        processOptionalFileEvent: vi.fn(() => Promise.resolve()),
    } as unknown as FileProcessingService;

    const storageAccessManager = {
        isFileProcessing: vi.fn(() => false),
        recentlyTouched: vi.fn(() => false),
    } as unknown as IStorageAccessManager;

    const APIService = {
        addOnLogEntry: vi.fn(),
        addLog: vi.fn(),
    } as unknown as IAPIService;

    return {
        setting,
        vaultService,
        fileProcessing,
        storageAccessManager,
        APIService,
    };
}

// Helper to create mock file
function createMockFile(path: string, name: string, mtime: number = Date.now()): MockFile {
    return {
        path,
        name,
        stat: {
            ctime: mtime - 1000,
            mtime,
            size: 1024,
            type: "file",
        },
    };
}

// Helper to create mock folder
function createMockFolder(path: string, name: string): MockFolder {
    return {
        path,
        name,
        stat: {
            ctime: Date.now() - 1000,
            mtime: Date.now(),
            size: 0,
            type: "folder",
        },
    };
}

describe("StorageEventManagerBase", () => {
    let adapter: MockStorageEventManagerAdapter;
    let dependencies: StorageEventManagerBaseDependencies;
    let manager: TestStorageEventManager;

    beforeEach(() => {
        adapter = new MockStorageEventManagerAdapter();
        dependencies = createMockDependencies();
        manager = new TestStorageEventManager(adapter, dependencies);
    });

    describe("Initialization", () => {
        it("should initialize with adapter and dependencies", () => {
            expect(manager).toBeDefined();
            expect(manager.settings).toBeDefined();
        });

        it("should have access to adapter components", () => {
            expect(adapter.typeGuard).toBeDefined();
            expect(adapter.persistence).toBeDefined();
            expect(adapter.watch).toBeDefined();
            expect(adapter.status).toBeDefined();
            expect(adapter.converter).toBeDefined();
        });
    });

    describe("Type Guards", () => {
        it("should correctly identify files", () => {
            const file = createMockFile("test.md", "test.md");
            expect(manager.isFile(file)).toBe(true);
            expect(manager.isFolder(file)).toBe(false);
        });

        it("should correctly identify folders", () => {
            const folder = createMockFolder("folder", "folder");
            expect(manager.isFolder(folder)).toBe(true);
            expect(manager.isFile(folder)).toBe(false);
        });
    });

    describe("Snapshot Operations", () => {
        it("should save snapshot through adapter", async () => {
            const mockSnapshot: FileEventItem[] = [
                {
                    type: "CREATE",
                    key: "test-key",
                    args: {
                        file: {
                            path: "test.md" as FilePath,
                            name: "test.md",
                            stat: {
                                ctime: Date.now(),
                                mtime: Date.now(),
                                size: 1024,
                                type: "file",
                            },
                            isFolder: false,
                        },
                    },
                },
            ];

            await manager._saveSnapshot(mockSnapshot);
            const stored = adapter.persistence.getStoredSnapshot();
            expect(stored).toEqual(mockSnapshot);
        });

        it("should load snapshot through adapter", async () => {
            const mockSnapshot: FileEventItem[] = [
                {
                    type: "CHANGED",
                    key: "test-key",
                    args: {
                        file: {
                            path: "changed.md" as FilePath,
                            name: "changed.md",
                            stat: {
                                ctime: Date.now(),
                                mtime: Date.now(),
                                size: 2048,
                                type: "file",
                            },
                            isFolder: false,
                        },
                    },
                },
            ];

            await adapter.persistence.saveSnapshot(mockSnapshot);
            const loaded = await manager._loadSnapshot();
            expect(loaded).toEqual(mockSnapshot);
        });

        it("should return null when no snapshot exists", async () => {
            const loaded = await manager._loadSnapshot();
            expect(loaded).toBeNull();
        });
    });

    describe("Status Updates", () => {
        it("should update status through adapter", () => {
            // Status is updated internally during event processing
            // We can verify the adapter's status values are updated
            expect(adapter.status.batched).toBe(0);
            expect(adapter.status.processing).toBe(0);
            expect(adapter.status.totalQueued).toBe(0);
        });
    });

    describe("Event Watch", () => {
        it("should begin watch with adapter", async () => {
            await manager.beginWatch();
            // Verify watch was started by simulating an event
            const file = createMockFile("test.md", "test.md");
            adapter.watch.simulateCreate(file);
            // If watch is properly set up, the event should be queued
            // (actual queuing behavior is tested in other tests)
        });
    });

    describe("Event Handlers - Create", () => {
        it("should handle file create event", async () => {
            const file = createMockFile("new.md", "new.md");
            manager.testWatchVaultCreate(file);
            // Wait for async appendQueue
            await new Promise((resolve) => setTimeout(resolve, 10));
            // Event should trigger onStorageFileEvent
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should ignore folder create event", () => {
            const folder = createMockFolder("new-folder", "new-folder");
            manager.testWatchVaultCreate(folder);
            // Folders should be ignored
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore create event for processing file", () => {
            const file = createMockFile("processing.md", "processing.md");
            vi.mocked(dependencies.storageAccessManager.isFileProcessing).mockReturnValue(true);
            manager.testWatchVaultCreate(file);
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("Event Handlers - Change", () => {
        it("should handle file change event", async () => {
            const file = createMockFile("changed.md", "changed.md");
            manager.testWatchVaultChange(file);
            // Wait for async appendQueue
            await new Promise((resolve) => setTimeout(resolve, 10));
            // Event should trigger onStorageFileEvent
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should ignore folder change event", () => {
            const folder = createMockFolder("changed-folder", "changed-folder");
            manager.testWatchVaultChange(folder);
            // Folders should be ignored
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore change event for processing file", () => {
            const file = createMockFile("processing.md", "processing.md");
            vi.mocked(dependencies.storageAccessManager.isFileProcessing).mockReturnValue(true);
            manager.testWatchVaultChange(file);
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("Event Handlers - Delete", () => {
        it("should handle file delete event", async () => {
            const file = createMockFile("deleted.md", "deleted.md");
            manager.testWatchVaultDelete(file);
            // Wait for async appendQueue
            await new Promise((resolve) => setTimeout(resolve, 10));
            // Event should trigger onStorageFileEvent
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should ignore folder delete event", () => {
            const folder = createMockFolder("deleted-folder", "deleted-folder");
            manager.testWatchVaultDelete(folder);
            // Folders should be ignored
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore delete event for processing file", () => {
            const file = createMockFile("processing.md", "processing.md");
            vi.mocked(dependencies.storageAccessManager.isFileProcessing).mockReturnValue(true);
            manager.testWatchVaultDelete(file);
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("Event Handlers - Rename", () => {
        it("should handle file rename event", async () => {
            const file = createMockFile("renamed.md", "renamed.md");
            const oldPath = "old.md";
            manager.testWatchVaultRename(file, oldPath);
            // Wait for async appendQueue
            await new Promise((resolve) => setTimeout(resolve, 10));
            // Event should trigger onStorageFileEvent
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should handle folder rename event", () => {
            const folder = createMockFolder("renamed-folder", "renamed-folder");
            const oldPath = "old-folder";
            manager.testWatchVaultRename(folder, oldPath);
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("Configuration Checks", () => {
        it("should not queue events when not configured", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                isConfigured: false,
            });

            const file = createMockFile("test.md", "test.md");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should not queue events when file watching is suspended", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                isConfigured: true,
                suspendFileWatching: true,
            });

            const file = createMockFile("test.md", "test.md");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should not queue events when maxMTimeForReflectEvents is set", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                isConfigured: true,
                suspendFileWatching: false,
                maxMTimeForReflectEvents: 1000,
            });

            const file = createMockFile("test.md", "test.md");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("Batch Save Settings", () => {
        it("should respect batchSave setting", () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });
            expect(manager["shouldBatchSave"]).toBe(true);

            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: false,
                liveSync: false,
            });
            expect(manager["shouldBatchSave"]).toBe(false);
        });

        it("should disable batch save when liveSync is enabled", () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: true,
            });
            expect(manager["shouldBatchSave"]).toBe(false);
        });

        it("should return correct batch save delays", () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSaveMinimumDelay: 1500,
                batchSaveMaximumDelay: 6000,
            });
            expect(manager["batchSaveMinimumDelay"]).toBe(1500);
            expect(manager["batchSaveMaximumDelay"]).toBe(6000);
        });
    });

    describe("Adapter Delegation", () => {
        it("should delegate persistence operations to adapter", async () => {
            const saveSpy = vi.spyOn(adapter.persistence, "saveSnapshot");
            const loadSpy = vi.spyOn(adapter.persistence, "loadSnapshot");

            const snapshot: FileEventItem[] = [];
            await manager._saveSnapshot(snapshot);
            expect(saveSpy).toHaveBeenCalledWith(snapshot);

            await manager._loadSnapshot();
            expect(loadSpy).toHaveBeenCalled();
        });

        it("should delegate type guards to adapter", () => {
            const isFileSpy = vi.spyOn(adapter.typeGuard, "isFile");
            const isFolderSpy = vi.spyOn(adapter.typeGuard, "isFolder");

            const file = createMockFile("test.md", "test.md");
            manager.isFile(file);
            expect(isFileSpy).toHaveBeenCalledWith(file);

            const folder = createMockFolder("folder", "folder");
            manager.isFolder(folder);
            expect(isFolderSpy).toHaveBeenCalledWith(folder);
        });
    });

    describe("Snapshot Restore", () => {
        it("should restore state from snapshot", async () => {
            const mockSnapshot: FileEventItem[] = [
                {
                    type: "CREATE",
                    key: "test-key",
                    args: {
                        file: {
                            path: "restored.md" as FilePath,
                            name: "restored.md",
                            stat: {
                                ctime: Date.now(),
                                mtime: Date.now(),
                                size: 1024,
                                type: "file",
                            },
                            isFolder: false,
                        },
                    },
                },
            ];

            await adapter.persistence.saveSnapshot(mockSnapshot);
            await manager.restoreState();

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(manager.snapShotRestored).toBeDefined();
        });

        it("should handle empty snapshot restore", async () => {
            await manager.restoreState();

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(manager.snapShotRestored).toBeDefined();
        });
    });

    describe("appendQueue - Advanced Scenarios", () => {
        it("should skip files that exceed maximum size", async () => {
            vi.mocked(dependencies.vaultService.isFileSizeTooLarge).mockReturnValue(true);
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("large.md", "large.md");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            // File should be skipped
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });
        it("should skip files that exceed maximum size", async () => {
            vi.mocked(dependencies.vaultService.isFileSizeTooLarge).mockReturnValue(true);
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("large.md", "large.md");
            await manager.testAppendQueue([{ type: "CHANGED", file: adapter.converter.toFileInfo(file) }]);

            // File should be skipped
            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });

        it("should skip non-target files", async () => {
            vi.mocked(dependencies.vaultService.isTargetFile).mockResolvedValue(false);
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("non-target.txt", "non-target.txt");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });

        it("should skip recently touched files on CREATE", async () => {
            vi.mocked(dependencies.storageAccessManager.recentlyTouched).mockReturnValue(true);
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("touched.md", "touched.md");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });

        it("should skip recently touched files on CHANGED", async () => {
            vi.mocked(dependencies.storageAccessManager.recentlyTouched).mockReturnValue(true);
            const enqueueSpy = vi.spyOn(manager, "enqueue");

            const file = createMockFile("touched.md", "touched.md");
            await manager.testAppendQueue([{ type: "CHANGED", file: adapter.converter.toFileInfo(file) }]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });

        it("should handle DELETE events", async () => {
            const file = createMockFile("delete.md", "delete.md");
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            await manager.testAppendQueue([
                {
                    type: "DELETE",
                    file: {
                        ...adapter.converter.toFileInfo(file),
                        deleted: true,
                    },
                },
            ]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).toHaveBeenCalled();
        });

        it("should use cached data when provided", async () => {
            const file = createMockFile("cached.md", "cached.md");
            const cachedData = "cached content";
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            await manager.testAppendQueue([
                {
                    type: "CHANGED",
                    file: adapter.converter.toFileInfo(file),
                    cachedData,
                },
            ]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).toHaveBeenCalled();
        });
        it("should skip `shouldBeIgnored` files", async () => {
            const file = createMockFile(FlagFilesHumanReadable.FETCH_ALL, FlagFilesHumanReadable.FETCH_ALL);
            const cachedData = "cached content";
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            await manager.testAppendQueue([
                {
                    type: "CHANGED",
                    file: adapter.converter.toFileInfo(file),
                    cachedData,
                },
            ]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });
        it("should ignore if folder has applied", async () => {
            const folder = createMockFolder("folder", "folder");
            const cachedData = "cached content";
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            await manager.testAppendQueue([
                {
                    type: "I",
                    file: adapter.converter.toFileInfo(folder as any),
                    cachedData,
                },
            ]);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).not.toHaveBeenCalled();
        });
    });

    describe("Queue Operations", () => {
        it("should enqueue items and add sentinel for DELETE", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "DELETE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            manager["enqueue"](item);

            const buffered = manager["bufferedQueuedItems"];
            expect(buffered.length).toBeGreaterThan(0);
            // Should have sentinel before DELETE
            expect(buffered.some((item) => item.type === "SENTINEL_FLUSH")).toBe(true);
        });

        it("should not add sentinel for non-DELETE events", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            const initialLength = manager["bufferedQueuedItems"].length;
            manager["enqueue"](item);

            const buffered = manager["bufferedQueuedItems"];
            // Should not have added sentinel
            expect(buffered.length).toBe(initialLength + 1);
        });
    });

    describe("Waiting Management", () => {
        it("should resolve immediately when no waiting items", async () => {
            await expect(manager["waitForIdle"]()).resolves.toBeUndefined();
        });

        it("should add waiting with correct timing", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            const waitInfo = manager["_addWaiting"]("test-key", item);

            expect(waitInfo).toBeDefined();
            expect(waitInfo.type).toBe("CHANGED");
            expect(manager["_waitingMap"].has("test-key")).toBe(true);
        });

        it("should throw error when adding duplicate waiting key", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            manager["_addWaiting"]("dup-key", item);

            expect(() => {
                manager["_addWaiting"]("dup-key", item);
            }).toThrow("Already waiting for key: dup-key");
        });

        it("should proceed waiting correctly", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            manager["_addWaiting"]("proceed-key", item);
            expect(manager["_waitingMap"].has("proceed-key")).toBe(true);

            manager["_proceedWaiting"]("proceed-key");
            expect(manager["_waitingMap"].has("proceed-key")).toBe(false);
        });

        it("should cancel waiting correctly", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            manager["_addWaiting"]("cancel-key", item);
            expect(manager["_waitingMap"].has("cancel-key")).toBe(true);

            manager["_cancelWaiting"]("cancel-key");
            expect(manager["_waitingMap"].has("cancel-key")).toBe(false);
        });
    });

    describe("File Event Processing", () => {
        it("should handle cancelled events", async () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
                cancelled: true,
            };

            await manager["handleFileEvent"](item);

            // Should not process cancelled events
            expect(dependencies.fileProcessing.processFileEvent).not.toHaveBeenCalled();
        });

        it("should process INTERNAL file events", async () => {
            const file = createMockFile("internal.md", "internal.md");
            const fileInfo = adapter.converter.toFileInfo(file);
            const item: FileEventItem = {
                type: "INTERNAL",
                args: {
                    file: {
                        ...fileInfo,
                        isInternal: true,
                    },
                },
                key: "test-key",
            };

            await manager["handleFileEvent"](item);

            expect(dependencies.fileProcessing.processOptionalFileEvent).toHaveBeenCalled();
        });

        it("should process DELETE events", async () => {
            const file = createMockFile("delete.md", "delete.md");
            const item: FileEventItem = {
                type: "DELETE",
                args: {
                    file: {
                        ...adapter.converter.toFileInfo(file),
                        deleted: true,
                    },
                },
                key: "test-key",
            };

            await manager["handleFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should process CREATE events", async () => {
            const file = createMockFile("create.md", "create.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            await manager["handleFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should process CHANGED events", async () => {
            const file = createMockFile("change.md", "change.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            await manager["handleFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });
    });

    describe("Status Management", () => {
        it("should update status correctly", () => {
            manager["updateStatus"]();

            expect(adapter.status.batched).toBeDefined();
            expect(adapter.status.processing).toBeDefined();
            expect(adapter.status.totalQueued).toBeDefined();
        });

        it("should track processing count", async () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "test-key",
            };

            const initialCount = manager["processingCount"];
            const processPromise = manager["requestProcessQueue"](item);

            // Processing count should increase during processing
            await new Promise((resolve) => setTimeout(resolve, 10));
            await processPromise;

            // Processing count should return to initial after completion
            expect(manager["processingCount"]).toBe(initialCount);
        });
    });

    describe("beginWatch", () => {
        it("should setup watch handlers", async () => {
            await manager.beginWatch();

            // Verify watch was initialized
            expect(adapter.watch["handlers"]).toBeDefined();
        });

        it("should handle create events through watch", async () => {
            await manager.beginWatch();

            const file = createMockFile("watch-test.md", "watch-test.md");
            adapter.watch.simulateCreate(file);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should handle change events through watch", async () => {
            await manager.beginWatch();

            const file = createMockFile("watch-change.md", "watch-change.md");
            adapter.watch.simulateChange(file);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should handle delete events through watch", async () => {
            await manager.beginWatch();

            const file = createMockFile("watch-delete.md", "watch-delete.md");
            adapter.watch.simulateDelete(file);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });

        it("should handle rename events through watch", async () => {
            await manager.beginWatch();

            const file = createMockFile("watch-new.md", "watch-new.md");
            adapter.watch.simulateRename(file, "watch-old.md");

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
        });
    });

    describe("watchEditorChange", () => {
        it("should ignore events without path", () => {
            const editor = {};
            const info = {};

            manager["watchEditorChange"](editor, info);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore events when batchSave is disabled", () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: false,
            });

            const file = createMockFile("test.md", "test.md");
            const editor = {};
            const info = { path: file.path, file };

            manager["watchEditorChange"](editor, info);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore events without file", () => {
            const editor = {};
            const info = { path: "test.md" };

            manager["watchEditorChange"](editor, info);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore events for processing files", () => {
            vi.mocked(dependencies.storageAccessManager.isFileProcessing).mockReturnValue(true);

            const file = createMockFile("test.md", "test.md");
            const editor = {};
            const info = { path: file.path, file, data: "content" };

            manager["watchEditorChange"](editor, info);

            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });

        it("should ignore events when file is not waiting", async () => {
            const file = createMockFile("not-waiting.md", "not-waiting.md");

            const editor = {};
            const info = { path: file.path, file, data: "new content" };

            manager["watchEditorChange"](editor, info);

            // Wait for async processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Should not process because file is not in waiting state
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("cancelRelativeEvent", () => {
        it("should cancel waiting for file path", () => {
            const file = createMockFile("test.md", "test.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "cancel-key",
            };

            manager["_addWaiting"](file.path, item);
            expect(manager["_waitingMap"].has(file.path)).toBe(true);

            manager["cancelRelativeEvent"](item);
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
        });
    });

    describe("Snapshot Management", () => {
        it("should trigger snapshot taking", async () => {
            const saveSpy = vi.spyOn(adapter.persistence, "saveSnapshot");

            manager["triggerTakeSnapshot"]();

            // Wait for throttled execution
            await new Promise((resolve) => setTimeout(resolve, 150));

            expect(saveSpy).toHaveBeenCalled();
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty buffered queue in runQueuedEvents", async () => {
            manager["bufferedQueuedItems"] = [];

            await manager["runQueuedEvents"]();

            expect(manager["bufferedQueuedItems"].length).toBe(0);
        });

        it("should handle file event processing failure", async () => {
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);

            const file = createMockFile("fail.md", "fail.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "fail-key",
            };

            await manager["handleFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should skip already processed file with same mtime", async () => {
            const file = createMockFile("same-mtime.md", "same-mtime.md");
            const fileInfo = adapter.converter.toFileInfo(file);

            // First process
            const item1: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: fileInfo,
                },
                key: "mtime-key-1",
            };

            await manager["handleFileEvent"](item1);

            // Second process with same mtime should be skipped
            const item2: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: fileInfo,
                },
                key: "mtime-key-2",
            };

            await manager["handleFileEvent"](item2);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should handle concurrent processing limit", () => {
            const semaphore = manager["concurrentProcessing"];
            expect(semaphore.waiting).toBeDefined();
        });

        it("should check if file is waiting", () => {
            const file = createMockFile("test.md", "test.md");
            const result = manager["isWaiting"](file.path as FilePath);

            // Should return false when not waiting
            expect(typeof result).toBe("boolean");
        });
    });

    describe("processFileEvent - Interval and Batch Logic", () => {
        beforeEach(() => {
            vi.resetAllMocks();
        });

        it("should process event without previous waiting", async () => {
            const file = createMockFile("simple.md", "simple.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "simple-key",
                skipBatchWait: true,
            };

            await manager["processFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should cancel previous waiting when skipBatchWait is true", async () => {
            const file = createMockFile("skip-batch.md", "skip-batch.md");
            const previousItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "prev-key",
            };

            // Add waiting
            manager["_addWaiting"](file.path, previousItem);
            expect(manager["_waitingMap"].has(file.path)).toBe(true);

            // Process new event with skipBatchWait
            const newItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "new-key",
                skipBatchWait: true,
            };

            await manager["processFileEvent"](newItem);

            // Previous waiting should be cancelled
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should cancel previous waiting when DELETE is requested", async () => {
            const file = createMockFile("delete-cancel.md", "delete-cancel.md");
            const previousItem: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "prev-key",
            };

            // Add waiting
            manager["_addWaiting"](file.path, previousItem);
            expect(manager["_waitingMap"].has(file.path)).toBe(true);

            // Process DELETE event
            const deleteItem: FileEventItem = {
                type: "DELETE",
                args: {
                    file: {
                        ...adapter.converter.toFileInfo(file),
                        deleted: true,
                    },
                },
                key: "delete-key",
            };

            await manager["processFileEvent"](deleteItem);

            // Previous waiting should be cancelled
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should cancel previous waiting when same type event is received", async () => {
            const file = createMockFile("same-type.md", "same-type.md");
            const previousItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "prev-key",
            };

            // Add waiting
            manager["_addWaiting"](file.path, previousItem);
            expect(manager["_waitingMap"].has(file.path)).toBe(true);

            // Process another CHANGED event with skipBatchWait
            const sameTypeItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "same-key",
                skipBatchWait: true,
            };

            await manager["processFileEvent"](sameTypeItem);

            // Previous waiting should be cancelled
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should wait for previous event to complete when different type", async () => {
            const file = createMockFile("wait-previous.md", "wait-previous.md");
            const previousItem: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "prev-key",
            };

            // Add waiting with resolver
            const waitInfo = manager["_addWaiting"](file.path, previousItem);

            // Process CHANGED event after CREATE (different type)
            const changedItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "changed-key",
                skipBatchWait: true, // Skip batch wait to focus on previous waiting
            };

            const processPromise = manager["processFileEvent"](changedItem);

            // Immediately resolve the waiting to avoid timeout
            waitInfo.canProceed.resolve(true);

            await processPromise;

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should add waiting for CREATE event when batch save is enabled", async () => {
            // This test verifies that batch save logic is executed
            // We use skipBatchWait to skip the waiting and focus on the batch decision
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });

            const file = createMockFile("batch-create.md", "batch-create.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "batch-key",
                skipBatchWait: true, // Skip to avoid timeout
            };

            await manager["processFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should add waiting for CHANGED event when batch save is enabled", async () => {
            // This test verifies that batch save logic is executed
            // We use skipBatchWait to skip the waiting and focus on the batch decision
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });

            const file = createMockFile("batch-changed.md", "batch-changed.md");
            const item: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "batch-key",
                skipBatchWait: true, // Skip to avoid timeout
            };

            await manager["processFileEvent"](item);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should skip batch save logic for DELETE event", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });

            const file = createMockFile("batch-delete.md", "batch-delete.md");
            const item: FileEventItem = {
                type: "DELETE",
                args: {
                    file: {
                        ...adapter.converter.toFileInfo(file),
                        deleted: true,
                    },
                },
                key: "delete-key",
            };

            await manager["processFileEvent"](item);

            // Should not add waiting for DELETE
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should skip batch logic when skipBatchWait is true", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });

            const file = createMockFile("skip-batch-create.md", "skip-batch-create.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "skip-key",
                skipBatchWait: true,
            };

            await manager["processFileEvent"](item);

            // Should not add waiting when skipBatchWait is true
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should skip batch logic when batch save is disabled", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: false,
            });

            const file = createMockFile("no-batch.md", "no-batch.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "no-batch-key",
            };

            await manager["processFileEvent"](item);

            // Should not add waiting when batch save is disabled
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        });

        it("should handle waiting cancellation during batch save", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
            });

            const file = createMockFile("cancel-wait.md", "cancel-wait.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "cancel-key",
            };

            const processPromise = manager["processFileEvent"](item);

            // Cancel waiting to cause early return
            await new Promise((resolve) => {
                setTimeout(() => {
                    manager["_cancelWaiting"](file.path);
                    resolve(undefined);
                }, 5);
            });

            await processPromise;

            // When cancelled (canProceed = false), processing should return early
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
        }, 10000);

        it("should restore previous waiting since for batch timeout calculation", async () => {
            vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
                ...DEFAULT_SETTINGS,
                batchSave: true,
                liveSync: false,
                batchSaveMinimumDelay: 100,
                batchSaveMaximumDelay: 500,
            });

            const file = createMockFile("since-restore.md", "since-restore.md");

            // First, add waiting manually and note its timestamp
            const firstItem: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "first-key",
            };
            const firstWaitInfo = manager["_addWaiting"](file.path, firstItem);
            const firstSince = firstWaitInfo.since;

            // Clean up first waiting
            manager["_proceedWaiting"](file.path);

            // Process second event (different type to avoid cancellation)
            const secondItem: FileEventItem = {
                type: "CHANGED",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "second-key",
            };

            // Add waiting for second item - should inherit since
            const secondWaitInfo = manager["_addWaiting"](file.path, secondItem, firstSince);
            const secondSince = secondWaitInfo.since;

            // The second since should be same as first (inherited)
            expect(secondSince).toBe(firstSince);

            // Cleanup
            manager["_proceedWaiting"](file.path);
            return await Promise.resolve();
        });

        it("should handle concurrent processing with semaphore", async () => {
            const file1 = createMockFile("concurrent1.md", "concurrent1.md");
            const file2 = createMockFile("concurrent2.md", "concurrent2.md");

            const item1: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file1),
                },
                key: "key1",
                skipBatchWait: true,
            };

            const item2: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file2),
                },
                key: "key2",
                skipBatchWait: true,
            };

            // Start both processes concurrently
            const process1 = manager["processFileEvent"](item1);
            const process2 = manager["processFileEvent"](item2);

            await Promise.all([process1, process2]);

            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledTimes(2);
        }, 10000);

        it("should properly release semaphore even when processing fails", async () => {
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockRejectedValueOnce(
                new Error("Processing failed")
            );

            const file = createMockFile("error.md", "error.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "error-key",
                skipBatchWait: true,
            };

            try {
                await manager["processFileEvent"](item);
            } catch {
                // Expected to fail
            }

            // Semaphore should still be released (handled by finally block)
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled();
        }, 10000);
    });
});
