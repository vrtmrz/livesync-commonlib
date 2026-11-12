import { describe, expect, it, vi } from "vitest";
import { ServiceFileAccessBase } from "./ServiceFileAccessBase";
import type { FilePath, FilePathWithPrefix } from "@lib/common/types";
import type { PathComparisonSettings } from "@lib/platform/pathTypes.ts";

type MockFolder = {
    kind: "folder";
    path: string;
    parent: MockFolder | null;
    children: MockNode[];
};

type MockFile = {
    kind: "file";
    path: string;
    parent: MockFolder;
};

type MockNode = MockFolder | MockFile;

describe("ServiceFileAccessBase deletion recursion", () => {
    it("does not delete parent folder when siblings still exist", async () => {
        const root: MockFolder = { kind: "folder", path: "/", parent: null, children: [] };
        const folder: MockFolder = { kind: "folder", path: "A.inbox", parent: root, children: [] };
        const target: MockFile = { kind: "file", path: "A.inbox/target.md", parent: folder };
        const sibling: MockFile = { kind: "file", path: "A.inbox/sibling.md", parent: folder };

        root.children = [folder];
        folder.children = [target, sibling];

        const nodes = new Map<string, MockNode>([
            [root.path, root],
            [folder.path, folder],
            [target.path, target],
            [sibling.path, sibling],
        ]);

        const removeNode = (node: MockNode) => {
            nodes.delete(node.path);
            if (node.parent) {
                node.parent.children = node.parent.children.filter((child) => child.path !== node.path);
            }
        };

        const trashedPaths: string[] = [];
        const vaultAccess = {
            getPath: (file: MockNode) => file.path,
            getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
            isFile: (item: unknown): item is MockFile => !!item && (item as MockNode).kind === "file",
            isFolder: (item: unknown): item is MockFolder => !!item && (item as MockNode).kind === "folder",
            trash: vi.fn(async (item: MockNode) => {
                trashedPaths.push(item.path);
                removeNode(item);
                return await Promise.resolve();
            }),
            delete: vi.fn(async (item: MockNode) => {
                removeNode(item);
                return await Promise.resolve();
            }),
        };

        const service = new ServiceFileAccessBase<any>({
            API: { addLog: vi.fn() } as any,
            appLifecycle: { onFirstInitialise: { addHandler: vi.fn() }, onBeforeUnload: { addHandler: vi.fn() } } as any,
            fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } } as any,
            vault: { isTargetFile: vi.fn().mockResolvedValue(true) } as any,
            setting: {
                currentSettings: vi.fn().mockReturnValue({
                    trashInsteadDelete: true,
                    doNotDeleteFolder: false,
                }),
            } as any,
            storageEventManager: {
                beginWatch: vi.fn(),
                appendQueue: vi.fn(),
                isWaiting: vi.fn(),
                waitForIdle: vi.fn(),
                restoreState: vi.fn(),
            } as any,
            storageAccessManager: {} as any,
            vaultAccess: vaultAccess as any,
        });

        await service.deleteVaultItem(target.path as FilePathWithPrefix);

        expect(trashedPaths).toContain(target.path);
        expect(trashedPaths).not.toContain(folder.path);
        expect(nodes.has(sibling.path)).toBe(true);
    });
});

describe("ServiceFileAccessBase readFileAuto", () => {
    function createServiceForRead(vaultAccessOverrides: Record<string, unknown>) {
        const vaultAccess = {
            getAbstractFileByPath: vi.fn(async () => await Promise.resolve({ kind: "file", path: "assets/image.png" })),
            isFile: vi.fn((item: unknown) => !!item && (item as { kind?: string }).kind === "file"),
            vaultReadAuto: vi.fn(async () => await Promise.resolve(new ArrayBuffer(0))),
            vaultRead: vi.fn(async () => await Promise.resolve("")),
            ...vaultAccessOverrides,
        };

        const service = new ServiceFileAccessBase<any>({
            API: { addLog: vi.fn() } as any,
            appLifecycle: { onFirstInitialise: { addHandler: vi.fn() }, onBeforeUnload: { addHandler: vi.fn() } } as any,
            fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } } as any,
            vault: { isTargetFile: vi.fn().mockResolvedValue(true) } as any,
            setting: {
                currentSettings: vi.fn().mockReturnValue({
                    trashInsteadDelete: true,
                    doNotDeleteFolder: false,
                }),
            } as any,
            storageEventManager: {
                beginWatch: vi.fn(),
                appendQueue: vi.fn(),
                isWaiting: vi.fn(),
                waitForIdle: vi.fn(),
                restoreState: vi.fn(),
            } as any,
            storageAccessManager: {} as any,
            vaultAccess: vaultAccess as any,
        });

        return { service, vaultAccess };
    }

    it("reads binary files through vaultReadAuto", async () => {
        const expected = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]).buffer;
        const { service, vaultAccess } = createServiceForRead({
            getAbstractFileByPath: vi.fn(async () => await Promise.resolve({ kind: "file", path: "assets/image.png" })),
            vaultReadAuto: vi.fn(async () => await Promise.resolve(expected)),
            vaultRead: vi.fn(() => {
                throw new Error("vaultRead should not be used by readFileAuto");
            }),
        });

        const result = await service.readFileAuto("assets/image.png");

        expect(result).toBe(expected);
        expect(vaultAccess.vaultReadAuto).toHaveBeenCalledTimes(1);
        expect(vaultAccess.vaultRead).not.toHaveBeenCalled();
    });

    it("reads markdown files through vaultReadAuto", async () => {
        const expected = "# hello";
        const { service, vaultAccess } = createServiceForRead({
            getAbstractFileByPath: vi.fn(async () => await Promise.resolve({ kind: "file", path: "notes/test.md" })),
            vaultReadAuto: vi.fn(async () => await Promise.resolve(expected)),
            vaultRead: vi.fn(() => {
                throw new Error("vaultRead should not be used by readFileAuto");
            }),
        });

        const result = await service.readFileAuto("notes/test.md");

        expect(result).toBe(expected);
        expect(vaultAccess.vaultReadAuto).toHaveBeenCalledTimes(1);
        expect(vaultAccess.vaultRead).not.toHaveBeenCalled();
    });
});

