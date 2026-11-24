import { afterEach, describe, expect, it, vi } from "vitest";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { performFullScan } from "@lib/serviceFeatures/offlineScanner";
import { ServiceFileAccessBase, type StorageAccessBaseDependencies } from "@lib/serviceModules/ServiceFileAccessBase";
import { ControlService, type ControlServiceDependencies } from "@lib/services/base/ControlService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import type { OptionalFileEventOptions } from "@lib/services/base/IService";
import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import { DEFAULT_SETTINGS, type FileEventItem, type FilePath, type UXFileInfoStub } from "@lib/common/types";
import { StorageEventManagerBase, type StorageEventManagerBaseDependencies } from "./StorageEventManager";
import type {
    IStorageEventManagerAdapter,
    IStorageEventIncrementalPersistenceAdapter,
    IStorageEventPersistenceAdapter,
    StorageEventSnapshotDelta,
    StorageEventSnapshotRecord,
} from "./adapters";
import { createFileEventAttempt, stopFileEventAttempt } from "./StorageEventManager/operations";
import { processStorageEventAttempt } from "./StorageEventManager/processing";
import { sanitiseEventForPersistence } from "./StorageEventManager/snapshot";
import {
    TYPE_SENTINEL_FLUSH,
    isManagerStopped,
    isStoreAcquired,
    isStoreRestoring,
    type QueuedFileEvent,
} from "./StorageEventManager/state";

const modes = ["full snapshot", "incremental"] as const;
type Mode = (typeof modes)[number];

function event(key: string, path = `${key}.md`): FileEventItem {
    return {
        type: "CHANGED",
        key,
        args: {
            file: {
                path: path as FilePath,
                name: path,
                isFolder: false,
                stat: { ctime: 1, mtime: 2, size: 3, type: "file" },
            },
        },
        skipBatchWait: true,
    };
}

function sentinel() {
    return { type: TYPE_SENTINEL_FLUSH } as const;
}

function keys(events: readonly QueuedFileEvent[]) {
    return events.map((item) => (item.type === TYPE_SENTINEL_FLUSH ? item.type : item.key));
}

function store(mode: Mode, initial: readonly QueuedFileEvent[] = []) {
    let events = [...initial];
    const records = new Map(initial.map((item, i) => [String(i + 1).padStart(12, "0"), item]));
    const commit = vi.fn(async () => {});
    const saveSnapshot = vi.fn(async (next: QueuedFileEvent[]) => {
        await commit();
        events = next;
    });
    const loadSnapshot = vi.fn(async () => events);
    const orderedRecords = () =>
        [...records].sort(([a], [b]) => a.localeCompare(b)).map(([id, event]) => ({ id, event }));
    const loadSnapshotEntries = vi.fn(async () => orderedRecords());
    const applySnapshotDelta = vi.fn(async ({ upsert, remove }: StorageEventSnapshotDelta) => {
        await commit();
        for (const record of upsert) records.set(record.id, record.event);
        for (const id of remove) records.delete(id);
    });
    const legacy = { saveSnapshot, loadSnapshot };
    return {
        adapter: mode === "incremental" ? { ...legacy, loadSnapshotEntries, applySnapshotDelta } : legacy,
        saveSnapshot,
        loadSnapshot,
        loadSnapshotEntries,
        applySnapshotDelta,
        commit,
        orderedRecords,
        contents: () => (mode === "incremental" ? orderedRecords().map((record) => record.event) : events),
    };
}

type Store = ReturnType<typeof store>;
type HostAdapter = IStorageEventManagerAdapter<UXFileInfoStub, never>;

class AcceptanceStorageEventManager extends StorageEventManagerBase<HostAdapter> {}

function runtime(persistence: IStorageEventPersistenceAdapter, window = 5, Manager = AcceptanceStorageEventManager) {
    const settings = {
        ...DEFAULT_SETTINGS,
        isConfigured: true,
        batchSave: false,
        batchSaveMinimumDelay: 2,
        batchSaveMaximumDelay: 5,
    };
    const process = vi.fn(async (_item: FileEventItem) => true);
    const optional = vi.fn(async (_path: FilePath) => true);
    const watcher = vi.fn(async () => {});
    const status = vi.fn();
    const log = vi.fn();
    const adapter: HostAdapter = {
        persistence,
        typeGuard: {
            isFile: (file): file is UXFileInfoStub => typeof file === "object" && file !== null && "stat" in file,
            isFolder: (_item): _item is never => false,
        },
        watch: { beginWatch: watcher },
        status: { updateStatus: status },
        converter: {
            toFileInfo: (file) => file,
            toInternalFileInfo: (path) => ({ path, name: path, isFolder: false, isInternal: true, stat: undefined }),
        },
    };
    const dependencies = {
        setting: { currentSettings: () => settings },
        fileProcessing: { processFileEvent: process, processOptionalFileEvent: optional, onStorageFileEvent: vi.fn() },
        vaultService: { isTargetFile: async () => true, isFileSizeTooLarge: () => false },
        storageAccessManager: { isFileProcessing: () => false, recentlyTouched: () => false },
        APIService: { addLog: log },
    } as unknown as StorageEventManagerBaseDependencies;
    const manager = new Manager(adapter, dependencies);
    manager["dispatchWindowSize"] = window;
    return { manager, settings, process, optional, watcher, status, log, state: manager["eventState"] };
}

