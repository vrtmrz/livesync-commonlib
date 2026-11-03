import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilePath, StoragePath } from "../pathTypes.ts";
import { NodeStorageAdapter } from "./storage.ts";
import { UnicodeResolvingNodeStorageAdapter } from "./UnicodeResolvingNodeStorageAdapter.ts";

function storagePath(value: string): StoragePath {
    return value as StoragePath;
}

describe("Node storage strict physical paths", () => {
    const tempDirs: string[] = [];

    async function createRoot() {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "commonlib-node-storage-"));
        tempDirs.push(root);
        return root;
    }

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
    });

    it("returns exact immediate entries and distinguishes absence from non-directory errors", async () => {
        const root = await createRoot();
        await fs.mkdir(path.join(root, "folder"));
        await fs.writeFile(path.join(root, "note.md"), "content");
        const storage = new NodeStorageAdapter(root);

        const entries = await storage.readDirectory(storagePath(""));
        expect(entries).toEqual(
            expect.arrayContaining([
                { name: "folder", kind: "directory" },
                { name: "note.md", kind: "file" },
            ])
        );
        expect(entries).toHaveLength(2);
        await expect(storage.readDirectory(storagePath("missing"))).resolves.toBeNull();
        await expect(storage.statResolved(storagePath("missing"))).resolves.toBeNull();
        await expect(storage.statResolved(storagePath("folder"))).resolves.toMatchObject({ type: "folder" });
        await expect(storage.readDirectory(storagePath("note.md"))).rejects.toMatchObject({ code: "ENOTDIR" });
        await expect(storage.statResolved(storagePath("note.md/child"))).rejects.toMatchObject({ code: "ENOTDIR" });
    });

    it("supports typed physical operation ports", async () => {
        const root = await createRoot();
        const storage = new NodeStorageAdapter(root);
        const folder = storagePath("folder");
        const textPath = storagePath("folder/note.md");
        const binaryPath = storagePath("folder/data.bin");
        const renamedPath = storagePath("folder/renamed.md");

        await storage.mkdirResolved(folder);
        await storage.writeResolved(textPath, "before");
        await storage.appendResolved(textPath, " after");
        await expect(storage.readResolved(textPath)).resolves.toBe("before after");
        await expect(storage.statResolved(textPath)).resolves.toMatchObject({ type: "file" });

        const bytes = new Uint8Array([1, 2, 3]).buffer;
        await storage.writeBinaryResolved(binaryPath, bytes);
        await expect(storage.readBinaryResolved(binaryPath)).resolves.toEqual(bytes);
        await storage.renameResolved(textPath, renamedPath);
        await storage.removeResolved(renamedPath);

        await expect(storage.statResolved(renamedPath)).resolves.toBeNull();
        await expect(storage.readDirectory(folder)).resolves.toEqual([{ name: "data.bin", kind: "file" }]);
    });

    it.skipIf(process.platform === "win32")("does not enumerate or follow symbolic links", async () => {
        const root = await createRoot();
        const outside = await createRoot();
        await fs.writeFile(path.join(outside, "secret.md"), "outside");
        await fs.symlink(outside, path.join(root, "linked"), "dir");
        const storage = new NodeStorageAdapter(root);

        await expect(storage.readDirectory(storagePath(""))).resolves.toEqual([]);
        await expect(storage.statResolved(storagePath("linked/secret.md"))).rejects.toThrow(/symbolic links/i);
        await expect(fs.readFile(path.join(outside, "secret.md"), "utf8")).resolves.toBe("outside");
    });
});