describe("ServiceFileAccessBase renameFile", () => {
    it("renames through the vault adapter and marks the target as touched", async () => {
        const nativeFile = {
            kind: "file",
            path: "Calculus.md",
            stat: { ctime: 1, mtime: 2, size: 4, type: "file" },
        };
        const vaultAccess = {
            getAbstractFileByPath: vi.fn().mockResolvedValue(nativeFile),
            isFile: vi.fn((item: unknown) => !!item && (item as { kind?: string }).kind === "file"),
            vaultRename: vi.fn(async (file: typeof nativeFile, newPath: string) => {
                file.path = newPath;
                return file;
            }),
            nativeFileToUXFileInfoStub: vi.fn((file: typeof nativeFile) => ({
                name: file.path.split("/").pop() ?? file.path,
                path: file.path as FilePath,
                stat: file.stat,
            })),
            touch: vi.fn().mockResolvedValue(undefined),
        };
        const service = new ServiceFileAccessBase<any>({
            API: { addLog: vi.fn() } as any,
            appLifecycle: { onFirstInitialise: { addHandler: vi.fn() }, onBeforeUnload: { addHandler: vi.fn() } } as any,
            fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } } as any,
            vault: { isTargetFile: vi.fn().mockResolvedValue(true) } as any,
            setting: { currentSettings: vi.fn().mockReturnValue({}) } as any,
            storageEventManager: {
                beginWatch: vi.fn(),
                appendQueue: vi.fn(),
                isWaiting: vi.fn(),
                waitForIdle: vi.fn(),
                restoreState: vi.fn(),
            } as any,
            storageAccessManager: {} as any,
            vaultAccess: vaultAccess as any,
        });

        await expect(
            service.renameFile("Calculus.md" as FilePathWithPrefix, "calculus.md" as FilePathWithPrefix)
        ).resolves.toEqual(expect.objectContaining({ path: "calculus.md" }));

        expect(vaultAccess.vaultRename).toHaveBeenCalledWith(nativeFile, "calculus.md");
        expect(vaultAccess.touch).toHaveBeenCalledWith("calculus.md");
    });
});


describe("ServiceFileAccessBase local completion lifecycle", () => {
    function fixture(stopWatching?: () => Promise<void>) {
        const waitForIdle = vi.fn(async () => {});
        let beforeUnload: (() => Promise<boolean>) | undefined;
        const service = new ServiceFileAccessBase<any>({
            API: { addLog: vi.fn() } as any,
            appLifecycle: {
                onFirstInitialise: { addHandler: vi.fn() },
                onBeforeUnload: { addHandler: vi.fn((handler) => { beforeUnload = handler; }) },
            } as any,
            fileProcessing: { commitPendingFileEvents: { addHandler: vi.fn() } } as any,
            vault: {} as any,
            setting: {} as any,
            storageEventManager: { stopWatching, waitForIdle } as any,
            storageAccessManager: {} as any,
            vaultAccess: {} as any,
        });
        return { service, waitForIdle, getBeforeUnload: () => beforeUnload };
    }

    it("retains completion for existing custom managers without the optional shutdown method", async () => {
        const { waitForIdle, getBeforeUnload } = fixture();
        await expect(getBeforeUnload()!()).resolves.toBe(true);
        expect(waitForIdle).toHaveBeenCalledOnce();
    });

    it("awaits watcher shutdown before permitting lifecycle storage closure", async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => { finish = resolve; });
        const stop = vi.fn(() => pending);
        const { getBeforeUnload } = fixture(stop);
        const beforeUnload = getBeforeUnload();
        expect(beforeUnload).toBeDefined();
        let settled = false;
        const unloading = beforeUnload!().then(() => { settled = true; });
        try {
            await Promise.resolve();
            expect(stop).toHaveBeenCalledOnce();
            expect(settled).toBe(false);
        } finally {
            finish();
            await unloading;
        }
    });

    it("preserves a snapshot-write failure at the lifecycle boundary", async () => {
        const { getBeforeUnload } = fixture(async () => { throw new Error("Snapshot unavailable"); });
        expect(getBeforeUnload()).toBeDefined();
        await expect(getBeforeUnload()!()).rejects.toThrow("Snapshot unavailable");
    });
});