function blockCommit(storage: Store) {
    const entered = promiseWithResolvers<void>();
    const proceed = promiseWithResolvers<void>();
    storage.commit.mockImplementationOnce(() => {
        entered.resolve();
        return proceed.promise;
    });
    return {
        entered: entered.promise,
        resolve: () => proceed.resolve(),
        reject: (error: Error) => proceed.reject(error),
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("Astra review regressions", () => {
    it("preserves an unread full snapshot after restore rejects and fences all writers", async () => {
        const unread = event("unread");
        const storage = store("full snapshot", [unread]);
        const { manager, state } = runtime(storage.adapter);
        const read = promiseWithResolvers<QueuedFileEvent[]>();
        storage.loadSnapshot.mockReturnValueOnce(read.promise);
        const restore = manager.restoreState();
        const live = event("live");
        manager.enqueue(live);
        const failure = new Error("could not read snapshot");
        const restoreResult = expect(restore).rejects.toBe(failure);
        const admissionResult = expect(state.operations.get(live)!.attempt.admissionPersistence).rejects.toBe(failure);
        read.reject(failure);
        await Promise.all([restoreResult, admissionResult]);
        const late = event("late");
        manager.enqueue(late);
        expect(await state.operations.get(late)!.attempt.completion.promise).toMatchObject({ ok: false });
        await expect(manager._takeSnapshot()).rejects.toThrow();
        await expect(manager.stopWatching()).rejects.toBe(failure);
        expect(storage.saveSnapshot).not.toHaveBeenCalled();
        expect(storage.contents()).toEqual([unread]);
    }, 1500);

    it("persists earlier buffered admissions into a replacement store before starting their handler", async () => {
        const first = store("incremental");
        const replacement = store("incremental");
        let selected = first;
        const adapter = {
            ...first.adapter,
            loadSnapshotEntries: () => selected.loadSnapshotEntries(),
            applySnapshotDelta: (delta: StorageEventSnapshotDelta) => selected.applySnapshotDelta(delta),
        };
        const { manager, process, state } = runtime(adapter);
        await manager.pauseDispatch();
        const item = event("previously-durable");
        manager.enqueue(item);
        await state.operations.get(item)!.attempt.admissionPersistence;
        expect(keys(first.contents())).toEqual([item.key]);
        selected = replacement;
        manager.resetPersistenceState();
        await manager.restoreState();
        const admission = blockCommit(replacement);
        process.mockImplementationOnce(async () => {
            expect(keys(replacement.contents())).toEqual([item.key]);
            return true;
        });
        manager.resumeDispatch();
        const idle = manager.waitForIdle();
        void idle.catch(() => {});
        await admission.entered;
        try {
            expect(process).not.toHaveBeenCalled();
        } finally {
            admission.resolve();
        }
        await idle;
        expect(process).toHaveBeenCalledOnce();
        expect(replacement.contents()).toEqual([]);
    });

    it("rejects a duplicate record load atomically and can replay a corrected load", async () => {
        const storage = store("incremental", [event("good"), event("also-good")]);
        const [first, second] = storage.orderedRecords();
        storage.loadSnapshotEntries.mockResolvedValueOnce([first, { ...second, id: first.id }]);
        const { manager, state, process } = runtime(storage.adapter);
        await expect(manager.restoreState()).rejects.toThrow("Duplicate storage event record id");
        expect(state.pendingSnapshot.size).toBe(0);
        expect(state.pendingPathCounts.size).toBe(0);
        expect(state.persistence.activeRecordIds.size).toBe(0);
        expect(state.persistence.committedEntryIds.size).toBe(0);
        expect(state.latestByPath.size).toBe(0);
        expect(state.persistence.dirtyUpserts.size).toBe(0);
        expect(manager["buffer"].read()).toEqual([]);
        await manager.restoreState();
        await manager.stopWatching();
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["good", "also-good"]);
        expect(storage.contents()).toEqual([]);
        expect(storage.applySnapshotDelta.mock.calls.flatMap(([delta]) => delta.upsert)).toEqual([]);
    });

    it("establishes fresh-store ownership on the first scan and reuses it on the next", async () => {
        const storage = store("incremental");
        const { manager, settings, process, state } = runtime(storage.adapter);
        const { storageAccess } = unloadRuntime(manager);
        let initialised = false;
        const host = {
            services: {
                setting: { currentSettings: () => settings },
                keyValueDB: {
                    kvDB: {
                        get: async () => initialised,
                        set: async () => {
                            initialised = true;
                        },
                    },
                },
                database: {
                    localDatabase: {
                        findAllDocs: (): never[] => [],
                        findAllNormalDocs: (): never[] => [],
                        isReady: true,
                    },
                },
            },
            serviceModules: { fileHandler: {}, storageAccess },
        } as unknown as Parameters<typeof performFullScan>[0];
        vi.spyOn(storageAccess, "getFiles").mockResolvedValue([]);
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];
        await expect(performFullScan(host, vi.fn(), errors)).resolves.toBe(true);
        await manager.pauseDispatch();
        const live = event("live");
        manager.enqueue(live);
        await state.operations.get(live)!.attempt.admissionPersistence;
        await expect(performFullScan(host, vi.fn(), errors)).resolves.toBe(true);
        expect(storage.loadSnapshotEntries).toHaveBeenCalledOnce();
        await manager.stopWatching();
        expect(process).not.toHaveBeenCalled();
        expect(keys(storage.contents())).toEqual(["live"]);
        expect(storage.applySnapshotDelta).toHaveBeenCalledOnce();
    });

    it("recognises an already-committed incremental record if a host calls restore directly", async () => {
        const storage = store("incremental");
        const { manager, state, process } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const item = event("already-durable");
        manager.enqueue(item);
        await state.operations.get(item)!.attempt.admissionPersistence;
        await manager.restoreState();
        expect(storage.loadSnapshotEntries).toHaveBeenCalledOnce();
        expect(state.pendingSnapshot.size).toBe(1);
        await manager.stopWatching();
        expect(process).not.toHaveBeenCalled();
        expect(keys(storage.contents())).toEqual([item.key]);
        expect(storage.applySnapshotDelta).toHaveBeenCalledOnce();
    });

    it("releases a reserved slot through a one-argument host override", async () => {
        class HostOverride extends AcceptanceStorageEventManager {
            override async processFileEvent(item: FileEventItem) {
                await super.processFileEvent(item);
            }
        }
        const storage = store("incremental", [event("first"), event("second")]);
        const { manager, process } = runtime(storage.adapter, 1, HostOverride);
        await manager.restoreState();
        await manager.stopWatching();
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["first", "second"]);
        expect(storage.contents()).toEqual([]);
    }, 1500);

    it("signals a started optional provider before waiting for its durable acknowledgement on stop", async () => {
        const storage = store("incremental");
        const { manager } = runtime(storage.adapter);
        const started = promiseWithResolvers<void>();
        const flushed = vi.fn();
        const provider = vi.fn(async (_path: FilePath, options?: OptionalFileEventOptions) => {
            started.resolve();
            await options?.whenFlushRequested;
            flushed();
            return { kind: "completed" as const, value: undefined };
        });
        Object.defineProperty(manager["fileProcessing"], "processOptionalFileEventWithResult", { value: provider });
        const item = { ...event("optional"), type: "INTERNAL" } as const;
        manager.enqueue(item);
        await started.promise;
        await manager.stopWatching();
        expect(flushed).toHaveBeenCalledOnce();
        expect(storage.contents()).toEqual([]);
    }, 1500);

    it.each(modes)("captures durable payload and indexed paths before a held %s write", async (mode) => {
        const storage = store(mode);
        const { manager, process } = runtime(storage.adapter);
        const live = event("live", "original.md");
        const ctx = { nested: { value: "original" } };
        live.args.ctx = ctx;
        const admission = blockCommit(storage);
        const processing = manager.processFileEvent(live);
        await admission.entered;
        live.args.file.path = "updated.md" as FilePath;
        ctx.nested.value = "updated";
        expect(manager.hasPendingFileEvent("original.md" as FilePath)).toBe(true);
        expect(manager.hasPendingFileEvent("updated.md" as FilePath)).toBe(false);
        admission.resolve();
        await processing;
        const written =
            mode === "incremental"
                ? storage.applySnapshotDelta.mock.calls[0][0].upsert[0].event
                : storage.saveSnapshot.mock.calls[0][0][0];
        expect(written).toMatchObject({
            args: { file: { path: "original.md" }, ctx: { nested: { value: "original" } } },
        });
        expect(process.mock.calls[0][0]).toBe(live);
        expect(manager.hasPendingFileEvent("original.md" as FilePath)).toBe(false);
    });

    it("rejects admission and completion waiters if detached batch planning throws", async () => {
        const storage = store("incremental");
        const { manager, state } = runtime(storage.adapter);
        const item = event("throwing projection");
        const entry = manager["retainEvent"](item);
        const failure = new Error("projection failed");
        Object.defineProperty(entry, "event", {
            get: () => {
                throw failure;
            },
            configurable: true,
        });
        const pending = Promise.allSettled([
            manager._takeSnapshot(entry.mutationVersion),
            manager["persistSnapshot"]({ entry, attempt: entry.operation!.attempt }),
        ]);
        await state.persistence.tail;
        const unsettled = Symbol("unsettled");
        expect(await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve(unsettled)))])).toEqual(
            [
                { status: "rejected", reason: failure },
                { status: "rejected", reason: failure },
            ]
        );
        expect(storage.commit).not.toHaveBeenCalled();
        expect(state.persistence.writerRunning).toBe(false);
        expect(state.pendingSnapshot.get(item)).toBe(entry);
        Object.defineProperty(entry, "event", { value: item });
        await expect(manager.processFileEvent(item)).resolves.toBeUndefined();
        expect(storage.contents()).toEqual([]);
    });

    it.each([1, 5])(
        "keeps same-path replay bounded at window %i and lets unrelated paths proceed when capacity exists",
        async (window) => {
            const samePath = Array.from({ length: 150 }, (_, i) => event(`A${i}`, "same.md"));
            const other = event("other");
            const storage = store("incremental", [...samePath, other]);
            const { manager, process } = runtime(storage.adapter, window);
            const handler = promiseWithResolvers<boolean>();
            const started = promiseWithResolvers<void>();
            const unrelated = promiseWithResolvers<void>();
            process.mockImplementation(async (item) => {
                if (item.key === samePath[0].key) {
                    started.resolve();
                    return handler.promise;
                }
                if (item.key === other.key) unrelated.resolve();
                return true;
            });
            const calls = vi.spyOn(manager, "processFileEvent");
            const restore = manager.restoreState();
            try {
                await started.promise;
                if (window > 1) await unrelated.promise;
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(calls.mock.calls.length).toBeLessThanOrEqual(window);
            } finally {
                handler.resolve(true);
                await restore;
            }
            expect(keys(process.mock.calls.map(([item]) => item).filter((item) => item.key !== other.key))).toEqual(
                keys(samePath)
            );
            expect(process).toHaveBeenCalledTimes(151);
        }
    );

    it("settles replay while later admissions are blocked behind their own held handler", async () => {
        const storage = store("incremental", [event("A"), event("A2")]);
        const { manager, process } = runtime(storage.adapter, 1);
        const aStarted = promiseWithResolvers<void>();
        const a = promiseWithResolvers<boolean>();
        const bStarted = promiseWithResolvers<void>();
        const b = promiseWithResolvers<boolean>();
        process.mockImplementation(async (item) => {
            if (item.key === "A") {
                aStarted.resolve();
                return a.promise;
            }
            if (item.key === "B") {
                bStarted.resolve();
                return b.promise;
            }
            return true;
        });
        const restore = manager.restoreState();
        await aStarted.promise;
        manager.enqueue(event("B"));
        manager.enqueue(event("C"));
        a.resolve(true);
        await bStarted.promise;
        try {
            expect(
                await Promise.race([restore.then(() => "restored"), new Promise((resolve) => setImmediate(resolve))])
            ).toBe("restored");
            expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["A", "A2", "B"]);
        } finally {
            b.resolve(true);
            await restore;
            await manager.waitForIdle();
        }
    });

    it("joins acknowledgement of a captured trailing sentinel during replay", async () => {
        const storage = store("incremental", [event("first"), sentinel()]);
        const { manager, process } = runtime(storage.adapter);
        const started = promiseWithResolvers<void>();
        const handler = promiseWithResolvers<boolean>();
        process.mockImplementationOnce(() => {
            started.resolve();
            return handler.promise;
        });
        const restoring = manager.restoreState();
        await started.promise;
        const acknowledgement = blockCommit(storage);
        handler.resolve(true);
        await acknowledgement.entered;
        const restored = vi.fn();
        void restoring.then(restored);
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(restored).not.toHaveBeenCalled();
        } finally {
            acknowledgement.resolve();
        }
        await restoring;
        expect(storage.contents()).toEqual([]);
    });

    it("treats restored adapter IDs as opaque and skips local ID collisions", async () => {
        const storage = store("incremental");
        storage.loadSnapshotEntries.mockResolvedValueOnce([
            { id: "9007199254740993", event: event("opaque") },
            { id: "000000000001", event: event("collision") },
        ]);
        const { manager } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const restore = manager.restoreState();
        await vi.waitFor(() => expect(isStoreRestoring(manager["eventState"])).toBe(false));
        manager.enqueue(event("live"));
        await vi.waitFor(() => expect(storage.orderedRecords()).toHaveLength(1));
        expect(storage.orderedRecords()[0].id).toBe("000000000002");
        await manager.stopWatching();
        await restore;
    });

    it("reports a status failure after acknowledgement without rejecting committed work", async () => {
        const storage = store("incremental");
        const { manager, status, log, state } = runtime(storage.adapter);
        const failure = new Error("status failed after commit");
        const item = event("completed");
        storage.commit
            .mockImplementationOnce(async () => {})
            .mockImplementationOnce(async () => {
                status.mockImplementationOnce(() => {
                    throw failure;
                });
            });

        await expect(manager.processFileEvent(item)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(failure, expect.anything(), expect.anything());
        expect(state.pendingSnapshot.size).toBe(0);
        expect(storage.contents()).toEqual([]);
    });

    it("ignores direct processing calls after stop without retaining phantom work", async () => {
        const storage = store("incremental");
        const { manager, process } = runtime(storage.adapter);
        await manager.stopWatching();
        const item = event("after-stop");
        await manager.processFileEvent(item);
        expect(manager.hasPendingFileEvent(item.args.file.path as FilePath)).toBe(false);
        expect(process).not.toHaveBeenCalled();
        expect(storage.commit).not.toHaveBeenCalled();
    });

    it("uses only the editor path even when inspecting data would throw", async () => {
        const { manager, settings } = runtime(store("incremental").adapter);
        settings.batchSave = true;
        const waiting = { ...event("waiting"), skipBatchWait: false };
        manager.enqueue(waiting);
        await vi.waitFor(() => expect(manager.isWaiting(waiting.args.file.path as FilePath)).toBe(true));
        const data = vi.fn(() => {
            throw new Error("editor data accessed");
        });
        const info = Object.defineProperty({ path: waiting.args.file.path, file: waiting.args.file }, "data", {
            get: data,
        });
        try {
            manager["watchEditorChange"]({}, info);
            expect(data).not.toHaveBeenCalled();
        } finally {
            await manager.stopWatching();
        }
    });
});