describe("UnicodeResolvingNodeStorageAdapter", () => {
    const tempDirs: string[] = [];

    async function createRoot() {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "commonlib-node-unicode-"));
        tempDirs.push(root);
        return root;
    }

    function createAdapter(root: string, version = 1, caseInsensitive = false) {
        return new UnicodeResolvingNodeStorageAdapter(
            root,
            () => version,
            () => caseInsensitive
        );
    }

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
    });

    it("reads, updates, and deletes an NFD file through its NFC path", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const nameNfd = "Ångström.md".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, nameNfd), "before");
        const storage = createAdapter(root);

        await expect(storage.read("café/Ångström.md")).resolves.toBe("before");
        await storage.write("café/Ångström.md", "after");
        await expect(fs.readFile(path.join(root, folderNfd, nameNfd), "utf8")).resolves.toBe("after");
        expect(await fs.readdir(root)).toEqual([folderNfd]);

        await storage.remove("café/Ångström.md");

        await expect(fs.readdir(path.join(root, folderNfd))).resolves.toEqual([]);
        await expect(storage.read("café/Ångström.md")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.skipIf(process.platform === "win32")("rejects symlink paths before NFC lookup reports them as absent", async () => {
        const root = await createRoot();
        const outside = await createRoot();
        await fs.writeFile(path.join(outside, "secret.md"), "outside");
        await fs.writeFile(path.join(root, "regular.md"), "regular");
        await fs.symlink(outside, path.join(root, "linked"), "dir");
        await fs.symlink(path.join(outside, "secret.md"), path.join(root, "unrelated.md"), "file");
        const storage = createAdapter(root);

        await expect(storage.exists("linked/secret.md")).rejects.toThrow(/symbolic links/i);
        await expect(storage.read("linked/secret.md")).rejects.toThrow(/symbolic links/i);
        await expect(
            storage.resolveLogicalPath("linked/secret.md" as FilePath, undefined, false)
        ).rejects.toThrow(/symbolic links/i);
        await expect(storage.readDirectory(storagePath(""))).resolves.toEqual([
            { name: "regular.md", kind: "file" },
        ]);
        await expect(storage.read("regular.md")).resolves.toBe("regular");
        await expect(fs.readFile(path.join(outside, "secret.md"), "utf8")).resolves.toBe("outside");
    });

    it("keeps existing parent spelling and requested spelling for new components", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const newDirectoryNfd = "Étage".normalize("NFD");
        const newFileNfd = "résumé.md".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        const storage = createAdapter(root);

        await storage.mkdir("café/" + newDirectoryNfd);
        await storage.write("café/" + newDirectoryNfd + "/" + newFileNfd, "created");

        await expect(fs.readdir(root)).resolves.toEqual([folderNfd]);
        await expect(fs.readdir(path.join(root, folderNfd))).resolves.toEqual([newDirectoryNfd]);
        await expect(fs.readFile(path.join(root, folderNfd, newDirectoryNfd, newFileNfd), "utf8")).resolves.toBe(
            "created"
        );
        await expect(storage.read("café/Étage/" + newFileNfd)).resolves.toBe("created");
    });

    it("preserves an explicitly requested Unicode spelling change during rename", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const nameNfd = "Ångström.md".normalize("NFD");
        const nameNfc = "Ångström.md";
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, nameNfd), "content");
        const storage = createAdapter(root);

        await storage.rename("café/" + nameNfd, "café/" + nameNfc);

        await expect(fs.readdir(path.join(root, folderNfd))).resolves.toEqual([nameNfc]);
        await expect(fs.readFile(path.join(root, folderNfd, nameNfc), "utf8")).resolves.toBe("content");
    });

    it("rejects exact NFC/NFD file collisions before reading", async () => {
        const root = await createRoot();
        const nameNfc = "café.md";
        const nameNfd = nameNfc.normalize("NFD");
        await fs.writeFile(path.join(root, nameNfc), "NFC");
        await fs.writeFile(path.join(root, nameNfd), "NFD");
        const storage = createAdapter(root);

        await expect(storage.read(nameNfc)).rejects.toThrow(/ambiguous/i);
        await expect(fs.readFile(path.join(root, nameNfc), "utf8")).resolves.toBe("NFC");
        await expect(fs.readFile(path.join(root, nameNfd), "utf8")).resolves.toBe("NFD");
    });

    it("rejects NFC-equivalent directory collisions during a full listing", async () => {
        const root = await createRoot();
        const nameNfc = "café";
        const nameNfd = nameNfc.normalize("NFD");
        await fs.mkdir(path.join(root, nameNfc));
        await fs.mkdir(path.join(root, nameNfd));
        const storage = createAdapter(root);

        await expect(storage.listExact(storagePath(""))).rejects.toThrow(/ambiguous/i);
    });

    it("rejects file and directory collisions before creating children", async () => {
        const root = await createRoot();
        const nameNfc = "café";
        const nameNfd = nameNfc.normalize("NFD");
        await fs.writeFile(path.join(root, nameNfc), "file");
        await fs.mkdir(path.join(root, nameNfd));
        const storage = createAdapter(root);

        await expect(storage.write(nameNfc + "/child.md", "new")).rejects.toThrow(/ambiguous/i);
        await expect(fs.readdir(path.join(root, nameNfd))).resolves.toEqual([]);
        await expect(fs.readFile(path.join(root, nameNfc), "utf8")).resolves.toBe("file");
    });

    it("observes an alias added after a previous successful lookup", async () => {
        const root = await createRoot();
        const nameNfc = "café.md";
        const nameNfd = nameNfc.normalize("NFD");
        await fs.writeFile(path.join(root, nameNfd), "NFD");
        const storage = createAdapter(root);

        await expect(storage.read(nameNfc)).resolves.toBe("NFD");
        await fs.writeFile(path.join(root, nameNfc), "NFC");

        await expect(storage.read(nameNfc)).rejects.toThrow(/ambiguous/i);
    });

    it("keeps exact stat and list methods on the physical-path boundary", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const nameNfd = "note.md".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, nameNfd), "content");
        const storage = createAdapter(root);
        const logicalPath = "café/note.md" as FilePath;
        const resolvedPath: StoragePath | null = await storage.resolveLogicalPath(logicalPath, false, false);

        expect(resolvedPath).toBe(folderNfd + "/" + nameNfd);
        await expect(storage.statExact(storagePath("café/note.md"))).resolves.toBeNull();
        await expect(storage.statExact(storagePath(folderNfd + "/" + nameNfd))).resolves.toMatchObject({
            type: "file",
        });
        await expect(storage.listExact(storagePath("café"))).resolves.toEqual({ files: [], folders: [] });
        await expect(storage.list("café")).resolves.toEqual({ files: [folderNfd + "/" + nameNfd], folders: [] });
    });

    it("rejects case aliases only when the operation uses case-insensitive matching", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "Note.md"), "upper");
        await fs.writeFile(path.join(root, "note.md"), "lower");
        const caseSensitiveStorage = createAdapter(root);
        const caseInsensitiveStorage = createAdapter(root, 1, true);

        await expect(caseSensitiveStorage.read("Note.md")).resolves.toBe("upper");
        await expect(caseInsensitiveStorage.read("Note.md")).rejects.toThrow(/ambiguous/i);
    });

    it("applies case sensitivity per operation without changing Legacy behaviour", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "Note.md"), "content");
        const nfcStorage = createAdapter(root);
        const insensitiveStorage = createAdapter(root, 1, true);
        const legacyStorage = createAdapter(root, 0, true);

        await expect(nfcStorage.read("note.md")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(nfcStorage.read("note.md", true)).resolves.toBe("content");
        await expect(insensitiveStorage.read("note.md")).resolves.toBe("content");
        await expect(legacyStorage.read("note.md")).rejects.toMatchObject({ code: "ENOENT" });
        await legacyStorage.write("note.md", "legacy");
        await expect(fs.readFile(path.join(root, "Note.md"), "utf8")).resolves.toBe("content");
        await expect(fs.readFile(path.join(root, "note.md"), "utf8")).resolves.toBe("legacy");
    });

    it("preserves Node replacement behaviour for a rename to an existing destination", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "source.md"), "source");
        await fs.writeFile(path.join(root, "target.md"), "target");
        const referenceRoot = await createRoot();
        await fs.writeFile(path.join(referenceRoot, "source.md"), "source");
        await fs.writeFile(path.join(referenceRoot, "target.md"), "target");
        const storage = createAdapter(root);
        let referenceError: NodeJS.ErrnoException | undefined;

        try {
            await fs.rename(path.join(referenceRoot, "source.md"), path.join(referenceRoot, "target.md"));
        } catch (error) {
            referenceError = error as NodeJS.ErrnoException;
        }

        if (referenceError) {
            await expect(storage.rename("source.md", "target.md")).rejects.toMatchObject({
                code: referenceError.code,
            });
            await expect(fs.readFile(path.join(root, "target.md"), "utf8")).resolves.toBe("target");
            return;
        }

        await storage.rename("source.md", "target.md");
        await expect(fs.readFile(path.join(root, "target.md"), "utf8")).resolves.toBe("source");
        await expect(fs.stat(path.join(root, "source.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reports a missing NFC lookup instead of reading the unresolved spelling", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "note.md"), "physical");
        const storage = createAdapter(root);
        const readDirectory = vi.spyOn(NodeStorageAdapter.prototype, "readDirectory").mockResolvedValue([]);

        await expect(storage.read("note.md")).rejects.toMatchObject({ code: "ENOENT" });
        expect(readDirectory).toHaveBeenCalled();
        await expect(fs.readFile(path.join(root, "note.md"), "utf8")).resolves.toBe("physical");
    });

    it("uses a fresh directory listing for each exact scan", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "one.md"), "one");
        const storage = createAdapter(root);
        const readDirectory = vi.spyOn(NodeStorageAdapter.prototype, "readDirectory");

        await expect(storage.listExact(storagePath(""))).resolves.toEqual({ files: ["one.md"], folders: [] });

        expect(readDirectory).toHaveBeenCalledTimes(1);
    });

    it("rejects unsupported path normalisation versions through the existing helper", async () => {
        const root = await createRoot();
        const storage = createAdapter(root, 2);

        await expect(storage.read("missing.md")).rejects.toThrow(/unsupported path normalisation version: 2/i);
    });
});