describe("ServiceFileAccessBase file-name lookup", () => {
    function createFileNameService(
        getFileNames: (options?: { fresh?: boolean }) => Promise<FilePath[]>,
        indexedLookup?: (path: FilePath, policy: PathComparisonSettings) => Promise<readonly FilePath[]> | undefined
    ) {
        const fileProcessing = {
            totalStorageFileEventCount: 0,
            commitPendingFileEvents: { addHandler: vi.fn() },
        };
        const vaultAccess = {
            getFileNames,
            findPathIdentityCandidates: indexedLookup ?? (() => undefined),
        };
        const service = new ServiceFileAccessBase<any>({
            API: { addLog: vi.fn() } as any,
            appLifecycle: {
                onFirstInitialise: { addHandler: vi.fn() },
                onBeforeUnload: { addHandler: vi.fn() },
            } as any,
            fileProcessing: fileProcessing as any,
            vault: {} as any,
            setting: {} as any,
            storageEventManager: {} as any,
            storageAccessManager: {} as any,
            vaultAccess: vaultAccess as any,
        });
        return { service, fileProcessing, vaultAccess };
    }

    const caseInsensitivePolicy = { pathNormalizationVersion: 0 as const, handleFilenameCaseSensitive: false };

    it("forwards candidate queries when the adapter supplies a lookup", async () => {
        const candidates = ["A.md"] as FilePath[];
        const indexedLookup = vi.fn(async () => candidates);
        const getFileNames = vi.fn(async () => [] as FilePath[]);
        const { service } = createFileNameService(getFileNames, indexedLookup);

        await expect(service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy)).resolves.toEqual(
            candidates
        );
        expect(indexedLookup).toHaveBeenCalledWith("a.md", caseInsensitivePolicy);
        expect(getFileNames).not.toHaveBeenCalled();
    });

    it("caches fallback candidates by event count and effective comparison policy", async () => {
        const names = ["A.md"] as FilePath[];
        const getFileNames = vi.fn(async () => [...names]);
        const { service, fileProcessing } = createFileNameService(getFileNames);

        await expect(service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy)).resolves.toEqual([
            "A.md",
        ]);
        await service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy);
        expect(getFileNames).toHaveBeenCalledOnce();

        names.push("a.md" as FilePath);
        await expect(service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy)).resolves.toEqual([
            "A.md",
        ]);
        fileProcessing.totalStorageFileEventCount++;
        await expect(service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent fallback reads with the same cache key", async () => {
        let resolveNames!: (paths: FilePath[]) => void;
        const pendingNames = new Promise<FilePath[]>((resolve) => {
            resolveNames = resolve;
        });
        const getFileNames = vi.fn(() => pendingNames);
        const { service } = createFileNameService(getFileNames);

        const first = service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy);
        const second = service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy);
        expect(getFileNames).toHaveBeenCalledOnce();
        resolveNames(["A.md"] as FilePath[]);

        await expect(Promise.all([first, second])).resolves.toEqual([["A.md"], ["A.md"]]);
    });

    it("does not publish an older in-flight fallback map after a fresh listing", async () => {
        let resolveOldNames!: (paths: FilePath[]) => void;
        const oldNames = new Promise<FilePath[]>((resolve) => {
            resolveOldNames = resolve;
        });
        let currentNames = ["A.md"] as FilePath[];
        let ordinaryReads = 0;
        const getFileNames = vi.fn(async (options?: { fresh?: boolean }) => {
            if (options?.fresh) {
                return [...currentNames];
            }
            ordinaryReads++;
            return ordinaryReads === 1 ? await oldNames : [...currentNames];
        });
        const { service } = createFileNameService(getFileNames);

        const oldLookup = service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy);
        currentNames = ["A.md", "a.md"] as FilePath[];
        await expect(service.getFileNames({ fresh: true })).resolves.toEqual(currentNames);
        resolveOldNames(["A.md"] as FilePath[]);
        await expect(oldLookup).resolves.toEqual(["A.md"]);

        await expect(service.findPathIdentityCandidates("a.md" as FilePath, caseInsensitivePolicy)).resolves.toEqual([
            "A.md",
            "a.md",
        ]);
        expect(getFileNames).toHaveBeenCalledTimes(3);
    });
});