describe("Step 1 review regressions", () => {
    it.each([1, 5])("holds window %i through ready dispatch and acknowledgement", async (window) => {
        const items = Array.from({ length: window + 2 }, (_, i) => event(`ready-${i}`));
        const storage = store("incremental", items);
        const { manager, state, process } = runtime(storage.adapter, window);
        const started = promiseWithResolvers<void>();
        const handler = promiseWithResolvers<boolean>();
        process.mockImplementation(async () => {
            if (process.mock.calls.length === window) started.resolve();
            return handler.promise;
        });
        const restore = manager.restoreState();
        await started.promise;
        expect(state.dispatch.activeSlots).toBe(window);
        expect(state.dispatch.inFlightOperations.size).toBe(window);
        expect(process).toHaveBeenCalledTimes(window);
        expect(storage.commit).not.toHaveBeenCalled();
        const ack = blockCommit(storage);
        handler.resolve(true);
        await ack.entered;
        expect(process).toHaveBeenCalledTimes(window);
        ack.resolve();
        await restore;
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(keys(items));
    });

    it.each(["initial", "retry"] as const)("tracks a %s attempt through acknowledgement during stop", async (phase) => {
        const storage = store("incremental");
        const { manager, process, state } = runtime(storage.adapter);
        const intent = event("ack");
        if (phase === "retry") {
            process.mockResolvedValueOnce(false);
            await expect(manager.processFileEvent(intent)).rejects.toThrow("Storage operation failed");
        }

        const handler = promiseWithResolvers<boolean>();
        const started = promiseWithResolvers<void>();
        process.mockImplementationOnce(() => {
            started.resolve();
            return handler.promise;
        });
        const work = phase === "retry" ? manager.waitForIdle() : manager.processFileEvent(intent);
        await started.promise;
        expect(state.dispatch.inFlightOperations.size).toBe(1);
        const ack = blockCommit(storage);
        handler.resolve(true);
        await ack.entered;
        expect(state.dispatch.inFlightOperations.size).toBe(1);
        const stopped = vi.fn();
        const retiring = manager.stopWatching().then(stopped);
        expect(keys(storage.contents())).toEqual(["ack"]);
        expect(stopped).not.toHaveBeenCalled();
        ack.resolve();
        await Promise.all([work, retiring]);
        expect(state.dispatch.inFlightOperations.size).toBe(0);
        expect(storage.contents()).toEqual([]);
        const writes = storage.commit.mock.calls.length;
        const replacement = runtime(storage.adapter);
        await replacement.manager.restoreState();
        expect(replacement.process).not.toHaveBeenCalled();
        expect(storage.commit).toHaveBeenCalledTimes(writes);
    });

    it.each(["stopped gate", "stopped successor", "stopped prerequisite", "stop at semaphore"])(
        "preserves intent after a %s",
        async (phase) => {
            const storage = store("incremental");
            const { manager, process } = runtime(storage.adapter);
            const item = event("retained");
            const operation = manager["retainEvent"](item).operation!;
            const attempts = manager["attempts"];
            const semaphore = attempts.semaphore();
            if (phase === "stopped gate") {
                vi.spyOn(attempts, "initialise").mockResolvedValueOnce("stopped");
            } else if (phase === "stopped successor") {
                vi.spyOn(attempts, "initialise").mockResolvedValueOnce(false);
                operation.attempt.successor = createFileEventAttempt();
                stopFileEventAttempt(operation.attempt.successor);
            } else if (phase === "stopped prerequisite") {
                const predecessor = manager["retainEvent"](event("predecessor")).operation!;
                stopFileEventAttempt(predecessor.attempt);
                operation.prerequisites.add(predecessor);
            } else {
                vi.spyOn(attempts, "semaphore").mockImplementationOnce(() => {
                    vi.spyOn(attempts, "isStopping").mockReturnValue(true);
                    return semaphore;
                });
            }
            await processStorageEventAttempt(manager["eventState"], operation, operation.attempt, attempts);
            expect(process).not.toHaveBeenCalled();
            expect(operation.attempt.result).toEqual({ ok: false, stopped: true });
            expect(storage.contents()).toContainEqual(sanitiseEventForPersistence(item));
        }
    );

    it("does not ask for acknowledgement after a stopped sentinel predecessor", async () => {
        const storage = store("incremental");
        const { manager, state } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const before = event("before");
        const deletion = { ...event("delete"), type: "DELETE" } as const;
        manager.enqueue(before);
        manager.enqueue(deletion);
        await state.operations.get(deletion)!.attempt.admissionPersistence;
        const predecessor = state.operations.get(before)!.attempt;
        stopFileEventAttempt(predecessor);
        const snapshot = vi.spyOn(manager, "_takeSnapshot");
        manager.resumeDispatch();
        await manager["runQueuedEvents"]();
        expect(snapshot).not.toHaveBeenCalled();
        expect(keys(storage.contents())).toContain(TYPE_SENTINEL_FLUSH);
        await manager.stopWatching();
    });

    it("never upserts a persisted sentinel again when it is dispatched", async () => {
        const initial = [event("before"), sentinel(), { ...event("delete"), type: "DELETE" } as const];
        const storage = store("incremental", initial);
        const { manager, process } = runtime(storage.adapter, 1);
        process.mockResolvedValueOnce(false);
        await manager.restoreState();
        expect(storage.applySnapshotDelta.mock.calls.flatMap(([delta]) => delta.upsert)).toEqual([]);
        expect(keys(storage.contents())).toEqual(["before", TYPE_SENTINEL_FLUSH]);
    });

    it("does not start the dispatcher until the admission commits", async () => {
        const storage = store("incremental");
        const { manager, process } = runtime(storage.adapter);
        const run = vi.spyOn(manager as unknown as { runQueuedEvents(): Promise<void> }, "runQueuedEvents");
        const admission = blockCommit(storage);
        const item = event("admission");
        manager.enqueue(item);
        await admission.entered;
        expect(run).not.toHaveBeenCalled();
        expect(process).not.toHaveBeenCalled();
        admission.resolve();
        await manager.waitForIdle();
        expect(process).toHaveBeenCalledExactlyOnceWith(item);
    });

    it("does not capture retries or run dispatch when flushing a stopping manager", async () => {
        const storage = store("incremental");
        const { manager, process, state } = runtime(storage.adapter);
        const item = event("failed");
        process.mockResolvedValueOnce(false);
        await expect(manager.processFileEvent(item)).rejects.toThrow("Storage operation failed");
        const attempt = state.operations.get(item)!.attempt;
        const run = vi.spyOn(manager as unknown as { runQueuedEvents(): Promise<void> }, "runQueuedEvents");
        manager.beginStopWatching();
        await expect(manager.waitForIdle()).resolves.toBeUndefined();
        expect(state.operations.get(item)!.attempt).toBe(attempt);
        expect(run).not.toHaveBeenCalled();
        expect(process).toHaveBeenCalledOnce();
        await manager.stopWatching();
        await expect(manager.waitForIdle()).resolves.toBeUndefined();
    });

    it("puts restored sentinels before live admissions that arrive during snapshot load", async () => {
        const storage = store("full snapshot");
        const { manager, state } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const read = promiseWithResolvers<QueuedFileEvent[]>();
        storage.loadSnapshot.mockReturnValueOnce(read.promise);
        const restore = manager.restoreState();
        const live = { ...event("live"), type: "DELETE" } as const;
        manager.enqueue(live);
        read.resolve([event("restored"), sentinel(), { ...event("restored-delete"), type: "DELETE" }]);
        await vi.waitFor(() => expect(isStoreRestoring(state)).toBe(false));
        const entries = [...state.pendingSnapshot.values()];
        expect(keys(entries.map((entry) => entry.event))).toEqual([
            "restored",
            TYPE_SENTINEL_FLUSH,
            "restored-delete",
            TYPE_SENTINEL_FLUSH,
            "live",
        ]);
        expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
        expect(state.operations.get(live)?.barrierBefore).toBe(entries[3]?.sequence);
        await manager.stopWatching();
        await restore;
    });
});

describe.each(modes)("detached writes with a %s adapter", (mode) => {
    it("isolates waiters and preserves exact pending intent through a failed commit", async () => {
        const storage = store(mode);
        const { manager, process, state } = runtime(storage.adapter);
        const a = event("A");
        const c = event("C");
        const stale = event("stale");
        const rejected = event("rejected");
        const initial = [a, c, stale, rejected];
        const [aEntry, cEntry, staleEntry, rejectedEntry] = initial.map((item) => manager["retainEvent"](item));
        await manager._takeSnapshot();
        expect(storage.contents()).toEqual(initial.map(sanitiseEventForPersistence));

        const txA = blockCommit(storage);
        const failedA = manager["persistSnapshot"]({ entry: aEntry!, attempt: aEntry!.operation!.attempt });
        const failedBarrier = manager._takeSnapshot();
        const resultsA = Promise.allSettled([failedA, failedBarrier]);
        await txA.entered;
        expect(storage.contents()).toEqual(initial.map(sanitiseEventForPersistence));
        expect(manager.hasPendingFileEvent(a.args.file.path as FilePath)).toBe(true);

        const b = event("B");
        b.args.cache = "large cached content";
        b.args.ctx = { source: "test host" };
        b.restoredFromPreviousRuntime = true;
        const startedB = promiseWithResolvers<void>();
        const finishB = promiseWithResolvers<boolean>();
        process.mockImplementationOnce(() => {
            startedB.resolve();
            return finishB.promise;
        });
        const recovery = blockCommit(storage);
        manager.enqueue(b);
        const staleAttempt = staleEntry!.operation!.attempt;
        staleEntry!.operation!.attempt = createFileEventAttempt(true);
        const admissionFailure = new Error("admission rejected");
        rejectedEntry!.operation!.attempt.admissionFailure = { error: admissionFailure };
        const batchResults = Promise.allSettled([
            manager["persistSnapshot"]({ entry: staleEntry!, attempt: staleAttempt }),
            manager["persistSnapshot"]({ entry: rejectedEntry!, attempt: rejectedEntry!.operation!.attempt }),
            manager["persistSnapshot"]({ entry: cEntry!, attempt: cEntry!.operation!.attempt }),
            state.operations.get(b)!.attempt.admissionPersistence!,
        ]);
        expect(manager.hasPendingFileEvent(b.args.file.path as FilePath)).toBe(true);
        expect(process).not.toHaveBeenCalled();
        expect(storage.contents()).toEqual(initial.map(sanitiseEventForPersistence));

        const txFailure = new Error("commit A failed");
        txA.reject(txFailure);
        await recovery.entered;
        expect(await resultsA).toEqual(Array(2).fill({ status: "rejected", reason: txFailure }));
        expect(storage.contents()).toEqual(initial.map(sanitiseEventForPersistence));
        for (const item of [...initial, b])
            expect(manager.hasPendingFileEvent(item.args.file.path as FilePath)).toBe(true);
        expect(process).not.toHaveBeenCalled();

        recovery.resolve();
        expect(await batchResults).toEqual([
            { status: "fulfilled", value: undefined },
            { status: "rejected", reason: admissionFailure },
            { status: "fulfilled", value: undefined },
            { status: "fulfilled", value: undefined },
        ]);
        await startedB.promise;
        expect(storage.contents()).toEqual([a, stale, rejected, b].map(sanitiseEventForPersistence));
        expect(storage.contents().at(-1)).toEqual({
            type: b.type,
            key: b.key,
            args: { file: b.args.file, ctx: b.args.ctx },
        });
        expect(process.mock.calls[0]?.[0]).toBe(b);
        expect(b).toMatchObject({
            args: { cache: "large cached content" },
            restoredFromPreviousRuntime: true,
            skipBatchWait: true,
        });
        expect(manager.hasPendingFileEvent(c.args.file.path as FilePath)).toBe(false);
        expect(manager.hasPendingFileEvent(b.args.file.path as FilePath)).toBe(true);
        finishB.resolve(true);
        await state.operations.get(b)!.attempt.completion.promise;
        expect(storage.contents()).toEqual([a, stale, rejected].map(sanitiseEventForPersistence));

        if (mode === "incremental") {
            expect(storage.saveSnapshot).not.toHaveBeenCalled();
            expect(storage.loadSnapshot).not.toHaveBeenCalled();
            for (const [delta] of storage.applySnapshotDelta.mock.calls) {
                expect(delta.upsert.some(({ id }) => delta.remove.includes(id))).toBe(false);
            }
        }
        await manager.stopWatching();
    });

    it("settles a late admission failure only after the active handler drains", async () => {
        const storage = store(mode);
        const { manager, process, state } = runtime(storage.adapter);
        const item = event("active-admission-failure");
        const started = promiseWithResolvers<void>();
        const handler = promiseWithResolvers<boolean>();
        process.mockImplementationOnce(() => {
            started.resolve();
            return handler.promise;
        });
        const running = manager.processFileEvent(item);
        const result = Promise.allSettled([running]);
        await started.promise;
        const attempt = state.operations.get(item)!.attempt;
        const failure = new Error("late rejection");
        attempt.admissionFailure = { error: failure };
        expect(attempt.result).toBeUndefined();
        expect(state.dispatch.inFlightOperations.size).toBe(1);
        expect(storage.contents()).toEqual([sanitiseEventForPersistence(item)]);
        handler.resolve(true);
        expect(await result).toEqual([{ status: "rejected", reason: failure }]);
        expect(state.dispatch.inFlightOperations.size).toBe(0);
        expect(storage.contents()).toEqual([sanitiseEventForPersistence(item)]);
        await manager.waitForIdle();
        expect(process).toHaveBeenCalledTimes(2);
        expect(storage.contents()).toEqual([]);
    });
});

