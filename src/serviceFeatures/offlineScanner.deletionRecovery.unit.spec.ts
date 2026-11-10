import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import { TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { FullScanModes, synchroniseAllFilesBetweenDBandStorage } from "./offlineScanner";

function fixture(present = true) {
    const path = "retained-deletion.md";
    const file = { path, name: path, stat: { type: "file", size: 4, mtime: 10000, ctime: 10000 } };
    const doc = {
        _id: path,
        _rev: "2-deleted",
        path,
        type: "newnote",
        deleted: true,
        children: [],
        size: 4,
        mtime: 20000,
    };
    const docs = [doc];
    const files = new Map(present ? [[path, file]] : []);
    let persisted: Record<string, number> = present ? {} : { [path]: 10000 };
    const paths = new Set([path]);
    const recoverDatabaseDeletion = vi.fn(async (target: { path: string }, cleanupOnly = false) => {
        if (!cleanupOnly) files.delete(target.path);
        paths.delete(target.path);
        return { status: "applied", file: "absent", provenance: "cleared", reason: "completed" };
    });
    const listDeletionRecoveryPaths = vi.fn(async () => [...paths]);
    const set = vi.fn(async (_key: string, value: Record<string, number>) => {
        persisted = { ...value };
    });
    const settings = { ...DEFAULT_SETTINGS, handleFilenameCaseSensitive: true };
    const host = {
        services: {
            context: createServiceContext(),
            setting: { currentSettings: () => settings },
            vault: { isTargetFile: async () => true, isValidPath: () => true, isFileSizeTooLarge: () => false },
            path: {
                getPath: (d: typeof doc) => d.path,
                path2id: async (p: string) => p,
                compareFileFreshness: () => TARGET_IS_NEW,
            },
            database: {
                localDatabase: {
                    findAllNormalDocs: async function* () {
                        yield* docs;
                    },
                },
            },
            keyValueDB: { kvDB: { get: async () => persisted, set } },
        },
        serviceModules: {
            storageAccess: { getFiles: async () => [...files.values()] },
            fileHandler: { supportsDeletionRecovery: () => true, recoverDatabaseDeletion, listDeletionRecoveryPaths },
        },
    };
    return {
        host,
        files,
        paths,
        recoverDatabaseDeletion,
        listDeletionRecoveryPaths,
        set,
        persisted: () => persisted,
        doc,
        docs,
        settings,
    };
}

afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
});

describe("ordinary scan deletion recovery", () => {
    it("applies a retained newer deletion after its received snapshot has disappeared", async () => {
        vi.useFakeTimers();
        const f = fixture();
        await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });
        expect(f.files.size).toBe(0);
        expect(f.recoverDatabaseDeletion).toHaveBeenCalledExactlyOnceWith(f.doc, false);
        expect(f.listDeletionRecoveryPaths).not.toHaveBeenCalled();
        expect(f.persisted()).toEqual({});
    });
});

