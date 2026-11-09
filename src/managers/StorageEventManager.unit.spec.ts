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
import { isReconcileEvent } from "@lib/common/models/fileaccess.definition";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { pendingFileOperations } from "./StorageEventManager/state";
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
        processOptionalFileEvent: vi.fn(() => Promise.resolve(true)),
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
        it("should enqueue a file rename as one event", async () => {
            const file = createMockFile("renamed.md", "renamed.md");
            const oldPath = "old.md";
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            manager.testWatchVaultRename(file, oldPath);
            // Wait for async appendQueue
            await new Promise((resolve) => setTimeout(resolve, 30));

            expect(dependencies.fileProcessing.onStorageFileEvent).toHaveBeenCalled();
            expect(enqueueSpy).toHaveBeenCalledTimes(1);
            expect(enqueueSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "RENAME",
                    args: expect.objectContaining({
                        oldPath,
                        file: expect.objectContaining({ path: "renamed.md" }),
                    }),
                    skipBatchWait: true,
                })
            );
        });

        it("should handle folder rename event", () => {
            const folder = createMockFolder("renamed-folder", "renamed-folder");
            const oldPath = "old-folder";
            manager.testWatchVaultRename(folder, oldPath);
            expect(dependencies.fileProcessing.onStorageFileEvent).not.toHaveBeenCalled();
        });
    });

    describe("watcher admission contracts", () => {
        it.each(["CREATE", "CHANGED", "DELETE"] as const)(
            "preserves the context, adapter receiver, and deletion flag for %s",
            (type) => {
                const file = createMockFile("watched.md", "watched.md");
                const ctx = { source: "watcher" };
                const append = vi.spyOn(manager, "appendQueue").mockResolvedValue(undefined);
                const convert = vi.spyOn(adapter.converter, "toFileInfo");
                const watch = {
                    CREATE: () => manager.testWatchVaultCreate(file, ctx),
                    CHANGED: () => manager.testWatchVaultChange(file, ctx),
                    DELETE: () => manager.testWatchVaultDelete(file, ctx),
                };
                watch[type]();
                expect(convert).toHaveBeenCalledOnce();
                expect(convert.mock.contexts[0]).toBe(adapter.converter);
                expect(convert.mock.calls[0][0]).toBe(file);
                expect(convert.mock.calls[0][1]).toBe(type === "DELETE" ? true : undefined);
                expect(append).toHaveBeenCalledWith(
                    [{ type, file: expect.objectContaining({ path: file.path }) }],
                    ctx
                );
            }
        );

        it("preserves a rename as an immediate event even while its destination is processing", () => {
            const file = createMockFile("destination.md", "destination.md");
            const ctx = { source: "rename" };
            vi.mocked(dependencies.storageAccessManager.isFileProcessing).mockReturnValue(true);
            const append = vi.spyOn(manager, "appendQueue").mockResolvedValue(undefined);
            manager.testWatchVaultRename(file, "source.md", ctx);
            expect(dependencies.storageAccessManager.isFileProcessing).not.toHaveBeenCalled();
            expect(append).toHaveBeenCalledWith(
                [
                    {
                        type: "RENAME",
                        file: expect.objectContaining({ path: file.path }),
                        oldPath: "source.md",
                        skipBatchWait: true,
                    },
                ],
                ctx
            );
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
        it("should wait for restored event processing to finish", async () => {
            let releaseProcessing!: (result: boolean) => void;
            const processing = new Promise<boolean>((resolve) => {
                releaseProcessing = resolve;
            });
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockReturnValue(processing);

            const restoredEvent: FileEventItem = {
                type: "CHANGED",
                key: "restored-key",
                args: {
                    file: adapter.converter.toFileInfo(createMockFile("restored.md", "restored.md")),
                },
            };
            await adapter.persistence.saveSnapshot([restoredEvent]);

            let restorationSettled = false;
            const restoration = manager.restoreState().then(() => {
                restorationSettled = true;
            });

            try {
                await vi.waitFor(() => {
                    expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledTimes(1);
                });
                expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledWith(
                    expect.objectContaining({ restoredFromPreviousRuntime: true })
                );
                await Promise.resolve();
                expect(restorationSettled).toBe(false);
            } finally {
                releaseProcessing(true);
                await restoration;
            }

            expect(restorationSettled).toBe(true);
        });

        it("should preserve sentinel ordering while restoring events", async () => {
            let releaseFirst!: (result: boolean) => void;
            const firstProcessing = new Promise<boolean>((resolve) => {
                releaseFirst = resolve;
            });
            const processingOrder: string[] = [];
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockImplementation(async (event) => {
                const path = event.args.file.path;
                processingOrder.push(`${path}:start`);
                if (path === "first.md") {
                    await firstProcessing;
                }
                processingOrder.push(`${path}:end`);
                return true;
            });

            const firstEvent: FileEventItem = {
                type: "CHANGED",
                key: "first-key",
                args: {
                    file: adapter.converter.toFileInfo(createMockFile("first.md", "first.md")),
                },
            };
            const sentinel: FileEventItemSentinel = { type: "SENTINEL_FLUSH" };
            const secondEvent: FileEventItem = {
                type: "CHANGED",
                key: "second-key",
                args: {
                    file: adapter.converter.toFileInfo(createMockFile("second.md", "second.md")),
                },
            };
            await adapter.persistence.saveSnapshot([firstEvent, sentinel, secondEvent]);

            const restoration = manager.restoreState();
            try {
                await vi.waitFor(() => {
                    expect(processingOrder).toContain("first.md:start");
                });
                await Promise.resolve();
                expect(processingOrder).not.toContain("second.md:start");
            } finally {
                releaseFirst(true);
                await restoration;
            }

            expect(processingOrder).toEqual(["first.md:start", "first.md:end", "second.md:start", "second.md:end"]);
        });

        it("should continue restoration after an operation fails so the full scan can reconcile", async () => {
            const processingOrder: string[] = [];
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockImplementation(async (event) => {
                const path = event.args.file.path;
                processingOrder.push(path);
                if (path === "failed.md") {
                    throw new Error("restored operation failed");
                }
                return true;
            });

            const failedEvent: FileEventItem = {
                type: "CHANGED",
                key: "failed-key",
                args: {
                    file: adapter.converter.toFileInfo(createMockFile("failed.md", "failed.md")),
                },
            };
            const sentinel: FileEventItemSentinel = { type: "SENTINEL_FLUSH" };
            const followingEvent: FileEventItem = {
                type: "CHANGED",
                key: "following-key",
                args: {
                    file: adapter.converter.toFileInfo(createMockFile("following.md", "following.md")),
                },
            };
            await adapter.persistence.saveSnapshot([failedEvent, sentinel, followingEvent]);

            await expect(manager.restoreState()).resolves.toBeUndefined();

            expect(processingOrder).toEqual(["failed.md", "following.md"]);
        });

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

        it("should skip hidden files before target filtering when internal file sync is disabled", async () => {
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile(".git/objects/aa/example", "example");
            await manager.testAppendQueue([{ type: "CREATE", file: adapter.converter.toFileInfo(file) }]);

            expect(dependencies.vaultService.isTargetFile).not.toHaveBeenCalled();
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

        it("should turn a rename out of the target set into a delete", async () => {
            vi.mocked(dependencies.vaultService.isTargetFile).mockImplementation(async (path) => path === "old.md");
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("excluded.txt", "excluded.txt");

            await manager.testAppendQueue([
                { type: "RENAME", file: adapter.converter.toFileInfo(file), oldPath: "old.md" },
            ]);

            expect(enqueueSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "DELETE",
                    args: expect.objectContaining({
                        oldPath: undefined,
                        renameTarget: "excluded.txt",
                        file: expect.objectContaining({ path: "old.md", deleted: true }),
                    }),
                })
            );
        });

        it("should turn a rename into the target set into a create", async () => {
            vi.mocked(dependencies.vaultService.isTargetFile).mockImplementation(
                async (path) => path === "included.md"
            );
            const enqueueSpy = vi.spyOn(manager, "enqueue");
            const file = createMockFile("included.md", "included.md");

            await manager.testAppendQueue([
                { type: "RENAME", file: adapter.converter.toFileInfo(file), oldPath: "excluded.txt" },
            ]);

            expect(enqueueSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "CREATE",
                    args: expect.objectContaining({
                        oldPath: undefined,
                        file: expect.objectContaining({ path: "included.md" }),
                    }),
                })
            );
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
            expect(enqueueSpy.mock.calls[0]?.[0].args.renameTarget).toBeUndefined();
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

        it("should enqueue items and add sentinel for RENAME", () => {
            const file = createMockFile("renamed.md", "renamed.md");
            const item: FileEventItem = {
                type: "RENAME",
                args: {
                    file: adapter.converter.toFileInfo(file),
                    oldPath: "old.md",
                },
                key: "test-key",
            };

            manager["enqueue"](item);

            const buffered = manager["bufferedQueuedItems"];
            expect(buffered.some((item) => item.type === "SENTINEL_FLUSH")).toBe(true);
        });

        it("should not add sentinel for non-destructive events", () => {
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

            await expect(manager["handleFileEvent"](item)).rejects.toThrow("no confirmed result");

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

            await expect(manager["handleFileEvent"](item)).rejects.toThrow("Storage operation failed");

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

            const processPromise = expect(manager["processFileEvent"](item)).rejects.toThrow("without a successor");

            // A cancelled gate alone does not establish successful completion.
            await new Promise((resolve) => {
                setTimeout(() => {
                    manager["_cancelWaiting"](file.path);
                    resolve(undefined);
                }, 5);
            });

            await processPromise;

            // The cancelled attempt remains recoverable; a later flush makes a new attempt.
            expect(manager["_waitingMap"].has(file.path)).toBe(false);
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
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

        it("processes an unrelated file while hot-file predecessors are still running", async () => {
            let releaseHotFile!: () => void;
            const hotGate = new Promise<void>((resolve) => {
                releaseHotFile = resolve;
            });
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockImplementation(async (item) => {
                if (item.args.file.path === "hot-queue.md") await hotGate;
                return true;
            });
            const event = (path: string, index: number): FileEventItem => ({
                type: "CHANGED",
                args: { file: adapter.converter.toFileInfo(createMockFile(path, path)) },
                key: `queue-${index}`,
                skipBatchWait: true,
            });
            const hot = Array.from({ length: 5 }, (_, index) => manager.processFileEvent(event("hot-queue.md", index)));
            const unrelated = manager.processFileEvent(event("unrelated-queue.md", 5));
            try {
                await vi.waitFor(() => {
                    expect(process).toHaveBeenCalledTimes(2);
                    expect(process.mock.calls.some(([item]) => item.args.file.path === "unrelated-queue.md")).toBe(
                        true
                    );
                });
                expect(process.mock.calls[0][0].args.file.path).toBe("hot-queue.md");
            } finally {
                releaseHotFile();
                await Promise.all([...hot, unrelated]);
            }
            expect(process).toHaveBeenCalledTimes(6);
            expect(process.mock.calls.some(([item]) => item.args.file.path === "unrelated-queue.md")).toBe(true);
        });

        it("should properly release semaphore even when processing fails", async () => {
            manager["concurrentProcessing"] = Semaphore(1);
            vi.mocked(dependencies.fileProcessing.processFileEvent)
                .mockRejectedValueOnce(new Error("Processing failed"))
                .mockResolvedValue(true);

            const file = createMockFile("error.md", "error.md");
            const item: FileEventItem = {
                type: "CREATE",
                args: {
                    file: adapter.converter.toFileInfo(file),
                },
                key: "error-key",
                skipBatchWait: true,
            };

            await expect(manager.processFileEvent(item)).rejects.toThrow("Processing failed");

            // Independent work must acquire the only permit after the failed handler.
            const following: FileEventItem = {
                ...item,
                args: { file: adapter.converter.toFileInfo(createMockFile("after-error.md", "after-error.md")) },
                key: "after-error-key",
            };
            await expect(manager.processFileEvent(following)).resolves.toBeUndefined();
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledTimes(2);
        }, 10000);
    });

    describe("durable local completion", () => {
        function event(path: string, key = path): FileEventItem {
            return {
                type: "CHANGED",
                key,
                skipBatchWait: true,
                args: { file: adapter.converter.toFileInfo(createMockFile(path, path)) },
            };
        }

        it("includes watcher admission already under way when flush is requested", async () => {
            let release!: (result: boolean) => void;
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockReturnValue(
                new Promise<boolean>((resolve) => {
                    release = resolve;
                })
            );
            const file = adapter.converter.toFileInfo(createMockFile("admitting.md", "admitting.md"));
            const admission = manager.appendQueue([{ type: "CHANGED", file, skipBatchWait: true }]);
            let settled = false;
            const flush = manager.waitForIdle().then(() => {
                settled = true;
            });
            try {
                await admission;
                await vi.waitFor(() => expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled());
                expect(settled).toBe(false);
            } finally {
                release(true);
                await flush;
                await vi.waitFor(() => expect(adapter.status.processing).toBe(0));
            }
        });

        it("stops new watcher admission while draining accepted operations", async () => {
            let release!: (result: boolean) => void;
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockReturnValue(
                new Promise<boolean>((resolve) => {
                    release = resolve;
                })
            );
            const item = event("before-stop.md");
            manager.enqueue(item);
            await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
            let stopped = false;
            const stopping = manager.stopWatching().then(() => {
                stopped = true;
            });
            try {
                const file = adapter.converter.toFileInfo(createMockFile("after-stop.md", "after-stop.md"));
                await manager.appendQueue([{ type: "CHANGED", file, skipBatchWait: true }]);
                expect(stopped).toBe(false);
                expect(process).toHaveBeenCalledOnce();
                expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            } finally {
                release(true);
                await stopping;
            }
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("preserves failed operations before orderly shutdown finishes", async () => {
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const item = event("failed-at-stop.md");
            manager.enqueue(item);
            await expect(manager.stopWatching()).resolves.toBeUndefined();
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
        });

        it("retains an event in the snapshot throughout its database write", async () => {
            let release!: (result: boolean) => void;
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockReturnValue(
                new Promise<boolean>((resolve) => {
                    release = resolve;
                })
            );
            const item = event("in-progress.md");
            manager.enqueue(item);
            try {
                await vi.waitFor(() => expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled());
                await manager._takeSnapshot();
                expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            } finally {
                release(true);
                await vi.waitFor(() => expect(adapter.status.processing).toBe(0));
            }
        });

        it("waits for an in-progress write even when no batch timer remains", async () => {
            let release!: (result: boolean) => void;
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockReturnValue(
                new Promise<boolean>((resolve) => {
                    release = resolve;
                })
            );
            manager.enqueue(event("flush-running.md"));
            let settled = false;
            let flush: Promise<void> | undefined;
            try {
                await vi.waitFor(() => expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled());
                flush = manager.waitForIdle().then(() => {
                    settled = true;
                });
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(settled).toBe(false);
            } finally {
                release(true);
                await flush;
                await vi.waitFor(() => expect(adapter.status.processing).toBe(0));
            }
        });

        it("reports a false handler result and retains the failed operation", async () => {
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const item = event("failed-write.md");
            manager.enqueue(item);
            await vi.waitFor(() => expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalled());
            await expect(manager.waitForIdle()).rejects.toThrow();
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
        });
    });

    it("keeps live settings and virtual host methods across the responsibility facade", async () => {
        const seen: string[] = [];
        class HostManager extends TestStorageEventManager {
            override async processFileEvent(event: FileEventItem) {
                seen.push(`process:${event.key}`);
                await super.processFileEvent(event);
            }
            protected override async requestProcessQueue(event: FileEventItem) {
                seen.push(`request:${event.key}`);
                await super.requestProcessQueue(event);
            }
            protected override async handleFileEvent(event: FileEventItem) {
                seen.push(`handle:${event.key}`);
                await super.handleFileEvent(event);
            }
            override async _takeSnapshot() {
                seen.push("takeSnapshot");
                await super._takeSnapshot();
            }
            override async _saveSnapshot(events: (FileEventItem | FileEventItemSentinel)[]) {
                seen.push("saveSnapshot");
                await super._saveSnapshot(events);
            }
            override async _loadSnapshot() {
                seen.push("loadSnapshot");
                return await super._loadSnapshot();
            }
        }
        const host = new HostManager(adapter, dependencies);
        const save = vi.spyOn(adapter.persistence, "saveSnapshot");
        const event = (path: string, key: string): FileEventItem => ({
            type: "CHANGED",
            key,
            args: { file: adapter.converter.toFileInfo(createMockFile(path, path)) },
        });
        const first = event("batched-host.md", "batched-host");
        const batched = host.processFileEvent(first);
        void batched.catch(() => {});
        await vi.waitFor(() => expect(host.isWaiting(first.args.file.path as FilePath)).toBe(true));
        vi.mocked(dependencies.setting.currentSettings).mockReturnValue({
            ...DEFAULT_SETTINGS,
            isConfigured: true,
            batchSave: false,
        });
        const second = event("immediate-host.md", "immediate-host");
        const immediate = host.processFileEvent(second);
        void immediate.catch(() => {});
        try {
            await vi.waitFor(() => expect(seen).toContain(`handle:${second.key}`));
            expect(host.isWaiting(first.args.file.path as FilePath)).toBe(true);
        } finally {
            await host.waitForIdle();
            await Promise.all([batched, immediate]);
        }
        const queued = event("queued-host.md", "queued-host");
        host.enqueue(queued);
        await host.waitForIdle();
        await host.restoreState();
        for (const item of [first, second, queued]) {
            expect(seen).toContain(`process:${item.key}`);
            expect(seen).toContain(`request:${item.key}`);
            expect(seen).toContain(`handle:${item.key}`);
        }
        expect(seen).toContain("takeSnapshot");
        expect(seen).toContain("saveSnapshot");
        expect(seen).toContain("loadSnapshot");
        expect(save.mock.contexts.every((context) => context === adapter.persistence)).toBe(true);
        expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
    });

    describe("issue 1331 investigation", () => {
        function fileEvent(type: FileEventItem["type"], path: string): FileEventItem {
            return {
                type,
                key: `${type}-${path}`,
                skipBatchWait: true,
                args: { file: adapter.converter.toFileInfo(createMockFile(path, path)) },
            };
        }

        it("issue1331 retries a persistent failure only once in each later flush", async () => {
            const temporaryPath = "note.md.tmp.1331.hash";
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockImplementation(async (item) => item.args.file.path !== temporaryPath);
            const temporary = fileEvent("CREATE", temporaryPath);
            manager.enqueue(temporary);
            await expect(manager.waitForIdle()).rejects.toThrow(`Storage operation failed: ${temporaryPath}`);

            const finalFile = fileEvent("CHANGED", "note.md");
            manager.enqueue(finalFile);
            await expect(manager.waitForIdle()).rejects.toThrow(`Storage operation failed: ${temporaryPath}`);
            await expect(manager.waitForIdle()).rejects.toThrow(`Storage operation failed: ${temporaryPath}`);

            expect(process.mock.calls.map(([item]) => item.args.file.path)).toEqual([
                temporaryPath,
                temporaryPath,
                "note.md",
                temporaryPath,
            ]);
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(temporary);
            expect(adapter.persistence.getStoredSnapshot()).not.toContainEqual(finalFile);
            expect(manager.hasPendingFileEvent(temporaryPath as FilePath)).toBe(true);
        });

        it("issue1331 re-evaluates a vanished temporary-file save before its later deletion", async () => {
            const temporaryPath = "note.md.tmp.1331.hash";
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockResolvedValueOnce(false).mockResolvedValue(true);
            manager.enqueue(fileEvent("CREATE", temporaryPath));
            await expect(manager.waitForIdle()).rejects.toThrow(`Storage operation failed: ${temporaryPath}`);

            manager.enqueue(fileEvent("CHANGED", "note.md"));
            manager.enqueue(fileEvent("DELETE", temporaryPath));
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(process.mock.calls.map(([item]) => item.type)).toEqual(["CREATE", "CREATE", "CHANGED", "DELETE"]);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("issue1331 retries a failed predecessor before a later same-path edit without a flush", async () => {
            const path = "edited-again.md";
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockResolvedValue(false);
            const first = fileEvent("CHANGED", path);
            first.key = "first-edit";
            await expect(manager.processFileEvent(first)).rejects.toThrow(`Storage operation failed: ${path}`);

            process.mockResolvedValue(true);
            const later = fileEvent("CHANGED", path);
            later.key = "later-edit";
            await expect(manager.processFileEvent(later)).resolves.toBeUndefined();

            expect(process.mock.calls.map(([item]) => item.key)).toEqual([first.key, first.key, later.key]);
            const retry = process.mock.calls[1][0];
            expect(isReconcileEvent(retry)).toBe(true);
            expect(isReconcileEvent(first)).toBe(false);
            expect(isReconcileEvent(later)).toBe(false);
            expect(retry).not.toBe(first);
            expect(JSON.parse(JSON.stringify(retry))).toEqual(first);
            expect(isReconcileEvent(JSON.parse(JSON.stringify(retry)))).toBe(false);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            expect(manager.hasPendingFileEvent(path as FilePath)).toBe(false);
        });

        it("shares a retry between overlapping flushes without including a later same-path edit", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockResolvedValueOnce(false);
            const first = fileEvent("CHANGED", "overlap.md");
            const original = manager.processFileEvent(first);
            await expect(original).rejects.toThrow("Storage operation failed");

            let releaseRetry!: (result: boolean) => void;
            let releaseLater!: (result: boolean) => void;
            process.mockImplementation(
                async (item) =>
                    await new Promise<boolean>((resolve) => {
                        if (item.key === first.key) releaseRetry = resolve;
                        else releaseLater = resolve;
                    })
            );
            const flushing = Promise.all([manager.waitForIdle(), manager.waitForIdle()]);
            void flushing.catch(() => {});
            await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
            expect(adapter.persistence.getStoredSnapshot()).toContain(first);
            expect(Object.getOwnPropertySymbols(first)).toEqual([]);
            const later = fileEvent("CHANGED", "overlap.md");
            later.key = "later-overlap";
            const editing = manager.processFileEvent(later);
            try {
                releaseRetry(true);
                await flushing;
                await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(3));
                expect(adapter.persistence.getStoredSnapshot()).toContainEqual(later);
                expect(adapter.persistence.getStoredSnapshot()).not.toContainEqual(first);
                await expect(original).rejects.toThrow("Storage operation failed");
            } finally {
                releaseLater?.(true);
                await editing;
            }
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("does not retry an admitted attempt which first fails during this flush", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const file = adapter.converter.toFileInfo(createMockFile("new-failure.md", "new-failure.md"));
            const admission = manager.appendQueue([{ type: "CHANGED", file, skipBatchWait: true }]);
            const flush = manager.waitForIdle();
            await admission;
            await expect(flush).rejects.toThrow("Storage operation failed");
            expect(process).toHaveBeenCalledOnce();
            await expect(manager.waitForIdle()).rejects.toThrow("Storage operation failed");
            expect(process).toHaveBeenCalledTimes(2);
        });

        it("retains completion-snapshot failure for retry and for a fresh manager", async () => {
            const first = fileEvent("CHANGED", "completion-failure.md");
            const save = adapter.persistence.saveSnapshot.bind(adapter.persistence);
            let rejectCompletion = true;
            vi.spyOn(adapter.persistence, "saveSnapshot").mockImplementation(async (snapshot) => {
                if (rejectCompletion && !snapshot.includes(first)) throw new Error("completion snapshot unavailable");
                await save(snapshot);
            });
            await expect(manager.processFileEvent(first)).rejects.toThrow("completion snapshot unavailable");
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(first);
            await expect(manager.waitForIdle()).rejects.toThrow("completion snapshot unavailable");
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledTimes(2);
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(first);

            rejectCompletion = false;
            const restarted = new TestStorageEventManager(adapter, dependencies);
            await restarted.restoreState();
            await expect(restarted.waitForIdle()).resolves.toBeUndefined();
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("does not extend retry to an internal provider", async () => {
            const optional = vi
                .mocked(dependencies.fileProcessing.processOptionalFileEvent)
                .mockRejectedValue(new Error("optional provider unavailable"));
            const item = fileEvent("INTERNAL", "internal.md");
            await expect(manager.processFileEvent(item)).rejects.toThrow("optional provider unavailable");
            await expect(manager.waitForIdle()).rejects.toThrow("optional provider unavailable");
            expect(optional).toHaveBeenCalledOnce();
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
        });

        it.each(["DELETE", "RENAME"] as const)(
            "does not let a standalone %s sentinel wait for its successor",
            async (type) => {
                const item = fileEvent(type, "standalone.md");
                if (type === "RENAME") item.args.oldPath = "source.md";
                manager.enqueue(item);
                await expect(manager.waitForIdle()).resolves.toBeUndefined();
                expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledOnce();
                expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            }
        );

        it.each(["oldPath", "renameTarget"] as const)(
            "retries a failed predecessor related through %s before a new event",
            async (relation) => {
                const process = vi
                    .mocked(dependencies.fileProcessing.processFileEvent)
                    .mockResolvedValueOnce(false)
                    .mockResolvedValue(true);
                const predecessor = fileEvent("CHANGED", "source.md");
                await expect(manager.processFileEvent(predecessor)).rejects.toThrow("Storage operation failed");
                const next = fileEvent(relation === "oldPath" ? "RENAME" : "DELETE", "target.md");
                next.args[relation] = "source.md";
                await expect(manager.processFileEvent(next)).resolves.toBeUndefined();
                expect(process.mock.calls.map(([item]) => item.key)).toEqual([
                    predecessor.key,
                    predecessor.key,
                    next.key,
                ]);
                expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            }
        );

        it("does not retry a failure first observed behind a delete sentinel in the same request", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            manager.enqueue(fileEvent("CREATE", "first-failure.md"));
            manager.enqueue(fileEvent("DELETE", "first-failure.md"));
            await expect(manager.waitForIdle()).rejects.toThrow("Storage operation failed");
            expect(process).toHaveBeenCalledOnce();
            await expect(manager.waitForIdle()).rejects.toThrow("Storage operation failed");
            expect(process).toHaveBeenCalledTimes(2);
        });

        it("re-evaluates a related predecessor which failed before it could register its handler", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            vi.spyOn(adapter.persistence, "saveSnapshot").mockRejectedValueOnce(
                new Error("admission snapshot unavailable")
            );
            const predecessor = fileEvent("CHANGED", "snapshot-admission.md");
            manager.enqueue(predecessor);
            await vi.waitFor(() => expect(manager["operations"].get(predecessor)?.attempt.result?.ok).toBe(false));
            expect(process).not.toHaveBeenCalled();
            const later = fileEvent("CHANGED", "snapshot-admission.md");
            later.key = "after-snapshot-failure";
            await expect(manager.processFileEvent(later)).resolves.toBeUndefined();
            expect(process.mock.calls.map(([item]) => item.key)).toEqual([predecessor.key, later.key]);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("retries a coalesced predecessor and its failed successor without a wait cycle", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const path = "coalesced-failure.md" as FilePath;
            const predecessor = fileEvent("CHANGED", path);
            predecessor.skipBatchWait = false;
            const older = manager.processFileEvent(predecessor);
            void older.catch(() => {});
            await vi.waitFor(() => expect(manager.isWaiting(path)).toBe(true));
            const successor = fileEvent("CHANGED", path);
            successor.key = "failed-successor";
            await expect(manager.processFileEvent(successor)).rejects.toThrow("Storage operation failed");
            await expect(older).rejects.toThrow("Storage operation failed");
            expect(process).toHaveBeenCalledOnce();
            process.mockResolvedValue(true);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(process).toHaveBeenCalledTimes(3);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            await expect(older).rejects.toThrow("Storage operation failed");
        });

        it("rolls back a failed completion before the next queued snapshot captures pending work", async () => {
            const item = fileEvent("CHANGED", "snapshot-race.md");
            const save = adapter.persistence.saveSnapshot.bind(adapter.persistence);
            let rejectCompletion!: (error: Error) => void;
            let releaseFollowing!: () => void;
            let failed = false;
            let following: (FileEventItem | FileEventItemSentinel)[] | undefined;
            vi.spyOn(adapter.persistence, "saveSnapshot").mockImplementation(async (snapshot) => {
                if (!failed && snapshot.length === 0) {
                    await new Promise<void>((_resolve, reject) => {
                        rejectCompletion = reject;
                    });
                } else if (failed && !following) {
                    following = snapshot;
                    await new Promise<void>((resolve) => {
                        releaseFollowing = resolve;
                    });
                }
                await save(snapshot);
            });
            const attempted = expect(manager.processFileEvent(item)).rejects.toThrow("completion failed");
            await vi.waitFor(() => expect(rejectCompletion).toBeTypeOf("function"));
            const nextSnapshot = manager._takeSnapshot();
            failed = true;
            rejectCompletion(new Error("completion failed"));
            try {
                await attempted;
                await vi.waitFor(() => expect(following).toBeDefined());
                expect(following).toContainEqual(item);
            } finally {
                releaseFollowing?.();
                await nextSnapshot;
            }
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("does not settle a started attempt while its admission snapshot failure is still being drained", async () => {
            const item = fileEvent("CHANGED", "admission-race.md");
            const save = adapter.persistence.saveSnapshot.bind(adapter.persistence);
            let rejectAdmission!: (error: Error) => void;
            let releaseProcessing!: () => void;
            let calls = 0;
            vi.spyOn(adapter.persistence, "saveSnapshot").mockImplementation(async (snapshot) => {
                if (++calls === 1) {
                    await new Promise<void>((_resolve, reject) => {
                        rejectAdmission = reject;
                    });
                } else if (calls === 2) {
                    await new Promise<void>((resolve) => {
                        releaseProcessing = resolve;
                    });
                }
                await save(snapshot);
            });
            manager.enqueue(item);
            let settled = false;
            const firstFlush = manager.waitForIdle().then(
                (): undefined => {
                    settled = true;
                    return undefined;
                },
                (error: unknown) => {
                    settled = true;
                    return error;
                }
            );
            await vi.waitFor(() => expect(manager["operations"].get(item)?.attempt.started).toBe(true));
            rejectAdmission(new Error("admission failed"));
            try {
                await vi.waitFor(() => expect(releaseProcessing).toBeTypeOf("function"));
                expect(settled).toBe(false);
            } finally {
                releaseProcessing?.();
                expect(await firstFlush).toEqual(new Error("admission failed"));
                await vi.waitFor(() => expect(adapter.status.processing).toBe(0));
            }
            expect(dependencies.fileProcessing.processFileEvent).not.toHaveBeenCalled();
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledOnce();
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("drains an active handler before reporting a delayed admission-snapshot failure", async () => {
            const item = fileEvent("CHANGED", "active-admission-failure.md");
            let rejectAdmission!: (error: Error) => void;
            let releaseHandler!: (result: boolean) => void;
            const snapshot = manager._takeSnapshot.bind(manager);
            vi.spyOn(manager, "_takeSnapshot")
                .mockImplementationOnce(
                    async () =>
                        await new Promise<void>((_resolve, reject) => {
                            rejectAdmission = reject;
                        })
                )
                .mockImplementation(snapshot);
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockImplementationOnce(
                async () =>
                    await new Promise<boolean>((resolve) => {
                        releaseHandler = resolve;
                    })
            );
            manager.enqueue(item);
            let settled = false;
            const firstFlush = manager.waitForIdle().then(
                (): undefined => {
                    settled = true;
                    return undefined;
                },
                (error: unknown) => {
                    settled = true;
                    return error;
                }
            );
            await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
            rejectAdmission(new Error("delayed admission failure"));
            await vi.waitFor(() => expect(manager["operations"].get(item)?.attempt.admissionFailure).toBeDefined());
            const overlap = manager.waitForIdle().catch((error: unknown) => error);
            try {
                expect(settled).toBe(false);
                expect(process).toHaveBeenCalledOnce();
            } finally {
                releaseHandler(true);
                expect(await firstFlush).toEqual(new Error("delayed admission failure"));
                expect(await overlap).toEqual(new Error("delayed admission failure"));
            }
            expect(adapter.persistence.getStoredSnapshot()).toContainEqual(item);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(process).toHaveBeenCalledTimes(2);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("review retry preserves original failures through a naturally accumulated same-path history", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const originals: Promise<void>[] = [];
            for (let index = 0; index < 24; index++) {
                const item = fileEvent("CHANGED", "retry-history.md");
                item.key = `history-${index}`;
                const attempted = manager.processFileEvent(item);
                originals.push(attempted);
                await expect(attempted).rejects.toThrow("Storage operation failed: retry-history.md");
            }
            expect(process).toHaveBeenCalledTimes(originals.length);
            expect(adapter.persistence.getStoredSnapshot()).toHaveLength(originals.length);
            process.mockResolvedValue(true);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            expect(process).toHaveBeenCalledTimes(originals.length * 2);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            for (const original of originals) await expect(original).rejects.toThrow("Storage operation failed");
        });

        it("review retry settles a long retained same-path history after a further edit", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const first = fileEvent("CHANGED", "long-retry-history.md");
            await expect(manager.processFileEvent(first)).rejects.toThrow("Storage operation failed");
            const root = manager["operations"].get(first)!;
            let previous = root;
            // Model a long history of failed, already-dispatched dependent edits.
            // Admission persistence and status projection are separate from dependency traversal.
            vi.spyOn(manager, "_takeSnapshot").mockResolvedValue();
            vi.spyOn(manager as unknown as { updateStatus(): void }, "updateStatus").mockImplementation(() => {});
            for (let index = 1; index < 12_000; index++) {
                const item = fileEvent("CHANGED", first.args.file.path);
                item.key = `retained-history-${index}`;
                const operation = manager["retainEvent"](item).operation!;
                operation.initialised = true;
                operation.prerequisites.add(previous);
                operation.attempt = { ...root.attempt };
                previous = operation;
            }
            const latest = fileEvent("CHANGED", first.args.file.path);
            latest.key = "edit-after-long-history";
            await expect(manager.processFileEvent(latest)).rejects.toThrow(
                "Storage operation failed: long-retry-history.md"
            );
            expect(process).toHaveBeenCalledTimes(2);
            expect(
                pendingFileOperations(manager["eventState"]).every(
                    (operation) => operation.attempt.result?.ok === false
                )
            ).toBe(true);
            expect(manager.hasPendingFileEvent(first.args.file.path as FilePath)).toBe(true);
        }, 15_000);

        it("review retry settles a long history which failed before any operation was dispatched", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const first = fileEvent("CHANGED", "undispatched-history.md");
            vi.spyOn(adapter.persistence, "saveSnapshot").mockRejectedValueOnce(new Error("initial admission failed"));
            manager.enqueue(first);
            await vi.waitFor(() => expect(manager["operations"].get(first)?.attempt.result?.ok).toBe(false));
            const root = manager["operations"].get(first)!;
            expect(root.initialised).toBe(false);
            vi.spyOn(manager, "_takeSnapshot").mockResolvedValue();
            vi.spyOn(manager as unknown as { updateStatus(): void }, "updateStatus").mockImplementation(() => {});
            for (let index = 1; index < 12_000; index++) {
                const item = fileEvent("CHANGED", first.args.file.path);
                item.key = `undispatched-history-${index}`;
                const operation = manager["retainEvent"](item).operation!;
                operation.attempt = { ...root.attempt };
            }
            const latest = fileEvent("CHANGED", first.args.file.path);
            latest.key = "edit-after-undispatched-history";
            await expect(manager.processFileEvent(latest)).rejects.toThrow(
                "Storage operation failed: undispatched-history.md"
            );
            expect(process).toHaveBeenCalledOnce();
            expect(
                pendingFileOperations(manager["eventState"]).every(
                    (operation) => operation.attempt.result?.ok === false
                )
            ).toBe(true);
        }, 15_000);

        it("review retry releases the predecessor batch before a related rename retries an undispatched delete", async () => {
            const calls: string[] = [];
            vi.mocked(dependencies.fileProcessing.processFileEvent).mockImplementation(async (item) => {
                calls.push(item.key);
                return true;
            });
            const predecessor = fileEvent("CHANGED", "batched-source.md");
            predecessor.key = "batched-predecessor";
            predecessor.skipBatchWait = false;
            const saving = manager.processFileEvent(predecessor);
            void saving.catch(() => {});
            await vi.waitFor(() => expect(manager.isWaiting(predecessor.args.file.path as FilePath)).toBe(true));
            await manager._takeSnapshot();
            vi.spyOn(adapter.persistence, "saveSnapshot").mockRejectedValueOnce(new Error("delete admission failed"));
            const deletion = fileEvent("DELETE", predecessor.args.file.path);
            deletion.key = "undispatched-delete";
            manager.enqueue(deletion);
            await vi.waitFor(() => expect(manager["operations"].get(deletion)?.attempt.result?.ok).toBe(false));
            expect(calls).toEqual([]);
            const rename = fileEvent("RENAME", "renamed-target.md");
            rename.key = "related-rename";
            rename.args.oldPath = predecessor.args.file.path;
            const renaming = manager.processFileEvent(rename);
            void renaming.catch(() => {});
            const probe = fileEvent("CHANGED", "batch-ordering-probe.md");
            probe.key = "independent-probe";
            await manager.processFileEvent(probe);
            expect(calls).toContain(predecessor.key);
            await Promise.all([saving, renaming]);
            expect(calls.filter((key) => key !== probe.key)).toEqual([predecessor.key, deletion.key, rename.key]);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("review retry settles setup failure so a later flush can start a new attempt", async () => {
            const error = new Error("dependency preparation failed");
            const planning = manager as unknown as { captureAttempts(): Map<unknown, unknown> };
            vi.spyOn(planning, "captureAttempts").mockImplementationOnce(() => {
                throw error;
            });
            const item = fileEvent("CHANGED", "setup-failure.md");
            const original = manager.processFileEvent(item);
            await expect(original).rejects.toBe(error);
            expect(manager["operations"].get(item)?.attempt.result).toEqual({ ok: false, error });
            expect(dependencies.fileProcessing.processFileEvent).not.toHaveBeenCalled();
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            await expect(original).rejects.toBe(error);
            expect(dependencies.fileProcessing.processFileEvent).toHaveBeenCalledOnce();
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it("review retry leaves existing attempts settled if dependency planning itself fails", async () => {
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent).mockResolvedValue(false);
            const first = fileEvent("CHANGED", "planning-failure.md");
            first.key = "planning-first";
            await expect(manager.processFileEvent(first)).rejects.toThrow("Storage operation failed");
            const second = fileEvent("CHANGED", first.args.file.path);
            second.key = "planning-second";
            await expect(manager.processFileEvent(second)).rejects.toThrow("Storage operation failed");
            const firstOperation = manager["operations"].get(first)!;
            const secondOperation = manager["operations"].get(second)!;
            const attempts = [firstOperation.attempt, secondOperation.attempt];
            const error = new Error("dependency iteration failed");
            vi.spyOn(secondOperation.prerequisites, Symbol.iterator).mockImplementationOnce(() => {
                throw error;
            });
            const later = fileEvent("CHANGED", first.args.file.path);
            later.key = "after-planning-failure";
            const original = manager.processFileEvent(later);
            await expect(original).rejects.toBe(error);
            expect(firstOperation.attempt).toBe(attempts[0]);
            expect(secondOperation.attempt).toBe(attempts[1]);
            expect(
                pendingFileOperations(manager["eventState"]).every(
                    (operation) => operation.attempt.result?.ok === false
                )
            ).toBe(true);
            process.mockResolvedValue(true);
            await expect(manager.waitForIdle()).resolves.toBeUndefined();
            await expect(original).rejects.toBe(error);
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });

        it.each(["DELETE", "RENAME"] as const)(
            "review retry keeps an undispatched %s behind its predecessor sentinel",
            async (type) => {
                const calls: string[] = [];
                let releasePredecessor!: (result: boolean) => void;
                vi.mocked(dependencies.fileProcessing.processFileEvent).mockImplementation(async (item) => {
                    calls.push(item.key);
                    if (item.key === "running-predecessor") {
                        return await new Promise<boolean>((resolve) => {
                            releasePredecessor = resolve;
                        });
                    }
                    return true;
                });
                const predecessor = fileEvent("CHANGED", "unrelated-running.md");
                predecessor.key = "running-predecessor";
                manager.enqueue(predecessor);
                await vi.waitFor(() => expect(calls).toEqual([predecessor.key]));
                const failure = new Error("destructive admission snapshot failed");
                vi.spyOn(adapter.persistence, "saveSnapshot").mockRejectedValueOnce(failure);
                const destructive = fileEvent(type, "destructive-target.md");
                destructive.key = "destructive-retry";
                if (type === "RENAME") destructive.args.oldPath = "destructive-source.md";
                manager.enqueue(destructive);
                await vi.waitFor(() =>
                    expect(manager["operations"].get(destructive)?.attempt.result).toEqual({
                        ok: false,
                        error: failure,
                    })
                );
                expect(manager["operations"].get(destructive)?.attempt.started).toBe(false);
                const flushing = manager.waitForIdle();
                void flushing.catch(() => {});
                const probe = fileEvent("CHANGED", "independent-probe.md");
                probe.key = "independent-probe";
                try {
                    await manager.processFileEvent(probe);
                    expect(calls).toEqual([predecessor.key, probe.key]);
                } finally {
                    releasePredecessor(true);
                    await flushing;
                }
                expect(calls).toEqual([predecessor.key, probe.key, destructive.key]);
                expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            }
        );

        it.each([
            ["DELETE", false],
            ["RENAME", false],
            ["DELETE", true],
            ["RENAME", true],
        ] as const)(
            "review retry keeps an already-dispatched %s behind new predecessor attempts (restored: %s)",
            async (type, restored) => {
                const calls: string[] = [];
                const process = vi
                    .mocked(dependencies.fileProcessing.processFileEvent)
                    .mockImplementation(async (item) => {
                        calls.push(item.key);
                        return false;
                    });
                const predecessor = fileEvent("CHANGED", "failed-predecessor.md");
                predecessor.key = "predecessor-retry";
                const destructive = fileEvent(type, "failed-destructive.md");
                destructive.key = "dispatched-destructive-retry";
                if (type === "RENAME") destructive.args.oldPath = "failed-source.md";
                if (restored) {
                    await adapter.persistence.saveSnapshot([predecessor, { type: "SENTINEL_FLUSH" }, destructive]);
                    await manager.restoreState();
                } else {
                    manager.enqueue(predecessor);
                    manager.enqueue(destructive);
                    await expect(manager.waitForIdle()).rejects.toThrow("Storage operation failed");
                }
                await vi.waitFor(() =>
                    expect(
                        pendingFileOperations(manager["eventState"]).find(
                            (operation) => operation.event.key === destructive.key
                        )?.attempt.result?.ok
                    ).toBe(false)
                );
                expect(calls).toEqual([predecessor.key, destructive.key]);
                calls.length = 0;
                let releasePredecessor!: (result: boolean) => void;
                process.mockImplementation(async (item) => {
                    calls.push(item.key);
                    if (item.key === predecessor.key) {
                        return await new Promise<boolean>((resolve) => {
                            releasePredecessor = resolve;
                        });
                    }
                    return true;
                });
                const flushing = manager.waitForIdle();
                void flushing.catch(() => {});
                await vi.waitFor(() => expect(releasePredecessor).toBeTypeOf("function"));
                const probe = fileEvent("CHANGED", "dispatched-probe.md");
                probe.key = "independent-probe";
                try {
                    await manager.processFileEvent(probe);
                    expect(calls).toEqual([predecessor.key, probe.key]);
                } finally {
                    releasePredecessor(true);
                    await flushing;
                }
                expect(calls).toEqual([predecessor.key, probe.key, destructive.key]);
                expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
            }
        );

        it("issue1331 replays the retained intent after a fresh manager is constructed", async () => {
            const temporaryPath = "note.md.tmp.1331.hash";
            const process = vi.mocked(dependencies.fileProcessing.processFileEvent);
            process.mockResolvedValue(false);
            manager.enqueue(fileEvent("CREATE", temporaryPath));
            await expect(manager.waitForIdle()).rejects.toThrow(`Storage operation failed: ${temporaryPath}`);

            process.mockClear();
            process.mockResolvedValue(true);
            const restarted = new TestStorageEventManager(adapter, dependencies);
            await restarted.restoreState();
            await expect(restarted.waitForIdle()).resolves.toBeUndefined();
            expect(process).toHaveBeenCalledWith(
                expect.objectContaining({
                    restoredFromPreviousRuntime: true,
                    args: expect.objectContaining({ file: expect.objectContaining({ path: temporaryPath }) }),
                })
            );
            expect(adapter.persistence.getStoredSnapshot()).toEqual([]);
        });
    });
});