describe("incremental persistence capability", () => {
    it("allocates ordered IDs for intents and sentinels and removes a sentinel after committed predecessors", async () => {
        const predecessor = event("prior");
        const storage = store("incremental", [predecessor]);
        const { manager, process, state } = runtime(storage.adapter);
        const handler = promiseWithResolvers<boolean>();
        const started = promiseWithResolvers<void>();
        process.mockImplementationOnce(() => {
            started.resolve();
            return handler.promise;
        });
        const boot = manager.restoreState();
        await started.promise;
        const deletion = { ...event("delete"), type: "DELETE" } as const;
        const admission = blockCommit(storage);
        const clock = vi.spyOn(Date, "now").mockReturnValue(0);
        try {
            manager.enqueue(deletion);
        } finally {
            clock.mockRestore();
        }
        await admission.entered;
        expect(keys(storage.contents())).toEqual(["prior"]);
        admission.resolve();
        await state.operations.get(deletion)!.attempt.admissionPersistence;
        const records = storage.orderedRecords();
        expect(keys(records.map((record) => record.event))).toEqual(["prior", TYPE_SENTINEL_FLUSH, "delete"]);
        expect(Number(records[1]!.id)).toBeGreaterThan(Number(records[0]!.id));
        expect(Number(records[2]!.id)).toBe(Number(records[1]!.id) + 1);
        expect(process).toHaveBeenCalledOnce();
        const ack = blockCommit(storage);
        handler.resolve(true);
        await ack.entered;
        expect(storage.orderedRecords()).toEqual(records);
        ack.resolve();
        await Promise.all([boot, manager.waitForIdle()]);
        const deltas = storage.applySnapshotDelta.mock.calls.map(([delta]) => delta);
        const priorAck = deltas.findIndex(({ remove }) => remove.includes(records[0]!.id));
        const sentinelAck = deltas.findIndex(({ remove }) => remove.includes(records[1]!.id));
        expect(priorAck).toBeGreaterThanOrEqual(1);
        expect(sentinelAck).toBeGreaterThanOrEqual(priorAck);
        expect(storage.contents()).toEqual([]);
    });

    it("does not use the full snapshot reader after an incremental load rejects", async () => {
        const storage = store("incremental");
        const { manager } = runtime(storage.adapter);
        const failure = new Error("incremental load failed");
        storage.loadSnapshotEntries.mockRejectedValueOnce(failure);
        await expect(manager.restoreState()).rejects.toBe(failure);
        expect(storage.loadSnapshot).not.toHaveBeenCalled();
        await expect(manager.restoreState()).resolves.toBeUndefined();
        expect(storage.loadSnapshotEntries).toHaveBeenCalledTimes(2);
    });

    it("rejects duplicate logical record IDs without processing or acknowledging either record", async () => {
        const storage = store("incremental", [event("first-record"), event("second-record")]);
        const originalRecords = storage.orderedRecords();
        const duplicateId = originalRecords[0]!.id;
        storage.loadSnapshotEntries.mockResolvedValue(
            originalRecords.map((record) => ({ ...record, id: duplicateId }))
        );
        const { manager, process } = runtime(storage.adapter);

        await expect(manager.restoreState()).rejects.toThrow(`Duplicate storage event record id: ${duplicateId}`);

        expect(process).not.toHaveBeenCalled();
        expect(storage.applySnapshotDelta).not.toHaveBeenCalled();
        expect(storage.saveSnapshot).not.toHaveBeenCalled();
        expect(storage.orderedRecords()).toEqual(originalRecords);
    });

    it.each(["loadSnapshotEntries", "applySnapshotDelta"] as const)(
        "uses full snapshots without %s",
        async (missing) => {
            const storage = store("full snapshot", [event("legacy")]);
            const adapter = {
                ...storage.adapter,
                loadSnapshotEntries: storage.loadSnapshotEntries,
                applySnapshotDelta: storage.applySnapshotDelta,
            };
            const { [missing]: _missing, ...partial } = adapter;
            const { manager, process } = runtime(partial);
            await manager.restoreState();
            expect(process.mock.calls.map(([item]) => item.key)).toEqual(["legacy"]);
            expect(storage.loadSnapshot).toHaveBeenCalledOnce();
            expect(storage.saveSnapshot).toHaveBeenCalledExactlyOnceWith([]);
            expect(storage.loadSnapshotEntries).not.toHaveBeenCalled();
            expect(storage.applySnapshotDelta).not.toHaveBeenCalled();
        }
    );

    it("assigns live admissions after the loaded IDs without writing before the read", async () => {
        const storage = store("incremental", [
            event("stored"),
            sentinel(),
            { ...event("stored-delete"), type: "DELETE" },
        ]);
        const { manager, state } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const read = promiseWithResolvers<StorageEventSnapshotRecord[]>();
        storage.loadSnapshotEntries.mockReturnValueOnce(read.promise);
        const restored = manager.restoreState();
        const live = event("during-load");
        manager.enqueue(live);
        await Promise.resolve();
        await Promise.resolve();
        expect(storage.commit).not.toHaveBeenCalled();
        read.resolve(storage.orderedRecords());
        await state.operations.get(live)!.attempt.admissionPersistence;
        expect(keys(storage.contents())).toEqual(["stored", TYPE_SENTINEL_FLUSH, "stored-delete", "during-load"]);
        const ids = storage.orderedRecords().map((record) => record.id);
        expect(Number(ids[3])).toBeGreaterThan(Number(ids[2]));
        await manager.stopWatching();
        await restored;
    });
});

describe.each([1, 5])("scheduler with dispatch window %i", (window) => {
    it("finishes coalesced, retried, and ordered work in a finite overlapping flush", async () => {
        const storage = store("incremental");
        const { manager, settings, process, state } = runtime(storage.adapter, window);
        const root = event("root", "retry.md");
        const dependent = event("dependent", "retry.md");
        process.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        await expect(manager.processFileEvent(root)).rejects.toThrow("Storage operation failed");
        await expect(manager.processFileEvent(dependent)).rejects.toThrow("Storage operation failed");
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["root", "root"]);

        settings.batchSave = true;
        const older = { ...event("older", "batch.md"), skipBatchWait: false };
        const successor = { ...event("successor", "batch.md"), skipBatchWait: false };
        manager.enqueue(older);
        await vi.waitFor(() => expect(manager.isWaiting("batch.md" as FilePath)).toBe(true));
        manager.enqueue(successor);
        await vi.waitFor(() =>
            expect(state.operations.get(older)?.attempt.successor).toBe(state.operations.get(successor)?.attempt)
        );
        const probe = event("unrelated");
        manager.enqueue(probe);
        await expect(state.operations.get(probe)!.attempt.completion.promise).resolves.toEqual({ ok: true });

        const rootStarted = promiseWithResolvers<void>();
        const finishRoot = promiseWithResolvers<boolean>();
        const lateStarted = promiseWithResolvers<void>();
        const finishLate = promiseWithResolvers<boolean>();
        let active = 0;
        let highWater = 0;
        process.mockImplementation(async (item) => {
            active++;
            highWater = Math.max(highWater, active);
            try {
                if (item.key === root.key) {
                    rootStarted.resolve();
                    return await finishRoot.promise;
                }
                if (item.key === "later") {
                    lateStarted.resolve();
                    return await finishLate.promise;
                }
                return true;
            } finally {
                active--;
            }
        });
        const deletion = { ...event("delete"), type: "DELETE" } as const;
        manager.enqueue(deletion);
        const first = manager.waitForIdle();
        const second = manager.waitForIdle();
        await rootStarted.promise;
        const later = event("later");
        manager.enqueue(later);
        expect(keys(storage.contents())).toContain(TYPE_SENTINEL_FLUSH);
        finishRoot.resolve(true);
        await Promise.all([first, second, lateStarted.promise]);
        expect(manager.hasPendingFileEvent(later.args.file.path as FilePath)).toBe(true);
        expect(highWater).toBeLessThanOrEqual(window);
        const handled = keys(process.mock.calls.map(([item]) => item));
        expect(handled).toEqual(["root", "root", "unrelated", "successor", "root", "dependent", "delete", "later"]);
        expect(keys(storage.contents())).toEqual(["later"]);
        finishLate.resolve(true);
        await manager.waitForIdle();
        expect(storage.contents()).toEqual([]);
        await manager.stopWatching();
    });

    it("bounds simultaneous ready retries at the configured window", async () => {
        const storage = store("incremental");
        const { manager, process } = runtime(storage.adapter, window);
        const items = Array.from({ length: window + 1 }, (_, i) => event(`retry-window-${window}-${i}`));
        process.mockResolvedValue(false);
        for (const item of items)
            await expect(manager.processFileEvent(item)).rejects.toThrow("Storage operation failed");
        process.mockClear();
        const running = promiseWithResolvers<boolean>();
        process.mockImplementation(() => running.promise);
        const flush = manager.waitForIdle();
        try {
            await vi.waitFor(() => expect(process.mock.calls.length).toBeGreaterThanOrEqual(window));
            expect(process).toHaveBeenCalledTimes(window);
        } finally {
            running.resolve(true);
            await flush;
        }
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(keys(items));
    });

    it("dispatches a new arrival as a shared run exits", async () => {
        const storage = store("incremental");
        const { manager, state, process } = runtime(storage.adapter, window);
        const first = event("first");
        const arrival = event("at-exit");
        const buffer = manager["buffer"];
        const read = buffer.read.bind(buffer);
        const dispatch = vi.spyOn(manager, "processFileEvent");
        let injected = false;
        vi.spyOn(buffer, "read").mockImplementation(() => {
            const items = read();
            if (!items.length && dispatch.mock.calls.length === 1 && !injected) {
                injected = true;
                queueMicrotask(() => manager.enqueue(arrival));
            }
            return items;
        });
        manager.enqueue(first);
        await vi.waitFor(() => expect(state.operations.get(arrival)?.attempt.result).toEqual({ ok: true }));
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["first", "at-exit"]);
        expect(storage.contents()).toEqual([]);
    });
});