describe("recovery bookkeeping and scope", () => {
    it("clears interrupted absent-file bookkeeping without another physical removal", async () => {
        vi.useFakeTimers();
        const f = fixture(false);
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(true);
        expect(f.recoverDatabaseDeletion).toHaveBeenCalledExactlyOnceWith(f.doc, true);
        expect(f.listDeletionRecoveryPaths).toHaveBeenCalledTimes(1);
        expect(f.persisted()).toEqual({});
        expect(f.set).toHaveBeenCalledTimes(1);
    });
    it("keeps the observed mtime on deferral instead of acknowledging the deletion", async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.recoverDatabaseDeletion.mockResolvedValue({
            status: "deferred",
            file: "present",
            provenance: "unchanged",
            reason: "changed",
        });
        await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });
        expect(f.files.size).toBe(1);
        expect(f.persisted()).toEqual({ [f.doc.path]: 10000 });
    });
    it("retains observation when verification throws and continues normal startup", async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.recoverDatabaseDeletion.mockRejectedValue(new Error("injected read failure"));
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
                continueOnFileFailure: true,
            })
        ).toBe("completed-with-file-failures");
        expect(f.files.size).toBe(1);
        expect(f.persisted()).toEqual({ [f.doc.path]: 10000 });
    });
    it("rediscovers pending provenance after a physically successful deletion", async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.recoverDatabaseDeletion.mockImplementationOnce(async () => {
            f.files.clear();
            return { status: "failed", file: "absent", provenance: "pending", reason: "cleanup" };
        });
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(false);
        expect(f.persisted()).toEqual({});
        expect(f.paths.size).toBe(1);
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(true);
        expect(f.recoverDatabaseDeletion).toHaveBeenLastCalledWith(f.doc, true);
        expect(f.paths.size).toBe(0);
    });
    it("reports enumeration failure without inventing cleanup completion", async () => {
        vi.useFakeTimers();
        const f = fixture(false);
        f.listDeletionRecoveryPaths.mockRejectedValue(new Error("keys failed"));
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(false);
        expect(f.recoverDatabaseDeletion).not.toHaveBeenCalled();
        expect(f.paths.size).toBe(1);
    });
    it("reports an ordered map flush failure separately from physical removal", async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.set.mockRejectedValueOnce(new Error("flush failed"));
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(false);
        expect(f.files.size).toBe(0);
    });
    it("writes the map once for a large deletion backlog", async () => {
        vi.useFakeTimers();
        const f = fixture();
        for (let i = 0; i < 99; i++) {
            const path = `backlog-${i}.md`;
            f.docs.push({ ...f.doc, path, _id: path });
            f.files.set(path, { ...f.files.get(f.doc.path)!, path });
            f.paths.add(path);
        }
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
            })
        ).toBe(true);
        expect(f.files.size).toBe(0);
        expect(f.recoverDatabaseDeletion).toHaveBeenCalledTimes(100);
        expect(f.set).toHaveBeenCalledTimes(1);
        expect(f.persisted()).toEqual({});
    });
    it("keeps hosts without the capability and explicit DB_APPLY on their existing policy", async () => {
        vi.useFakeTimers();
        const f = fixture();
        f.host.serviceModules.fileHandler.supportsDeletionRecovery = () => false;
        await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
            mode: FullScanModes.NEWER_WINS,
        });
        f.host.serviceModules.fileHandler.supportsDeletionRecovery = () => true;
        await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
            mode: FullScanModes.DB_APPLY,
        });
        expect(f.recoverDatabaseDeletion).not.toHaveBeenCalled();
        expect(f.files.size).toBe(1);
    });
});

it("flushes a previous mode's pending observation before the next scan reloads it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.doc.deleted = false;
    const deleteFileFromDB = vi.fn(async () => true);
    Object.assign(f.host.serviceModules.fileHandler, {
        dbToStorage: vi.fn(async () => true),
        deleteFileFromDB,
    });
    await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, { mode: FullScanModes.DB_APPLY });
    f.files.clear();
    await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, { mode: FullScanModes.NEWER_WINS });
    expect(deleteFileFromDB).toHaveBeenCalledExactlyOnceWith(f.doc.path);
});

it("retains post-removal warning and cause in scan diagnostics", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cause = new Error("parent cleanup failed");
    f.recoverDatabaseDeletion.mockImplementationOnce(async () => ({
        status: "applied",
        file: "absent",
        provenance: "cleared",
        reason: "deletion-confirmed",
        warning: "storage-post-removal-error",
        error: cause,
    }));
    const log = vi.fn();
    await synchroniseAllFilesBetweenDBandStorage(f.host as any, log, {} as any, { mode: FullScanModes.NEWER_WINS });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("storage-post-removal-error"), expect.anything());
    expect(log).toHaveBeenCalledWith(cause, expect.anything());
});

it.each([false, true])(
    "rechecks live suspension before recovery with ignoreSuspending=%s",
    async (ignoreSuspending) => {
        vi.useFakeTimers();
        const f = fixture();
        f.host.serviceModules.fileHandler.supportsDeletionRecovery = () => {
            f.settings.suspendFileWatching = true;
            return true;
        };
        expect(
            await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
                mode: FullScanModes.NEWER_WINS,
                ignoreSuspending,
            })
        ).toBe(true);
        expect(f.files.has(f.doc.path)).toBe(!ignoreSuspending);
        expect(f.recoverDatabaseDeletion).toHaveBeenCalledTimes(ignoreSuspending ? 1 : 0);
        expect(f.listDeletionRecoveryPaths).not.toHaveBeenCalled();
    }
);

it("quarantines mismatched Metadata before classifying its file as storage-only", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.doc._id = "mismatched-metadata";
    const storeFileToDB = vi.fn(async () => true);
    Object.assign(f.host.serviceModules.fileHandler, { storeFileToDB });
    expect(
        await synchroniseAllFilesBetweenDBandStorage(f.host as any, vi.fn(), {} as any, {
            mode: FullScanModes.NEWER_WINS,
        })
    ).toBe(true);
    expect(f.files.has(f.doc.path)).toBe(true);
    expect(f.doc._rev).toBe("2-deleted");
    expect(storeFileToDB).not.toHaveBeenCalled();
    expect(f.recoverDatabaseDeletion).not.toHaveBeenCalled();
    expect(f.listDeletionRecoveryPaths).not.toHaveBeenCalled();
});
