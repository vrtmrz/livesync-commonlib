import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type FileEventItem, type FilePath, type UXFileInfoStub, type UXFolderInfo } from "@lib/common/types";
import type { IAPIService, IVaultService } from "@lib/services/base/IService";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import {
    StorageEventManagerBase,
    type FileEventItemSentinel,
    type StorageEventManagerBaseDependencies,
} from "./StorageEventManager";
import type {
    IStorageEventConverterAdapter,
    IStorageEventManagerAdapter,
    IStorageEventPersistenceAdapter,
    IStorageEventStatusAdapter,
    IStorageEventTypeGuardAdapter,
    IStorageEventWatchAdapter,
} from "./adapters";

type SnapshotItem = FileEventItem | FileEventItemSentinel;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function pumpMicrotasks(rounds = 100): Promise<void> {
    for (let index = 0; index < rounds; index++) await Promise.resolve();
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 200; index++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${message}`);
}

class RecordingPersistence implements IStorageEventPersistenceAdapter {
    snapshot: SnapshotItem[] | null = null;
    writes: SnapshotItem[][] = [];
    successfulWrites: SnapshotItem[][] = [];
    activeWrites = 0;
    maximumConcurrentWrites = 0;
    failedWrites = 0;
    failNextWrite = false;
    private readonly writeGates = new Map<number, ReturnType<typeof deferred<void>>>();

    blockWrite(writeNumber: number): void {
        this.writeGates.set(writeNumber, deferred<void>());
    }

    releaseWrite(writeNumber: number): void {
        this.writeGates.get(writeNumber)?.resolve();
    }

    seed(snapshot: SnapshotItem[]): void {
        this.snapshot = [...snapshot];
    }

    async saveSnapshot(snapshot: SnapshotItem[]): Promise<void> {
        const copy = [...snapshot];
        const writeNumber = this.writes.length + 1;
        this.writes.push(copy);
        this.activeWrites++;
        this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.activeWrites);
        try {
            await this.writeGates.get(writeNumber)?.promise;
            if (this.failNextWrite) {
                this.failNextWrite = false;
                this.failedWrites++;
                throw new Error("snapshot save failed");
            }
            this.snapshot = copy;
            this.successfulWrites.push(copy);
        } finally {
            this.activeWrites--;
        }
    }

    async loadSnapshot(): Promise<SnapshotItem[] | null> {
        return this.snapshot ? [...this.snapshot] : null;
    }
}

class RecordingStatus implements IStorageEventStatusAdapter {
    batched = 0;
    processing = 0;
    totalQueued = 0;

    updateStatus(status: { batched: number; processing: number; totalQueued: number }): void {
        this.batched = status.batched;
        this.processing = status.processing;
        this.totalQueued = status.totalQueued;
    }
}

class TestAdapter implements IStorageEventManagerAdapter<UXFileInfoStub, UXFolderInfo> {
    readonly typeGuard: IStorageEventTypeGuardAdapter<UXFileInfoStub, UXFolderInfo> = {
        isFile: (value: unknown): value is UXFileInfoStub =>
            typeof value === "object" && value !== null && "stat" in value,
        isFolder: (_value: unknown): _value is UXFolderInfo => false,
    };
    readonly persistence = new RecordingPersistence();
    readonly status = new RecordingStatus();
    readonly watch: IStorageEventWatchAdapter<UXFileInfoStub, unknown> = {
        beginWatch: async () => {},
    };
    readonly converter: IStorageEventConverterAdapter<UXFileInfoStub> = {
        toFileInfo: (file) => file,
        toInternalFileInfo: (path) => ({
            name: path.split("/").pop() ?? path,
            path,
            isFolder: false,
            isInternal: true,
            stat: undefined,
        }),
    };
}

class TestStorageEventManager extends StorageEventManagerBase<TestAdapter> {
    constructor(adapter: TestAdapter, dependencies: StorageEventManagerBaseDependencies) {
        super(adapter, dependencies);
    }
}

function createHarness(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
    const settings = {
        ...DEFAULT_SETTINGS,
        isConfigured: true,
        suspendFileWatching: false,
        liveSync: false,
        batchSave: false,
        batchSaveMinimumDelay: 1,
        batchSaveMaximumDelay: 5,
        ...overrides,
    };
    const processFileEvent = vi.fn(async (_event: FileEventItem) => true);
    const dependencies = {
        setting: { currentSettings: () => settings },
        vaultService: {
            isFileSizeTooLarge: () => false,
            isTargetFile: async () => true,
        },
        fileProcessing: {
            onStorageFileEvent: vi.fn(),
            processFileEvent,
            processOptionalFileEvent: vi.fn(async () => true),
        },
        storageAccessManager: {
            isFileProcessing: () => false,
            recentlyTouched: () => false,
        },
        APIService: { addLog: vi.fn(), addOnLogEntry: vi.fn() },
    } as unknown as StorageEventManagerBaseDependencies & {
        setting: SettingService;
        vaultService: IVaultService;
        fileProcessing: FileProcessingService;
        storageAccessManager: IStorageAccessManager;
        APIService: IAPIService;
    };
    const adapter = new TestAdapter();
    const manager = new TestStorageEventManager(adapter, dependencies);
    return { adapter, dependencies, manager, processFileEvent, settings };
}

function file(path: string): UXFileInfoStub {
    return {
        name: path.split("/").pop() ?? path,
        path: path as FilePath,
        isFolder: false,
        stat: { ctime: 0, mtime: 100, size: 1, type: "file" },
    } as UXFileInfoStub;
}

function event(
    path: string,
    key: string,
    type: FileEventItem["type"] = "CHANGED",
    options: { skipBatchWait?: boolean; oldPath?: string } = {}
): FileEventItem {
    return {
        type,
        key,
        skipBatchWait: options.skipBatchWait ?? true,
        args: { file: file(path), ...(options.oldPath ? { oldPath: options.oldPath } : {}) },
    };
}

function keys(snapshot: SnapshotItem[] | null): string[] {
    return (snapshot ?? []).flatMap((item) => (item.type === "SENTINEL_FLUSH" ? [] : [item.key]));
}

describe("StorageEventManager local completion boundaries", () => {
    it.each([
        { liveSync: true, batchSave: true, batchSaveInLiveSync: false, waiting: false },
        { liveSync: true, batchSave: false, batchSaveInLiveSync: true, waiting: true },
        { liveSync: false, batchSave: true, batchSaveInLiveSync: false, waiting: true },
        { liveSync: false, batchSave: false, batchSaveInLiveSync: true, waiting: false },
    ])("uses the explicit batching choice for the current mode: %j", async ({ waiting, ...settings }) => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness(settings);
        try {
            manager.enqueue(event("mode.md", "mode", "CHANGED", { skipBatchWait: false }));
            await pumpMicrotasks();
            expect(adapter.status.batched).toBe(waiting ? 1 : 0);
            expect(processFileEvent).toHaveBeenCalledTimes(waiting ? 0 : 1);
            await manager.waitForIdle();
            expect(processFileEvent).toHaveBeenCalledOnce();
        } finally {
            await manager.waitForIdle();
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it("flushes its captured work without waiting for later same-path or unrelated edits", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness();
        const first = deferred<boolean>();
        const laterSamePath = deferred<boolean>();
        const laterUnrelated = deferred<boolean>();
        const gates = new Map([
            ["first", first],
            ["same-path-later", laterSamePath],
            ["unrelated-later", laterUnrelated],
        ]);
        const started = new Set<string>();
        const completed = new Set<string>();
        processFileEvent.mockImplementation(async (item) => {
            started.add(item.key);
            const result = await gates.get(item.key)!.promise;
            completed.add(item.key);
            return result;
        });
        const firstRun = manager.processFileEvent(event("same.md", "first"));
        let flushCompleted = false;
        const flush = manager.waitForIdle().then(() => {
            flushCompleted = true;
        });

        try {
            await waitUntil(() => started.has("first"), "the first handler to start");
            manager.enqueue(event("same.md", "same-path-later"));
            manager.enqueue(event("unrelated.md", "unrelated-later"));
            await waitUntil(() => started.has("unrelated-later"), "the unrelated later handler to start");
            expect(started.has("same-path-later")).toBe(false);

            first.resolve(true);
            await waitUntil(() => started.has("same-path-later"), "the later same-path handler to start");
            await pumpMicrotasks();

            expect(flushCompleted).toBe(true);
            expect(completed.has("same-path-later")).toBe(false);
            expect(completed.has("unrelated-later")).toBe(false);
        } finally {
            first.resolve(true);
            laterSamePath.resolve(true);
            laterUnrelated.resolve(true);
            await Promise.allSettled([firstRun, flush, manager.waitForIdle()]);
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
        expect(adapter.persistence.snapshot).toEqual([]);
    });

    it("keeps a newer same-path snapshot when an older operation completes", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness();
        const oldWrite = deferred<boolean>();
        const newWrite = deferred<boolean>();
        const started = new Set<string>();
        processFileEvent.mockImplementation(async (item) => {
            started.add(item.key);
            return await (item.key === "old" ? oldWrite.promise : newWrite.promise);
        });
        manager.enqueue(event("same.md", "old"));

        try {
            await waitUntil(() => started.has("old"), "the older handler to start");
            manager.enqueue(event("same.md", "new"));
            await waitUntil(() => keys(adapter.persistence.snapshot).includes("new"), "the newer snapshot to persist");
            oldWrite.resolve(true);
            await waitUntil(() => started.has("new"), "the newer handler to start");
            await waitUntil(
                () => keys(adapter.persistence.snapshot).includes("new") && !keys(adapter.persistence.snapshot).includes("old"),
                "the older completion to remove only its own snapshot"
            );

            expect(keys(adapter.persistence.snapshot)).toEqual(["new"]);
            newWrite.resolve(true);
            await manager.waitForIdle();
            expect(adapter.persistence.snapshot).toEqual([]);
        } finally {
            oldWrite.resolve(true);
            newWrite.resolve(true);
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it("serialises overlapping adapter writes and persists the newer admitted snapshot", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness();
        adapter.persistence.blockWrite(1);
        adapter.persistence.blockWrite(2);
        const firstWrite = deferred<boolean>();
        const secondWrite = deferred<boolean>();
        const started = new Set<string>();
        processFileEvent.mockImplementation(async (item) => {
            started.add(item.key);
            return await (item.key === "first" ? firstWrite.promise : secondWrite.promise);
        });
        manager.enqueue(event("first.md", "first"));

        try {
            await waitUntil(() => adapter.persistence.writes.length === 1, "the first adapter write to begin");
            manager.enqueue(event("second.md", "second"));
            await pumpMicrotasks();
            expect(adapter.persistence.writes).toHaveLength(1);

            adapter.persistence.releaseWrite(1);
            await waitUntil(() => adapter.persistence.writes.length === 2, "the second adapter write to begin");
            expect(keys(adapter.persistence.writes[1])).toEqual(["first", "second"]);
            adapter.persistence.releaseWrite(2);
            await waitUntil(
                () => started.has("first") && started.has("second"),
                "both file handlers to start"
            );

            expect(adapter.persistence.maximumConcurrentWrites).toBe(1);
            expect(keys(adapter.persistence.snapshot)).toEqual(["first", "second"]);
            firstWrite.resolve(true);
            secondWrite.resolve(true);
            await manager.waitForIdle();
            expect(adapter.persistence.snapshot).toEqual([]);
            expect(adapter.persistence.maximumConcurrentWrites).toBe(1);
        } finally {
            adapter.persistence.releaseWrite(1);
            adapter.persistence.releaseWrite(2);
            firstWrite.resolve(true);
            secondWrite.resolve(true);
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it.each(["false", "throw"] as const)(
        "retains a failed handler result and lets unrelated work finish when it returns %s",
        async (failureMode) => {
            vi.useFakeTimers();
            const { adapter, manager, processFileEvent } = createHarness();
            processFileEvent.mockImplementation(async (item) => {
                if (item.key === "failed") {
                    if (failureMode === "throw") throw new Error("handler threw");
                    return false;
                }
                return true;
            });
            manager.enqueue(event("failed.md", "failed"));
            manager.enqueue(event("independent.md", "independent"));

            try {
                await expect(manager.waitForIdle()).rejects.toThrow();
                expect(processFileEvent.mock.calls.map(([item]) => item.key)).toEqual(
                    expect.arrayContaining(["failed", "independent"])
                );
                expect(keys(adapter.persistence.snapshot)).toContain("failed");
                expect(keys(adapter.persistence.snapshot)).not.toContain("independent");
            } finally {
                await manager.waitForIdle().catch(() => {});
                await vi.runOnlyPendingTimersAsync();
                vi.useRealTimers();
            }
        }
    );

    it("keeps an event recoverable when completion snapshot persistence fails while another path proceeds", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness();
        const failedPathWrite = deferred<boolean>();
        const independentPathWrite = deferred<boolean>();
        const started = new Set<string>();
        processFileEvent.mockImplementation(async (item) => {
            started.add(item.key);
            return await (item.key === "failed-path" ? failedPathWrite.promise : independentPathWrite.promise);
        });
        manager.enqueue(event("failed-path.md", "failed-path"));
        manager.enqueue(event("independent.md", "independent-path"));

        try {
            await waitUntil(
                () => started.has("failed-path") && started.has("independent-path"),
                "both handlers to start"
            );
            let flushCompleted = false;
            const flush = manager.waitForIdle().finally(() => { flushCompleted = true; });
            adapter.persistence.failNextWrite = true;
            failedPathWrite.resolve(true);
            await waitUntil(() => adapter.persistence.failedWrites === 1, "the completion snapshot write to fail");
            expect(flushCompleted).toBe(false);
            independentPathWrite.resolve(true);
            await expect(flush).rejects.toThrow("snapshot save failed");

            expect(keys(adapter.persistence.snapshot)).toContain("failed-path");
            expect(keys(adapter.persistence.snapshot)).not.toContain("independent-path");
        } finally {
            failedPathWrite.resolve(true);
            independentPathWrite.resolve(true);
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it.each(["DELETE", "RENAME"] as const)(
        "%s waits for its predecessor but not for itself or later same-path work",
        async (barrierType) => {
            vi.useFakeTimers();
            const { manager, processFileEvent } = createHarness();
            const predecessor = deferred<boolean>();
            const barrier = deferred<boolean>();
            const laterSamePath = deferred<boolean>();
            const independent = deferred<boolean>();
            const gates = new Map([
                ["predecessor", predecessor],
                ["barrier", barrier],
                ["later", laterSamePath],
                ["independent", independent],
            ]);
            const started = new Set<string>();
            processFileEvent.mockImplementation(async (item) => {
                started.add(item.key);
                return await gates.get(item.key)!.promise;
            });
            manager.enqueue(event("source.md", "predecessor"));

            try {
                await waitUntil(() => started.has("predecessor"), "the predecessor handler to start");
                const barrierEvent = barrierType === "DELETE"
                    ? event("source.md", "barrier", "DELETE")
                    : event("destination.md", "barrier", "RENAME", { oldPath: "source.md" });
                manager.enqueue(barrierEvent);
                manager.enqueue(event("source.md", "later"));
                manager.enqueue(event("unrelated.md", "independent"));
                await pumpMicrotasks();
                expect(started.size).toBe(1);

                predecessor.resolve(true);
                await waitUntil(
                    () => started.has("barrier") && started.has("independent"),
                    "the barrier and unrelated handlers to start after the predecessor"
                );
                expect(started.has("later")).toBe(false);

                barrier.resolve(true);
                await waitUntil(() => started.has("later"), "later same-path work to follow the barrier");
                laterSamePath.resolve(true);
                independent.resolve(true);
                await manager.waitForIdle();
            } finally {
                predecessor.resolve(true);
                barrier.resolve(true);
                laterSamePath.resolve(true);
                independent.resolve(true);
                await manager.waitForIdle().catch(() => {});
                await vi.runOnlyPendingTimersAsync();
                vi.useRealTimers();
            }
        }
    );

    it("replays independent snapshot work while retaining a failed path and its dependent rename", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness();
        const failed = event("source.md", "failed-source");
        const sentinel: FileEventItemSentinel = { type: "SENTINEL_FLUSH" };
        const rename = event("destination.md", "dependent-rename", "RENAME", { oldPath: "source.md" });
        const independent = event("independent.md", "independent");
        adapter.persistence.seed([failed, sentinel, rename, independent]);
        processFileEvent.mockImplementation(async (item) => item.key !== "failed-source");

        try {
            await expect(manager.restoreState()).resolves.toBeUndefined();
            expect(processFileEvent.mock.calls.map(([item]) => item.key)).toEqual(
                expect.arrayContaining(["failed-source", "independent"])
            );
            expect(processFileEvent.mock.calls.map(([item]) => item.key)).not.toContain("dependent-rename");
            expect(adapter.persistence.snapshot?.map((item) => item.type)).toEqual([
                "CHANGED",
                "SENTINEL_FLUSH",
                "RENAME",
            ]);
            expect(keys(adapter.persistence.snapshot)).toEqual(["failed-source", "dependent-rename"]);
        } finally {
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it("processes ready work while more than five paths are waiting for batch timers", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent, settings } = createHarness({
            batchSave: true,
            batchSaveMinimumDelay: 60,
            batchSaveMaximumDelay: 120,
        });
        const waiting = Array.from({ length: 6 }, (_, index) => event(`waiting-${index}.md`, `waiting-${index}`, "CHANGED", { skipBatchWait: false }));

        try {
            for (const item of waiting) manager.enqueue(item);
            await waitUntil(() => adapter.status.batched === 6, "six paths to enter the batch wait");
            expect(processFileEvent).not.toHaveBeenCalled();

            manager.enqueue(event("ready.md", "ready", "CHANGED", { skipBatchWait: true }));
            await waitUntil(() => processFileEvent.mock.calls.some(([item]) => item.key === "ready"), "ready work to start");
            expect(adapter.status.batched).toBe(6);

            await manager.waitForIdle();
            expect(processFileEvent).toHaveBeenCalledTimes(7);
        } finally {
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it("counts admission delay towards the maximum batch delay", async () => {
        vi.useFakeTimers();
        const { dependencies, manager, processFileEvent } = createHarness({
            batchSave: true,
            batchSaveMinimumDelay: 1,
            batchSaveMaximumDelay: 2,
        });
        const selected = deferred<boolean>();
        dependencies.vaultService.isTargetFile = () => selected.promise;
        const admission = manager.appendQueue([{ type: "CHANGED", file: file("delayed.md") }]);
        try {
            await vi.advanceTimersByTimeAsync(2_500);
            selected.resolve(true);
            await pumpMicrotasks();
            await vi.advanceTimersByTimeAsync(11);
            await admission;
            await pumpMicrotasks();
            expect(processFileEvent).toHaveBeenCalledOnce();
        } finally {
            selected.resolve(true);
            await vi.advanceTimersByTimeAsync(20);
            await manager.waitForIdle();
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });

    it("anchors maximum delay to the first accepted edit while later edits reset the quiet period", async () => {
        vi.useFakeTimers();
        const { adapter, manager, processFileEvent } = createHarness({
            batchSave: true,
            batchSaveMinimumDelay: 1,
            batchSaveMaximumDelay: 2,
        });

        try {
            manager.enqueue(event("edited.md", "first-edit", "CHANGED", { skipBatchWait: false }));
            await waitUntil(() => adapter.status.batched === 1, "the first edit to enter the batch wait");
            await vi.advanceTimersByTimeAsync(800);
            manager.enqueue(event("edited.md", "second-edit", "CHANGED", { skipBatchWait: false }));
            await pumpMicrotasks();
            await vi.advanceTimersByTimeAsync(800);
            manager.enqueue(event("edited.md", "third-edit", "CHANGED", { skipBatchWait: false }));
            await pumpMicrotasks();

            await vi.advanceTimersByTimeAsync(399);
            expect(processFileEvent).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await waitUntil(() => processFileEvent.mock.calls.length === 1, "the max-delay deadline to release the edit");
            expect(processFileEvent.mock.calls[0]?.[0].key).toBe("third-edit");
            await manager.waitForIdle();
        } finally {
            await manager.waitForIdle().catch(() => {});
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
    });
});