describe("editor timing hints", () => {
    it("extends the quiet period without extra writes and releases once at the maximum", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const storage = store("incremental");
        const { manager, settings, process, state } = runtime(storage.adapter);
        settings.batchSave = true;
        const item = { ...event("typing"), skipBatchWait: false };
        manager.enqueue(item);
        await vi.advanceTimersByTimeAsync(1500);
        const hint = () =>
            manager["watchEditorChange"]({}, { path: item.args.file.path, file: item.args.file, data: "typing" });
        for (const delay of [1600, 1000, 899]) {
            hint();
            await vi.advanceTimersByTimeAsync(delay);
            expect(process).not.toHaveBeenCalled();
            expect(storage.commit).toHaveBeenCalledOnce();
            expect(state.pendingSnapshot.size).toBe(1);
        }
        hint();
        await vi.advanceTimersByTimeAsync(1);
        expect(process).toHaveBeenCalledExactlyOnceWith(item);
        await vi.advanceTimersByTimeAsync(5000);
        expect(process).toHaveBeenCalledOnce();
        expect(storage.commit).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(storage.contents()).toEqual([]);
    });

    it("reads live settings and ignores a gate that is flushing or superseded on either side of a rename", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const storage = store("incremental");
        const { manager, settings, process, state } = runtime(storage.adapter);
        settings.batchSave = true;
        const source = { ...event("source"), skipBatchWait: false };
        const target = { ...event("target"), skipBatchWait: false };
        manager.enqueue(source);
        manager.enqueue(target);
        await vi.advanceTimersByTimeAsync(100);
        const hint = (item: FileEventItem) =>
            manager["watchEditorChange"]({}, { path: item.args.file.path, file: item.args.file, data: "edit" });
        const sourceTimer = vi.spyOn(manager["_waitingMap"].get(source.args.file.path)!.deadline, "schedule");
        const targetTimer = vi.spyOn(manager["_waitingMap"].get(target.args.file.path)!.deadline, "schedule");
        settings.batchSaveMinimumDelay = 3;
        hint(source);
        expect(sourceTimer).toHaveBeenLastCalledWith(3000);
        settings.batchSave = false;
        hint(source);
        expect(sourceTimer).toHaveBeenCalledOnce();
        settings.batchSave = true;
        const targetOperation = state.operations.get(target)!;
        targetOperation.flushRequested = true;
        hint(target);
        expect(targetTimer).not.toHaveBeenCalled();
        targetOperation.flushRequested = false;

        await manager.pauseDispatch();
        const rename = {
            ...event("rename"),
            type: "RENAME",
            args: { file: target.args.file, oldPath: source.args.file.path },
        } as const;
        manager.enqueue(rename);
        await vi.advanceTimersByTimeAsync(0);
        hint(source);
        hint(target);
        expect(sourceTimer).toHaveBeenCalledOnce();
        expect(targetTimer).not.toHaveBeenCalled();
        expect(process).not.toHaveBeenCalled();
        await manager.stopWatching();
        expect(vi.getTimerCount()).toBe(0);
    });
});

function unloadRuntime(manager: AcceptanceStorageEventManager) {
    const context = new ServiceContext();
    const appLifecycle = new (class extends InjectableAppLifecycleService {})(context, {
        settingService: {},
    } as ConstructorParameters<typeof InjectableAppLifecycleService>[1]);
    const API = { addLog: vi.fn() };
    const storageAccess = new ServiceFileAccessBase({
        API,
        appLifecycle,
        storageEventManager: manager,
        fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } },
    } as unknown as StorageAccessBaseDependencies<never>);
    const close = vi.fn(async () => {});
    const control = new ControlService(context, {
        appLifecycleService: appLifecycle,
        databaseService: { closeDatabase: close },
        APIService: API,
    } as unknown as ControlServiceDependencies);
    return { control, appLifecycle, storageAccess, close };
}

describe("preserve-and-stop and Commonlib handoff", () => {
    it.each(modes)("flushes a rejected admission before stopping with a %s adapter", async (mode) => {
        const storage = store(mode);
        const { manager, process, state } = runtime(storage.adapter);
        const item = event("rejected-admission", "pending.md");
        const persisted = sanitiseEventForPersistence(item);
        const failure = new Error("initial admission write failed");
        const admission = blockCommit(storage);
        const finalFlush = blockCommit(storage);
        manager.enqueue(item);
        const rejected = expect(state.operations.get(item)!.attempt.admissionPersistence).rejects.toBe(failure);
        await admission.entered;
        admission.reject(failure);
        await rejected;

        const stopped = vi.fn();
        const stopping = manager.stopWatching().then(stopped);
        await finalFlush.entered;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).not.toHaveBeenCalled();
        expect(process).not.toHaveBeenCalled();
        expect(storage.contents()).toEqual([]);

        finalFlush.resolve();
        await stopping;
        expect(storage.commit).toHaveBeenCalledTimes(2);
        expect(process).not.toHaveBeenCalled();
        expect(storage.contents()).toEqual([persisted]);

        const replacement = runtime(storage.adapter);
        await replacement.manager.restoreState();
        expect(replacement.process).toHaveBeenCalledExactlyOnceWith({
            ...persisted,
            restoredFromPreviousRuntime: true,
            skipBatchWait: true,
        });
        expect(storage.contents()).toEqual([]);
    });

    it.each(["resume", "stop"] as const)("can %s an attempt paused after semaphore selection", async (action) => {
        const storage = store("incremental");
        const { manager, process, state } = runtime(storage.adapter, 2);
        const semaphore = Semaphore(1);
        manager["concurrentProcessing"] = semaphore;
        const first = event("active");
        const second = event("selected");
        const started = promiseWithResolvers<void>();
        const handler = promiseWithResolvers<boolean>();
        process.mockImplementationOnce(() => {
            started.resolve();
            return handler.promise;
        });
        manager.enqueue(first);
        await started.promise;
        manager.enqueue(second);
        await vi.waitFor(() => expect(semaphore.waiting).toBe(1));
        expect(state.dispatch.activeSlots).toBe(2);

        const paused = manager.pauseDispatch();
        handler.resolve(true);
        await paused;
        await vi.waitFor(() => expect(state.dispatch.activeSlots).toBe(0));
        expect(process).toHaveBeenCalledExactlyOnceWith(first);
        expect(storage.contents()).toEqual([sanitiseEventForPersistence(second)]);
        const permit = await semaphore.tryAcquire(1, 0);
        expect(permit).toBeTypeOf("function");
        if (permit) {
            permit();
        }

        if (action === "resume") {
            manager.resumeDispatch();
            await manager.waitForIdle();
            expect(process.mock.calls).toEqual([[first], [second]]);
            expect(storage.contents()).toEqual([]);
            await manager.stopWatching();
        } else {
            await manager.stopWatching();
            expect(process).toHaveBeenCalledExactlyOnceWith(first);
            expect(storage.contents()).toEqual([sanitiseEventForPersistence(second)]);
        }
        expect(state.dispatch.activeSlots).toBe(0);
        expect(semaphore.waiting).toBe(0);
    });

    it.each(modes)("leaves an unread %s intact during unload and skips watcher registration", async (mode) => {
        const retained = event("on-disk");
        const storage = store(mode, [retained]);
        const { manager, process, watcher } = runtime(storage.adapter);
        const { control, appLifecycle, close } = unloadRuntime(manager);
        const completedRead = promiseWithResolvers<void>();
        const originalRecords = storage.orderedRecords();
        if (mode === "incremental") {
            storage.loadSnapshotEntries.mockImplementationOnce(async () => {
                await completedRead.promise;
                return originalRecords;
            });
        } else {
            storage.loadSnapshot.mockImplementationOnce(async () => {
                await completedRead.promise;
                return [retained];
            });
        }
        const reading = manager.restoreState();
        const beginning = manager.beginWatch();
        const unloading = control.onUnload();
        expect(appLifecycle.isUnloading()).toBe(true);
        expect(manager.isStopping()).toBe(true);
        await unloading;
        await manager.beginWatch();
        expect(watcher).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(storage.contents()).toEqual([retained]);
        expect(storage.commit).not.toHaveBeenCalled();

        const replacement = runtime(storage.adapter);
        await replacement.manager.restoreState();
        expect(keys(replacement.process.mock.calls.map(([item]) => item))).toEqual(["on-disk"]);
        const writes = storage.commit.mock.calls.length;
        completedRead.resolve();
        await Promise.all([reading, beginning]);
        expect(storage.commit).toHaveBeenCalledTimes(writes);
        expect(close).toHaveBeenCalledOnce();
        expect(storage.contents()).toEqual([]);
        expect(process).not.toHaveBeenCalled();
        expect(watcher).not.toHaveBeenCalled();
    });

    it.each(["batch wait", "recovery pause", "running handler", "explicit flush"] as const)(
        "retires during %s and replays exactly the pending intents",
        async (phase) => {
            const storage = store("incremental");
            const { manager, state, settings, process } = runtime(storage.adapter, 1);
            const { control, appLifecycle, close } = unloadRuntime(manager);
            const releaseHandler = promiseWithResolvers<boolean>();
            const started = promiseWithResolvers<void>();
            const handlerActive = phase === "running handler" || phase === "explicit flush";
            const active = event("active");
            const retained = { ...event("retained"), skipBatchWait: phase !== "batch wait" };
            if (handlerActive) {
                process.mockImplementationOnce(() => {
                    started.resolve();
                    return releaseHandler.promise;
                });
                manager.enqueue(active);
                await started.promise;
            }
            if (phase === "recovery pause") await manager.pauseDispatch();
            if (phase === "batch wait") {
                vi.useFakeTimers();
                settings.batchSave = true;
            }
            manager.enqueue(retained);
            await state.operations.get(retained)!.attempt.admissionPersistence;
            const flush = phase === "explicit flush" ? manager.waitForIdle() : undefined;
            if (phase === "batch wait") {
                await vi.advanceTimersByTimeAsync(0);
                expect(manager.isWaiting(retained.args.file.path as FilePath)).toBe(true);
                expect(vi.getTimerCount()).toBeGreaterThan(0);
            }
            const run = vi.spyOn(manager as unknown as { runQueuedEvents(): Promise<void> }, "runQueuedEvents");
            appLifecycle.onBeforeUnload.addHandler(async () => {
                manager.resumeDispatch();
                return true;
            }, -100);
            const unloading = control.onUnload();
            expect(manager.isStopping()).toBe(true);
            if (handlerActive) {
                expect(close).not.toHaveBeenCalled();
                expect(keys(storage.contents())).toEqual(["active", "retained"]);
                releaseHandler.resolve(true);
            }
            await Promise.all([unloading, flush]);
            expect(keys(process.mock.calls.map(([item]) => item))).toEqual(handlerActive ? ["active"] : []);
            expect(close).toHaveBeenCalledOnce();
            expect(keys(storage.contents())).toEqual(["retained"]);
            if (phase === "batch wait") expect(vi.getTimerCount()).toBe(0);
            if (phase === "recovery pause") {
                expect(run).not.toHaveBeenCalled();
                expect(manager["dispatchPaused"]).toBe(true);
            }

            const writes = storage.commit.mock.calls.length;
            const replacement = runtime(storage.adapter);
            await replacement.manager.restoreState();
            await manager.stopWatching();
            expect(keys(replacement.process.mock.calls.map(([item]) => item))).toEqual(["retained"]);
            expect(storage.commit).toHaveBeenCalledTimes(writes + 1);
            expect(storage.contents()).toEqual([]);
            expect(close).toHaveBeenCalledOnce();
        }
    );

    it("keeps restore single-flight across live scans and leaves staged admissions undurable until commit", async () => {
        const storage = store("incremental");
        const { manager, process, state, settings } = runtime(storage.adapter);
        const { storageAccess } = unloadRuntime(manager);
        const read = promiseWithResolvers<StorageEventSnapshotRecord[]>();
        storage.loadSnapshotEntries.mockReturnValueOnce(read.promise);
        const host = {
            services: {
                setting: { currentSettings: () => settings },
                keyValueDB: { kvDB: { get: async () => true } },
                database: {
                    localDatabase: {
                        findAllDocs: (): never[] => [],
                        findAllNormalDocs: (): never[] => [],
                        isReady: true,
                    },
                },
            },
            serviceModules: {
                fileHandler: {},
                storageAccess: {
                    isStopping: storageAccess.isStopping.bind(storageAccess),
                    restoreState: storageAccess.restoreState.bind(storageAccess),
                    getFiles: vi.fn(() => []),
                },
            },
        } as unknown as Parameters<typeof performFullScan>[0];
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];
        const restoring = manager.restoreState();
        expect(manager.restoreState()).toBe(restoring);
        const scan = performFullScan(host, vi.fn(), errors);
        read.resolve([]);
        await expect(scan).resolves.toBe(true);
        const admission = blockCommit(storage);
        const live = event("live");
        manager.enqueue(live);
        const buffer = manager["buffer"].read();
        const operation = state.operations.get(live);
        await admission.entered;
        await expect(performFullScan(host, vi.fn(), errors)).resolves.toBe(true);
        expect(storage.loadSnapshotEntries).toHaveBeenCalledOnce();
        expect(manager["buffer"].read()).toBe(buffer);
        expect(state.operations.get(live)).toBe(operation);
        expect(state.pendingSnapshot.size).toBe(1);
        expect(state.pendingSnapshot.get(live)?.persisted).toBe(false);
        expect(process).not.toHaveBeenCalled();
        expect(storage.contents()).toEqual([]);
        admission.resolve();
        await manager.waitForIdle();
        expect(process).toHaveBeenCalledExactlyOnceWith(live);
        expect(storage.contents()).toEqual([]);
    });

    it.each(["batch gate", "handler", "acknowledgement"] as const)(
        "rejects work at the %s of a replaced store generation",
        async (phase) => {
            const first = store("incremental");
            const replacement = store("incremental");
            let selected = first;
            const adapter = {
                ...first.adapter,
                loadSnapshotEntries: () => selected.loadSnapshotEntries(),
                applySnapshotDelta: (delta: StorageEventSnapshotDelta) => selected.applySnapshotDelta(delta),
            };
            const { manager, process, settings, state } = runtime(adapter);
            await manager.restoreState();
            const item = { ...event("replaced-store"), skipBatchWait: phase !== "batch gate" };
            settings.batchSave = phase === "batch gate";
            const handler = promiseWithResolvers<boolean>();
            const started = promiseWithResolvers<void>();
            process.mockImplementationOnce(() => {
                started.resolve();
                return phase === "batch gate" ? Promise.resolve(true) : handler.promise;
            });
            const running = manager.processFileEvent(item);
            const result = Promise.allSettled([running]);
            if (phase === "batch gate") {
                await vi.waitFor(() => expect(state.pendingSnapshot.get(item)?.persisted).toBe(true));
                expect(manager.isWaiting(item.args.file.path as FilePath)).toBe(true);
            } else await started.promise;
            const ack = phase === "acknowledgement" ? blockCommit(first) : undefined;
            if (ack) {
                handler.resolve(true);
                await ack.entered;
            }
            selected = replacement;
            manager.resetPersistenceState();
            await manager.restoreState();
            expect(state.pendingSnapshot.get(item)?.persisted).toBe(false);
            if (phase === "batch gate") manager["_proceedWaiting"](item.args.file.path, false);
            else if (ack) ack.resolve();
            else handler.resolve(true);
            const [outcome] = await result;
            expect(outcome).toMatchObject({
                status: "rejected",
                reason: expect.objectContaining({ message: expect.stringContaining("store changed") }),
            });
            expect(manager.hasPendingFileEvent(item.args.file.path as FilePath)).toBe(true);
            expect(replacement.commit).not.toHaveBeenCalled();
            if (phase === "batch gate") expect(process).not.toHaveBeenCalled();
            await manager.waitForIdle();
            expect(
                replacement.applySnapshotDelta.mock.calls.map(([delta]) => keys(delta.upsert.map(({ event }) => event)))
            ).toEqual([["replaced-store"], []]);
            expect(replacement.contents()).toEqual([]);
            expect(first.loadSnapshotEntries).toHaveBeenCalledOnce();
            expect(replacement.loadSnapshotEntries).toHaveBeenCalledOnce();
        }
    );
});

