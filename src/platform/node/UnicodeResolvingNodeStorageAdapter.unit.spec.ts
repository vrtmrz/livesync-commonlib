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

    it("keeps the documented Legacy default when no policy callbacks are supplied", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "note.md"), "before");
        const storage = new UnicodeResolvingNodeStorageAdapter(root);

        expect(storage.isUnicodePathNormalizationEnabled).toBe(false);
        await expect(storage.read("note.md")).resolves.toBe("before");
        await storage.append("note.md", "-after");
        await expect(fs.readFile(path.join(root, "note.md"), "utf8")).resolves.toBe("before-after");
    });

    it("keeps the Legacy binary and text lifecycle on exact physical paths", async () => {
        const root = await createRoot();
        const folder = "café".normalize("NFD");
        const textPath = `${folder}/${"résumé.md".normalize("NFD")}`;
        const renamed = `${folder}/${"naïve.md".normalize("NFD")}`;
        const binary = `${folder}/bytes.bin`;
        const bytes = new Uint8Array([0, 255, 128, 7]);
        const storage = createAdapter(root, 0);

        await storage.mkdir(folder);
        await storage.writeBinary(binary, bytes.buffer);
        await expect(storage.readBinary(binary)).resolves.toEqual(bytes.buffer);
        await expect(storage.stat(binary)).resolves.toMatchObject({ type: "file", size: bytes.length });
        await expect(storage.trystat(binary)).resolves.toMatchObject({ type: "file", size: bytes.length });
        await expect(storage.statExact(storagePath(binary))).resolves.toMatchObject({ type: "file" });
        await storage.write(textPath, "before");
        await storage.append(textPath, "-after");
        await storage.rename(textPath, renamed);

        await expect(fs.readFile(path.join(root, renamed), "utf8")).resolves.toBe("before-after");
        await expect(storage.exists(textPath)).resolves.toBe(false);
        const listed = await storage.listExact(storagePath(folder));
        expect(listed.files.sort()).toEqual([binary, renamed].sort());
        expect(listed.folders).toEqual([]);
        await expect(storage.listExact(storagePath(""))).resolves.toEqual({ files: [], folders: [folder] });
        await storage.remove(binary);
        await storage.remove(renamed);
        await expect(storage.trystat(binary)).resolves.toBeNull();
        await expect(storage.list(folder)).resolves.toEqual({ files: [], folders: [] });
        await storage.remove(folder);
        await expect(fs.readdir(root)).resolves.toEqual([]);
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

    it("round-trips exact binary bytes through an NFC path without changing physical spelling", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const fileNfd = "résumé.bin".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, fileNfd), new Uint8Array([9, 8, 7]));
        const storage = createAdapter(root);
        const expected = new Uint8Array([0, 1, 127, 128, 255]);

        await storage.writeBinary("café/résumé.bin", expected.buffer);

        const actual = new Uint8Array(await storage.readBinary("café/résumé.bin"));
        expect(Array.from(actual)).toEqual(Array.from(expected));
        await expect(fs.readdir(path.join(root, folderNfd))).resolves.toEqual([fileNfd]);
        await expect(fs.readFile(path.join(root, folderNfd, fileNfd))).resolves.toEqual(Buffer.from(expected));
    });

    it("appends through a resolved spelling and creates a missing append target", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const fileNfd = "résumé.md".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, fileNfd), "before");
        const storage = createAdapter(root);

        await storage.append("café/résumé.md", " after");
        await storage.append("café/new.md", "created by append");

        await expect(fs.readFile(path.join(root, folderNfd, fileNfd), "utf8")).resolves.toBe("before after");
        await expect(fs.readFile(path.join(root, folderNfd, "new.md"), "utf8")).resolves.toBe("created by append");
        expect((await fs.readdir(path.join(root, folderNfd))).sort()).toEqual([fileNfd, "new.md"].sort());
    });

    it.skipIf(process.platform === "win32")(
        "rejects symlink paths before NFC lookup reports them as absent",
        async () => {
            const root = await createRoot();
            const outside = await createRoot();
            await fs.writeFile(path.join(outside, "secret.md"), "outside");
            await fs.writeFile(path.join(root, "regular.md"), "regular");
            await fs.symlink(outside, path.join(root, "linked"), "dir");
            await fs.symlink(path.join(outside, "secret.md"), path.join(root, "unrelated.md"), "file");
            const storage = createAdapter(root);

            await expect(storage.exists("linked/secret.md")).rejects.toThrow(/symbolic links/i);
            await expect(storage.read("linked/secret.md")).rejects.toThrow(/symbolic links/i);
            await expect(storage.resolveLogicalPath("linked/secret.md" as FilePath, undefined, false)).rejects.toThrow(
                /symbolic links/i
            );
            await expect(storage.readDirectory(storagePath(""))).resolves.toEqual([
                { name: "regular.md", kind: "file" },
            ]);
            await expect(storage.read("regular.md")).resolves.toBe("regular");
            await expect(fs.readFile(path.join(outside, "secret.md"), "utf8")).resolves.toBe("outside");
        }
    );

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

    it("rejects NFC/NFD file aliases before reads and writes, preserving every file", async () => {
        const root = await createRoot();
        const nameNfc = "café.md";
        const nameNfd = nameNfc.normalize("NFD");
        const unrelatedName = "unrelated.md";
        await fs.writeFile(path.join(root, nameNfc), "NFC");
        await fs.writeFile(path.join(root, nameNfd), "NFD");
        await fs.writeFile(path.join(root, unrelatedName), "untouched");
        const storage = createAdapter(root);

        await expect(storage.read(nameNfc)).rejects.toThrow(/ambiguous/i);
        await expect(storage.write(nameNfc, "overwrite")).rejects.toThrow(/ambiguous/i);
        await expect(storage.append(nameNfc, " append")).rejects.toThrow(/ambiguous/i);
        await expect(fs.readFile(path.join(root, nameNfc), "utf8")).resolves.toBe("NFC");
        await expect(fs.readFile(path.join(root, nameNfd), "utf8")).resolves.toBe("NFD");
        await expect(fs.readFile(path.join(root, unrelatedName), "utf8")).resolves.toBe("untouched");
        expect((await fs.readdir(root)).sort()).toEqual([nameNfc, nameNfd, unrelatedName].sort());
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
        await expect(storage.statExact(storagePath("missing.md"))).resolves.toBeNull();
        await expect(storage.listExact(storagePath("missing"))).resolves.toEqual({ files: [], folders: [] });
        await expect(storage.listExact(storagePath(folderNfd))).resolves.toEqual({
            files: [storagePath(folderNfd + "/" + nameNfd)],
            folders: [],
        });
        await expect(storage.statExact(storagePath(folderNfd + "/" + nameNfd + "/child"))).rejects.toMatchObject({
            code: "ENOTDIR",
        });
        await expect(storage.listExact(storagePath(folderNfd + "/" + nameNfd))).rejects.toMatchObject({
            code: "ENOTDIR",
        });
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

    it("uses one case-policy snapshot per operation and exposes the current NFC mode", async () => {
        const root = await createRoot();
        await fs.writeFile(path.join(root, "Note.md"), "upper");
        await fs.writeFile(path.join(root, "note.md"), "lower");
        let version = 0;
        let caseInsensitive = false;
        const getCaseInsensitive = vi.fn(() => {
            const snapshot = caseInsensitive;
            caseInsensitive = true;
            return snapshot;
        });
        const storage = new UnicodeResolvingNodeStorageAdapter(root, () => version, getCaseInsensitive);

        expect(storage.isUnicodePathNormalizationEnabled).toBe(false);
        version = 1;
        expect(storage.isUnicodePathNormalizationEnabled).toBe(true);
        await expect(storage.read("Note.md")).resolves.toBe("upper");
        expect(getCaseInsensitive).toHaveBeenCalledTimes(1);
        await expect(storage.read("Note.md")).rejects.toThrow(/ambiguous/i);
        expect(getCaseInsensitive).toHaveBeenCalledTimes(2);
        version = 0;
        expect(storage.isUnicodePathNormalizationEnabled).toBe(false);
    });

    it("keeps NFC and NFD names separate in Legacy mode", async () => {
        const root = await createRoot();
        const nameNfc = "café.md";
        const nameNfd = nameNfc.normalize("NFD");
        await fs.writeFile(path.join(root, nameNfd), "NFD contents");
        const storage = createAdapter(root, 0, true);

        await expect(storage.read(nameNfc)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(storage.read(nameNfd)).resolves.toBe("NFD contents");
        await storage.write(nameNfc, "NFC contents");

        expect((await fs.readdir(root)).sort()).toEqual([nameNfc, nameNfd].sort());
        await expect(fs.readFile(path.join(root, nameNfc), "utf8")).resolves.toBe("NFC contents");
        await expect(fs.readFile(path.join(root, nameNfd), "utf8")).resolves.toBe("NFD contents");
    });

    it("returns null for missing metadata but propagates NFC listing and stat failures", async () => {
        const root = await createRoot();
        const folderNfd = "café".normalize("NFD");
        const fileNfd = "résumé.md".normalize("NFD");
        await fs.mkdir(path.join(root, folderNfd));
        await fs.writeFile(path.join(root, folderNfd, fileNfd), "content");
        const storage = createAdapter(root);

        await expect(storage.trystat("café/missing.md")).resolves.toBeNull();
        await expect(storage.stat("café/missing.md")).resolves.toBeNull();
        await expect(storage.trystat("café/résumé.md")).resolves.toMatchObject({ type: "file" });
        await expect(storage.stat("café/résumé.md")).resolves.toMatchObject({ type: "file" });

        const listingError = Object.assign(new Error("permission denied during listing"), { code: "EACCES" });
        const readDirectory = vi.spyOn(NodeStorageAdapter.prototype, "readDirectory").mockRejectedValue(listingError);
        await expect(storage.trystat("café/résumé.md")).rejects.toBe(listingError);
        await expect(storage.stat("café/résumé.md")).rejects.toBe(listingError);
        readDirectory.mockRestore();

        const statError = Object.assign(new Error("permission denied during stat"), { code: "EACCES" });
        vi.spyOn(NodeStorageAdapter.prototype, "statResolved").mockRejectedValue(statError);
        await expect(storage.trystat("café/résumé.md")).rejects.toBe(statError);
        await expect(storage.stat("café/résumé.md")).rejects.toBe(statError);
        await expect(fs.readFile(path.join(root, folderNfd, fileNfd), "utf8")).resolves.toBe("content");
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