describe.each(["incremental", "suppressed full snapshot I/O"] as const)("7,453-entry restore with %s", (mode) => {
    it("preserves order and bounds dispatch and persistence work", async () => {
        const window = 5;
        const cache = [4, 16, 64].map((kib) => "x".repeat(kib * 1024));
        const fixture: QueuedFileEvent[] = [];
        for (let i = 0; i < 7453; i++) {
            if (i % 53 === 0) {
                fixture.push(sentinel());
                continue;
            }
            const item = event(`backlog-${i}`, `notes/folder-${i % 12}/note-${i % 480}.md`);
            item.args.cache = cache[i % cache.length];
            item.args.ctx = { source: i };
            if (i % 53 === 1) {
                item.type = "DELETE";
                item.args.renameTarget = `excluded/note-${i}.md`;
            }
            fixture.push(item);
        }
        const storage = store("incremental", fixture);
        let fullWrites = 0;
        let redundantFullWrites = 0;
        let firstFullSnapshot: QueuedFileEvent[] | undefined;
        let lastFullSize: number | undefined;
        const suppressedIO = {
            loadSnapshot: async () => fixture,
            saveSnapshot: async (snapshot: QueuedFileEvent[]) => {
                fullWrites++;
                firstFullSnapshot ??= snapshot;
                if (snapshot.length >= (lastFullSize ?? fixture.length)) redundantFullWrites++;
                lastFullSize = snapshot.length;
            },
        };
        const { manager, state, process } = runtime(mode === "incremental" ? storage.adapter : suppressedIO, window);
        const processed: string[] = [];
        const firstReadyGroup = promiseWithResolvers<void>();
        let peakSlots = 0;
        let active = 0;
        let peakHandlers = 0;
        let statusWorkMs = 0;
        let pendingWorkMs = 0;
        let snapshotVisits = 0;
        process.mockImplementation(async (item) => {
            if (processed.length === 0) {
                const visitsBefore = snapshotVisits;
                const lookups = vi.spyOn(state.pendingPathCounts, "get");
                let start = performance.now();
                for (let n = 0; n < 1000; n++) manager["updateStatus"]();
                statusWorkMs = performance.now() - start;
                expect(snapshotVisits).toBe(visitsBefore);
                const childPath = `${item.args.file.path}/child/grandchild` as FilePath;
                start = performance.now();
                for (let n = 0; n < 1000; n++) expect(manager.hasPendingFileEvent(childPath)).toBe(true);
                pendingWorkMs = performance.now() - start;
                expect(lookups).toHaveBeenCalledTimes(3000);
                expect(snapshotVisits).toBe(visitsBefore);
                lookups.mockRestore();
            }
            processed.push(item.key);
            peakSlots = Math.max(peakSlots, state.dispatch.activeSlots);
            active++;
            peakHandlers = Math.max(peakHandlers, active);
            // Hold the first five distinct ready operations until the window fills.
            if (processed.length === window + 1) firstReadyGroup.resolve();
            if (processed.length >= 2 && processed.length <= window + 1) await firstReadyGroup.promise;
            active--;
            return true;
        });
        if (mode === "incremental") {
            const values = state.pendingSnapshot.values.bind(state.pendingSnapshot);
            vi.spyOn(state.pendingSnapshot, "values").mockImplementation(() => {
                const iterator = values();
                const next = iterator.next.bind(iterator);
                iterator.next = () => {
                    const item = next();
                    if (!item.done) snapshotVisits++;
                    return item;
                };
                return iterator;
            });
        }
        const start = performance.now();
        const startCpu = globalThis.process.cpuUsage();
        const dispatch = vi.spyOn(manager, "processFileEvent");
        await manager.restoreState();
        await manager.stopWatching();
        const elapsed = performance.now() - start;
        const { user, system } = globalThis.process.cpuUsage(startCpu);
        const cpuMs = (user + system) / 1000;

        const operations = fixture.filter((item) => item.type !== TYPE_SENTINEL_FLUSH);
        expect(keys(dispatch.mock.calls.map(([item]) => item))).toEqual(keys(operations));
        expect(processed).toEqual(keys(operations));
        expect(peakSlots).toBeLessThanOrEqual(window);
        expect(peakHandlers).toBe(window);
        expect(state.pendingSnapshot.size).toBe(0);
        const writes = mode === "incremental" ? storage.applySnapshotDelta.mock.calls.length : fullWrites;
        if (mode === "incremental") {
            const deltas = storage.applySnapshotDelta.mock.calls.map(([delta]) => delta);
            expect(storage.saveSnapshot).not.toHaveBeenCalled();
            expect(storage.contents()).toEqual([]);
            expect(deltas.every(({ upsert, remove }) => upsert.length === 0 && remove.length > 0)).toBe(true);
            expect(snapshotVisits).toBeLessThan(fixture.length * 6);
            const removals = deltas.flatMap(({ remove }) => remove);
            expect(removals).toHaveLength(fixture.length);
            expect(new Set(removals).size).toBe(fixture.length);
            const positions = new Map(removals.map((id, i) => [id, i]));
            for (const [i, item] of fixture.entries()) {
                if (item.type !== TYPE_SENTINEL_FLUSH || i === 0) continue;
                const id = String(i + 1).padStart(12, "0");
                const previousId = String(i).padStart(12, "0");
                expect(positions.get(id)!).toBeGreaterThan(positions.get(previousId)!);
            }
        } else {
            expect(lastFullSize).toBe(0);
            expect(redundantFullWrites).toBe(0);
            expect(firstFullSnapshot).toEqual(fixture.slice(1).map(sanitiseEventForPersistence));
            const firstFile = operations[0]!;
            expect(firstFile.args.cache).toBe(cache[1]);
            expect(firstFile.restoredFromPreviousRuntime).toBeUndefined();
        }
        globalThis.process.stdout.write(
            `7,453-entry ${mode}: ${elapsed.toFixed(1)} ms elapsed, ${cpuMs.toFixed(1)} ms CPU, ${writes} acknowledgement writes, ` +
                `peak ${peakSlots} slots / ${peakHandlers} handlers, 1,000 status updates ${statusWorkMs.toFixed(1)} ms, ` +
                `1,000 depth-3 pending lookups ${pendingWorkMs.toFixed(1)} ms` +
                (mode === "incremental" ? `, ${snapshotVisits} pending entries visited\n` : "\n")
        );
        expect(elapsed).toBeLessThan(5000);
    }, 12_000);
});

describe("Astra Pass 2 regressions", () => {
    it("replays a durable admission when the first scan was interrupted before recording initialisation", async () => {
        const storage = store("full snapshot");
        const pausedListing = promiseWithResolvers<never[]>();
        const listingStarted = promiseWithResolvers<void>();
        const set = vi.fn(async () => {});
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];
        function startRuntime(getFiles: () => Promise<never[]>) {
            const instance = runtime(storage.adapter);
            const { storageAccess } = unloadRuntime(instance.manager);
            vi.spyOn(storageAccess, "getFiles").mockImplementation(getFiles);
            const host = {
                services: {
                    setting: { currentSettings: () => instance.settings },
                    keyValueDB: { kvDB: { get: async (): Promise<undefined> => undefined, set } },
                    database: {
                        localDatabase: {
                            isReady: true,
                            findAllDocs: (): never[] => [],
                            findAllNormalDocs: (): never[] => [],
                        },
                    },
                },
                serviceModules: { storageAccess, fileHandler: {} },
            } as unknown as Parameters<typeof performFullScan>[0];
            return { ...instance, scan: () => performFullScan(host, vi.fn(), errors) };
        }

        const first = startRuntime(() => {
            listingStarted.resolve();
            return pausedListing.promise;
        });
        await first.manager.pauseDispatch();
        const interrupted = first.scan();
        await listingStarted.promise;
        const durable = event("before-initialisation");
        first.manager.enqueue(durable);
        await first.state.operations.get(durable)!.attempt.admissionPersistence;
        expect(keys(storage.contents())).toEqual([durable.key]);
        await first.manager.stopWatching();
        pausedListing.resolve([]);
        await expect(interrupted).resolves.toBe(false);
        expect(set).not.toHaveBeenCalledWith("initialized", true);

        const next = startRuntime(async (): Promise<never[]> => []);
        await expect(next.scan()).resolves.toBe(true);
        next.manager.enqueue(event("later"));
        await next.manager.waitForIdle();
        expect(keys(next.process.mock.calls.map(([item]) => item))).toEqual([durable.key, "later"]);
        expect(storage.contents()).toEqual([]);
        expect(set).toHaveBeenCalledWith("initialized", true);
    });

    it("acquires the full snapshot before a direct admission can replace unread work", async () => {
        const unread = event("unread", "same.md");
        const storage = store("full snapshot", [unread]);
        const { manager, process } = runtime(storage.adapter);
        manager.enqueue(event("live", "same.md"));
        await manager.waitForIdle();
        expect(storage.loadSnapshot).toHaveBeenCalledOnce();
        expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["unread", "live"]);
    });

    it("writes and replays a replacement store in admission order, with the delete barrier in place", async () => {
        const first = store("incremental");
        const replacement = new Map<string, StorageEventSnapshotRecord>();
        const applyReplacement = vi.fn(async ({ upsert, remove }: StorageEventSnapshotDelta) => {
            for (const item of upsert) replacement.set(item.id, item);
            for (const id of remove) replacement.delete(id);
        });
        const replacementAdapter = {
            ...first.adapter,
            loadSnapshotEntries: async () => [...replacement.values()],
            applySnapshotDelta: applyReplacement,
        };
        let selected: Pick<IStorageEventIncrementalPersistenceAdapter, "loadSnapshotEntries" | "applySnapshotDelta"> =
            first;
        const adapter: IStorageEventIncrementalPersistenceAdapter = {
            ...first.adapter,
            loadSnapshotEntries: () => selected.loadSnapshotEntries(),
            applySnapshotDelta: (delta) => selected.applySnapshotDelta(delta),
        };
        const { manager, state } = runtime(adapter);
        await manager.pauseDispatch();
        const a = event("A", "same.md");
        const b = { ...event("B", "same.md"), type: "DELETE" } as const;
        manager.enqueue(a);
        await state.operations.get(a)!.attempt.admissionPersistence;
        manager.enqueue(b);
        selected = replacementAdapter;
        manager.resetPersistenceState();
        await manager.restoreState();
        await manager.stopWatching();

        const upserts = applyReplacement.mock.calls.flatMap(([delta]) => delta.upsert.map(({ event }) => event));
        expect(keys(upserts.filter((item) => item.type !== TYPE_SENTINEL_FLUSH))).toEqual(["A", "B"]);
        expect(keys(upserts)).toEqual(["A", TYPE_SENTINEL_FLUSH, "B"]);
        const restarted = runtime(replacementAdapter);
        await restarted.manager.restoreState();
        expect(keys(restarted.process.mock.calls.map(([item]) => item))).toEqual(["A", "B"]);
        expect(replacement.size).toBe(0);
    });

    it.each(modes)("restoring a live %s store dispatches its already-durable admission once", async (mode) => {
        const storage = store(mode);
        const { manager, state, process } = runtime(storage.adapter);
        await manager.pauseDispatch();
        const item = event("already-durable");
        manager.enqueue(item);
        await state.operations.get(item)!.attempt.admissionPersistence;
        expect(keys(storage.contents())).toEqual([item.key]);
        const restored = manager.restoreState();
        manager.resumeDispatch();
        await restored;
        await manager.waitForIdle();
        expect(process).toHaveBeenCalledExactlyOnceWith(item);
        expect(storage.contents()).toEqual([]);
    });

    it("does bounded pending-entry lookup work per restored operation on one path", async () => {
        async function countLookups(length: number) {
            const events = Array.from({ length }, (_, index) => event(String(index), "same.md"));
            const storage = store("incremental", events);
            const { manager, state, process } = runtime(storage.adapter, 5);
            const lookup = vi.spyOn(state.pendingSnapshot, "get");
            await manager.restoreState();
            expect(keys(process.mock.calls.map(([item]) => item))).toEqual(keys(events));
            expect(storage.contents()).toEqual([]);
            return lookup.mock.calls.length;
        }
        const small = await countLookups(200);
        const large = await countLookups(800);
        expect(large).toBeLessThanOrEqual(small * 5);
        expect(large).toBeLessThan(800 * 20);
    });

    it("rejects a sparse legacy snapshot before claiming ownership or permitting writes on stop", async () => {
        const storage = store("full snapshot");
        const sparse = [event("first"), event("last"), event("third")];
        Reflect.deleteProperty(sparse, 1);
        storage.loadSnapshot.mockResolvedValue(sparse);
        const { manager, state, process } = runtime(storage.adapter);

        await expect(manager.restoreState()).rejects.toThrow("Invalid storage event snapshot");
        expect(isStoreAcquired(state)).toBe(false);
        expect(state.pendingSnapshot.size).toBe(0);
        expect(state.pendingOperationCount).toBe(0);
        expect(state.persistence.activeRecordIds.size).toBe(0);
        expect(manager["buffer"].read()).toEqual([]);

        const late = event("late");
        manager.enqueue(late);
        await expect(state.operations.get(late)!.attempt.admissionPersistence).rejects.toThrow();
        await expect(manager.stopWatching()).rejects.toThrow("Invalid storage event snapshot");
        expect(process).not.toHaveBeenCalled();
        expect(storage.saveSnapshot).not.toHaveBeenCalled();
        expect(await storage.loadSnapshot()).toBe(sparse);
    });

    it("snapshots structured-cloneable context and forwards non-cloneable host context verbatim", () => {
        const structuredItem = event("structured-ctx");
        const nested = { tag: "initial" };
        const map = new Map([["k", new Set([1, 2])]]);
        structuredItem.args.ctx = { nested, map };
        const persistedStructured = sanitiseEventForPersistence(structuredItem) as FileEventItem;
        nested.tag = "mutated";
        const clonedCtx = persistedStructured.args.ctx as { nested: { tag: string }; map: Map<string, Set<number>> };
        expect(clonedCtx.nested.tag).toBe("initial");
        expect([...clonedCtx.map.get("k")!]).toEqual([1, 2]);

        const opaqueCtx = { id: 1, helper: () => "host-only" };
        const opaqueItem = event("opaque-ctx");
        opaqueItem.args.ctx = opaqueCtx;
        const persistedOpaque = sanitiseEventForPersistence(opaqueItem) as FileEventItem;
        expect(persistedOpaque.args.ctx).toBe(opaqueCtx);

        vi.stubGlobal("structuredClone", undefined);
        try {
            const fallbackItem = event("fallback-ctx");
            fallbackItem.args.ctx = { map };
            const persistedFallback = sanitiseEventForPersistence(fallbackItem) as FileEventItem;
            expect(persistedFallback.args.ctx).toBe(fallbackItem.args.ctx);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("Astra Pass 3 regressions", () => {
    it.each([1, 5])(
        "does not deadlock replay or waitForIdle when a live delete arrives during same-path replay at window %i",
        async (window) => {
            const a1 = event("A1", "same.md");
            const a2 = event("A2", "same.md");
            const storage = store("incremental", [a1, a2]);
            const { manager, process, state } = runtime(storage.adapter, window);
            const a1Started = promiseWithResolvers<void>();
            const finishA1 = promiseWithResolvers<boolean>();
            process.mockImplementation(async (item) => {
                if (item.key === "A1") {
                    a1Started.resolve();
                    return await finishA1.promise;
                }
                return true;
            });

            const restoring = manager.restoreState();
            await a1Started.promise;

            const b = { ...event("B", "same.md"), type: "DELETE" } as const;
            manager.enqueue(b);
            await state.operations.get(b)!.attempt.admissionPersistence;

            const idle = manager.waitForIdle();
            finishA1.resolve(true);

            await Promise.all([restoring, idle]);
            expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["A1", "A2", "B"]);
            expect(storage.contents()).toEqual([]);
            await manager.stopWatching();
        }
    );

    it.each(modes)(
        "rejects malformed handler-selection data in %s restore before acquiring the store",
        async (mode) => {
            const valid = event("valid", "valid.md");
            const corrupt = {
                ...event("corrupt", "corrupt.md"),
                args: {
                    file: {
                        ...event("corrupt", "corrupt.md").args.file,
                        isInternal: "false" as unknown as boolean,
                    },
                },
            } as FileEventItem;
            const storage = store(mode, [valid, corrupt]);
            const { manager, process, optional, state } = runtime(storage.adapter);

            await expect(manager.restoreState()).rejects.toThrow("Invalid persisted storage event");
            expect(isStoreAcquired(state)).toBe(false);
            expect(state.pendingSnapshot.size).toBe(0);
            expect(process).not.toHaveBeenCalled();
            expect(optional).not.toHaveBeenCalled();
            expect(storage.commit).not.toHaveBeenCalled();
            expect(keys(storage.contents())).toEqual(["valid", "corrupt"]);

            await manager.stopWatching();
            expect(storage.commit).not.toHaveBeenCalled();
            expect(keys(storage.contents())).toEqual(["valid", "corrupt"]);
        }
    );

    it.each(modes)(
        "settles performFullScan to false and preserves the unread %s store when stopped during initial read",
        async (mode) => {
            const unread = event("unread-during-stop");
            const storage = store(mode, [unread]);
            const read = promiseWithResolvers<never>();
            if (mode === "incremental") {
                storage.loadSnapshotEntries.mockReturnValueOnce(read.promise);
            } else {
                storage.loadSnapshot.mockReturnValueOnce(read.promise);
            }
            const { manager, settings, state, process } = runtime(storage.adapter);
            const { storageAccess } = unloadRuntime(manager);
            const host = {
                services: {
                    setting: { currentSettings: () => settings },
                    keyValueDB: { kvDB: { get: async () => true, set: vi.fn() } },
                    database: {
                        localDatabase: {
                            isReady: true,
                            findAllDocs: (): never[] => [],
                            findAllNormalDocs: (): never[] => [],
                        },
                    },
                },
                serviceModules: {
                    fileHandler: {},
                    storageAccess: {
                        isStopping: storageAccess.isStopping.bind(storageAccess),
                        restoreState: storageAccess.restoreState.bind(storageAccess),
                        getFiles: vi.fn(() => []),
                    },
                },
            } as unknown as Parameters<typeof performFullScan>[0];
            const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<
                typeof performFullScan
            >[2];

            const scan = performFullScan(host, vi.fn(), errors);
            await vi.waitFor(() =>
                expect(mode === "incremental" ? storage.loadSnapshotEntries : storage.loadSnapshot).toHaveBeenCalledOnce()
            );

            await manager.stopWatching();
            await expect(scan).resolves.toBe(false);
            expect(isStoreAcquired(state)).toBe(false);
            expect(storage.commit).not.toHaveBeenCalled();

            // Late database-closed rejection from the abandoned read must not overwrite or surface unhandled.
            read.reject(new Error("Database closed during unload"));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(isStoreAcquired(state)).toBe(false);
            expect(storage.commit).not.toHaveBeenCalled();
            expect(process).not.toHaveBeenCalled();
            expect(keys(storage.contents())).toEqual(["unread-during-stop"]);
        }
    );

    it("returns false instead of rejecting when stopping closes the initialisation-marker read, while propagating ordinary failures", async () => {
        const storage = store("incremental");
        const { manager, settings } = runtime(storage.adapter);
        const { storageAccess } = unloadRuntime(manager);
        const read = promiseWithResolvers<boolean | undefined>();
        const kvGet = vi.fn(() => read.promise);
        const host = {
            services: {
                setting: { currentSettings: () => settings },
                keyValueDB: { kvDB: { get: kvGet, set: vi.fn() } },
                database: {
                    localDatabase: {
                        isReady: true,
                        findAllDocs: (): never[] => [],
                        findAllNormalDocs: (): never[] => [],
                    },
                },
            },
            serviceModules: {
                fileHandler: {},
                storageAccess: {
                    isStopping: storageAccess.isStopping.bind(storageAccess),
                    restoreState: storageAccess.restoreState.bind(storageAccess),
                    getFiles: vi.fn(() => []),
                },
            },
        } as unknown as Parameters<typeof performFullScan>[0];
        const errors = { showError: vi.fn(), clearError: vi.fn() } as unknown as Parameters<typeof performFullScan>[2];

        const scan = performFullScan(host, vi.fn(), errors);
        await vi.waitFor(() => expect(kvGet).toHaveBeenCalledOnce());
        await manager.stopWatching();
        read.reject(new Error("Database closed"));
        await expect(scan).resolves.toBe(false);

        const active = runtime(store("incremental").adapter);
        const activeAccess = unloadRuntime(active.manager).storageAccess;
        const ordinaryFailure = new Error("IndexedDB read failed");
        const activeHost = {
            ...host,
            services: {
                ...host.services,
                setting: { currentSettings: () => active.settings },
                keyValueDB: { kvDB: { get: vi.fn().mockRejectedValue(ordinaryFailure), set: vi.fn() } },
            },
            serviceModules: {
                fileHandler: {},
                storageAccess: {
                    isStopping: activeAccess.isStopping.bind(activeAccess),
                    restoreState: activeAccess.restoreState.bind(activeAccess),
                    getFiles: vi.fn(() => []),
                },
            },
        } as unknown as Parameters<typeof performFullScan>[0];
        await expect(performFullScan(activeHost, vi.fn(), errors)).rejects.toBe(ordinaryFailure);
    });

    it.each(modes)(
        "surfaces preservation failure and protects the unread %s store when an admitted rename cannot flush before stop",
        async (mode) => {
            const preexisting = event("preexisting", "existing.md");
            const storage = store(mode, [preexisting]);
            const read = promiseWithResolvers<never>();
            if (mode === "incremental") {
                storage.loadSnapshotEntries.mockReturnValueOnce(read.promise);
            } else {
                storage.loadSnapshot.mockReturnValueOnce(read.promise);
            }
            const { manager, state, process } = runtime(storage.adapter);

            const restoring = manager.restoreState();
            await vi.waitFor(() =>
                expect(mode === "incremental" ? storage.loadSnapshotEntries : storage.loadSnapshot).toHaveBeenCalledOnce()
            );

            await manager.appendQueue([
                {
                    type: "RENAME",
                    file: {
                        path: "new.md" as FilePath,
                        name: "new.md",
                        isFolder: false,
                        stat: { ctime: 1, mtime: 2, size: 3, type: "file" },
                    },
                    oldPath: "old.md",
                },
            ]);
            expect(manager.hasPendingFileEvent("old.md" as FilePath)).toBe(true);
            expect(isStoreAcquired(state)).toBe(false);

            await expect(manager.stopWatching()).rejects.toThrow("Storage event store was not acquired before stopping");
            await expect(restoring).resolves.toBeUndefined();
            expect(isManagerStopped(state)).toBe(true);
            expect(storage.commit).not.toHaveBeenCalled();
            expect(process).not.toHaveBeenCalled();
            expect(keys(storage.contents())).toEqual(["preexisting"]);

            const replacement = runtime(storage.adapter);
            await replacement.manager.restoreState();
            expect(keys(replacement.process.mock.calls.map(([item]) => item))).toEqual(["preexisting"]);
            expect(storage.contents()).toEqual([]);
        }
    );

    it.each(modes)(
        "restores valid %s queues and rejects sparse snapshots without Object.hasOwn (iOS 15.0-15.3 compatibility)",
        async (mode) => {
            const withoutHasOwn = async <T>(work: () => Promise<T>): Promise<T> => {
                const originalHasOwn = Object.hasOwn;
                Object.defineProperty(Object, "hasOwn", { value: undefined, configurable: true, writable: true });
                try {
                    return await work();
                } finally {
                    Object.defineProperty(Object, "hasOwn", {
                        value: originalHasOwn,
                        configurable: true,
                        writable: true,
                    });
                }
            };

            const valid = event("ios15-valid");
            const storage = store(mode, [valid]);
            const { manager, process } = runtime(storage.adapter);
            await withoutHasOwn(() => manager.restoreState());
            expect(keys(process.mock.calls.map(([item]) => item))).toEqual(["ios15-valid"]);
            expect(storage.contents()).toEqual([]);
            await manager.stopWatching();

            const sparseStorage = store(mode);
            if (mode === "incremental") {
                const sparseRecords: StorageEventSnapshotRecord[] = [
                    { id: "000000000001", event: event("first") },
                    { id: "000000000002", event: event("second") },
                ];
                Reflect.deleteProperty(sparseRecords, 0);
                sparseStorage.loadSnapshotEntries.mockResolvedValueOnce(sparseRecords);
            } else {
                const sparseEvents: QueuedFileEvent[] = [event("first"), event("second")];
                Reflect.deleteProperty(sparseEvents, 0);
                sparseStorage.loadSnapshot.mockResolvedValueOnce(sparseEvents);
            }
            const corrupt = runtime(sparseStorage.adapter);
            await expect(withoutHasOwn(() => corrupt.manager.restoreState())).rejects.toThrow("Invalid storage event");
            expect(isStoreAcquired(corrupt.state)).toBe(false);
            await corrupt.manager.stopWatching();
        }
    );

    it("does not clobber an overlapping retry or re-read on synchronous re-entrant restoreState()", async () => {
        const storage = store("incremental", [event("once")]);
        const failure = new Error("transient load failure");
        const secondRead = promiseWithResolvers<StorageEventSnapshotRecord[]>();
        let reentrant: Promise<void> | undefined;
        let watching: Promise<void> | undefined;
        let manager!: ReturnType<typeof runtime>["manager"];
        storage.loadSnapshotEntries
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce(() => {
                // Call beginWatch() before re-entrant restoreState() so it exercises reading the active
                // restore promise before snapShotRestored is refreshed.
                watching = manager.beginWatch();
                reentrant = manager.restoreState();
                return secondRead.promise;
            });
        const built = runtime(storage.adapter);
        manager = built.manager;

        const first = manager.restoreState();
        const firstSettled = expect(first).rejects.toBe(failure);
        const retry = first.catch(() => manager.restoreState());
        await firstSettled;
        const third = manager.restoreState();
        expect(reentrant).toBeDefined();
        expect(third).toBe(reentrant);
        await Promise.resolve();
        expect(built.watcher).not.toHaveBeenCalled();

        secondRead.resolve([{ id: "000000000001", event: event("once") }]);
        await Promise.all([retry, third, reentrant, watching]);
        expect(storage.loadSnapshotEntries).toHaveBeenCalledTimes(2);
        expect(built.process).toHaveBeenCalledTimes(1);
        expect(built.watcher).toHaveBeenCalledTimes(1);
        expect(storage.contents()).toEqual([]);
        await manager.stopWatching();
    });

    it("waits for a replacement store restore started while beginWatch() was awaiting an older replay retry", async () => {
        const storage = store("incremental", [event("initial")]);
        const { manager, watcher, process } = runtime(storage.adapter);
        const replayFailure = new Error("replay dispatch failed");
        const runSpy = vi
            .spyOn(manager as unknown as { runQueuedEvents: (opts?: unknown) => Promise<void> }, "runQueuedEvents")
            .mockRejectedValueOnce(replayFailure);
        await expect(manager.restoreState()).rejects.toBe(replayFailure);
        runSpy.mockRestore();

        const firstStarted = promiseWithResolvers<void>();
        const finishFirst = promiseWithResolvers<boolean>();
        process.mockImplementationOnce(async () => {
            firstStarted.resolve();
            return await finishFirst.promise;
        });

        const retrying = manager.restoreState();
        const watching = manager.beginWatch();
        await firstStarted.promise;

        const replacementRead = promiseWithResolvers<StorageEventSnapshotRecord[]>();
        storage.loadSnapshotEntries.mockReturnValueOnce(replacementRead.promise);
        manager.resetPersistenceState();
        const replacementRestore = manager.restoreState();

        finishFirst.resolve(true);
        await retrying;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(watcher).not.toHaveBeenCalled();

        replacementRead.resolve([]);
        await Promise.all([replacementRestore, watching]);
        expect(watcher).toHaveBeenCalledTimes(1);
        await manager.stopWatching();
    });

    it("does not register the host watcher when beginStopWatching() is called in the same turn as beginWatch()", async () => {
        const storage = store("incremental");
        const { manager, watcher } = runtime(storage.adapter);

        const watching = manager.beginWatch();
        manager.beginStopWatching();
        await watching;
        expect(watcher).not.toHaveBeenCalled();
        await manager.stopWatching();
    });

    it("aligns retry restoreState() and beginWatch() after a post-acquisition replay failure without re-reading storage", async () => {
        const storage = store("incremental", [event("acquired")]);
        const { manager, watcher, process, state } = runtime(storage.adapter);
        const replayFailure = new Error("replay dispatch failed");
        const runSpy = vi
            .spyOn(manager as unknown as { runQueuedEvents: (opts?: unknown) => Promise<void> }, "runQueuedEvents")
            .mockRejectedValueOnce(replayFailure);

        await expect(manager.restoreState()).rejects.toBe(replayFailure);
        expect(isStoreAcquired(state)).toBe(true);
        await expect(manager.beginWatch()).rejects.toBe(replayFailure);
        expect(watcher).not.toHaveBeenCalled();

        runSpy.mockRestore();
        await expect(manager.restoreState()).resolves.toBeUndefined();
        await expect(manager.beginWatch()).resolves.toBeUndefined();
        expect(storage.loadSnapshotEntries).toHaveBeenCalledTimes(1);
        expect(process).toHaveBeenCalledTimes(1);
        expect(watcher).toHaveBeenCalledTimes(1);
        await manager.stopWatching();
    });
});
