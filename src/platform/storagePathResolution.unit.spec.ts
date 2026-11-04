import { describe, expect, it, vi } from "vitest";
import { parseFilePath } from "./pathComparison.ts";
import { createStoragePathResolver, AmbiguousNormalisedPathError } from "./storagePathResolution.ts";
import type { DirectoryEntry, StoragePath, StoragePathResolverOptions } from "./pathTypes.ts";

function fixture(initial: Record<string, readonly DirectoryEntry[]>, caseSensitive = true) {
    const directories = new Map(Object.entries(initial));
    const readDirectory = vi.fn(async (path: StoragePath) => directories.get(path) ?? null);
    const policy = { pathNormalizationVersion: 1 as const, handleFilenameCaseSensitive: caseSensitive };
    return { directories, readDirectory, policy, resolver: createStoragePathResolver({ readDirectory, policy }) };
}

const file = (name: string): DirectoryEntry => ({ name, kind: "file" });
const folder = (name: string): DirectoryEntry => ({ name, kind: "directory" });

describe("storage path resolution", () => {
    it.each([undefined, 0, "false"])("rejects a non-boolean case policy before invoking the reader (%j)", (value) => {
        const readDirectory = vi.fn(async () => []);
        expect(() =>
            createStoragePathResolver({
                readDirectory,
                policy: { pathNormalizationVersion: 1, handleFilenameCaseSensitive: value },
            } as unknown as StoragePathResolverOptions)
        ).toThrow("Filename case handling must be explicit");
        expect(readDirectory).not.toHaveBeenCalled();
    });

    it("resolves mixed parent spelling and retains a missing suffix", async () => {
        const parent = "café".normalize("NFD");
        const leaf = "Ångström.md".normalize("NFD");
        const { resolver } = fixture({
            "": [folder(parent)],
            [parent]: [folder("Étage")],
            [`${parent}/Étage`]: [file(leaf)],
        });
        await expect(resolver.resolveExisting(parseFilePath("café/Étage/Ångström.md"))).resolves.toBe(
            `${parent}/Étage/${leaf}`
        );
        const requested = "récent/new.md".normalize("NFD");
        await expect(resolver.resolveForWrite(parseFilePath(`café/Étage/${requested}`))).resolves.toBe(
            `${parent}/Étage/${requested}`
        );
        await expect(resolver.resolveExisting(parseFilePath("café/absent.md"))).resolves.toBeNull();
    });

    it.each([true, false])("uses NFC with case sensitivity %s", async (caseSensitive) => {
        const name = "Café.md".normalize("NFD");
        const { resolver } = fixture({ "": [file(name)] }, caseSensitive);
        await expect(resolver.resolveExisting(parseFilePath("Café.md"))).resolves.toBe(name);
        await expect(resolver.resolveExisting(parseFilePath("CAFÉ.MD"))).resolves.toBe(caseSensitive ? null : name);
    });

    it.each(["file", "directory"] as const)("rejects an exact match beside an equivalent %s", async (kind) => {
        const nfc = "café";
        const nfd = nfc.normalize("NFD");
        const { resolver } = fixture({ "": [file(nfc), { name: nfd, kind }] });
        await expect(resolver.resolveExisting(parseFilePath(nfc))).rejects.toMatchObject({
            name: "AmbiguousNormalisedPathError",
            candidates: [nfc, nfd],
        });
        await expect(resolver.resolveForWrite(parseFilePath(`${nfc}/new.md`))).rejects.toBeInstanceOf(
            AmbiguousNormalisedPathError
        );
    });

    it("checks requested identities during lookup and all identities during a scan", async () => {
        const { resolver } = fixture({ "": [file("note.md"), folder("café"), folder("café".normalize("NFD"))] });
        await expect(resolver.resolveExisting(parseFilePath("note.md"))).resolves.toBe("note.md");
        const root = await resolver.resolveForWrite(parseFilePath(""));
        await expect(resolver.listResolvedDirectory(root)).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
    });

    it("rejects a unique file used as a parent", async () => {
        const { resolver } = fixture({ "": [file("notes")] });
        await expect(resolver.resolveForWrite(parseFilePath("notes/new.md"))).rejects.toThrow(/not a directory/i);
    });

    it("propagates a failed listing as a failure", async () => {
        const error = new Error("Permission denied");
        const resolver = createStoragePathResolver({
            readDirectory: async () => {
                throw error;
            },
            policy: { pathNormalizationVersion: 1, handleFilenameCaseSensitive: true },
        });
        await expect(resolver.resolveExisting(parseFilePath("note.md"))).rejects.toBe(error);
        await expect(resolver.resolveForWrite(parseFilePath("note.md"))).rejects.toBe(error);
    });

    it.each(["", ".", "..", "a/b", "a\\b", "nul\0name"])("rejects a malformed directory name %j", async (name) => {
        const { resolver } = fixture({ "": [file(name)] });
        await expect(resolver.resolveExisting(parseFilePath("note.md"))).rejects.toBeInstanceOf(TypeError);
    });

    it("does not retain a successful lookup after the directory changes", async () => {
        const nfc = "café.md";
        const nfd = nfc.normalize("NFD");
        const { resolver, directories } = fixture({ "": [file(nfd)] });
        await expect(resolver.resolveExisting(parseFilePath(nfc))).resolves.toBe(nfd);
        directories.set("", [file(nfc), file(nfd)]);
        await expect(resolver.resolveExisting(parseFilePath(nfc))).rejects.toBeInstanceOf(AmbiguousNormalisedPathError);
        directories.set("", []);
        await expect(resolver.resolveExisting(parseFilePath(nfc))).resolves.toBeNull();
    });

    it("copies the comparison policy when composed", async () => {
        const { resolver, policy } = fixture({ "": [file("Note.md")] }, false);
        policy.handleFilenameCaseSensitive = true;
        await expect(resolver.resolveExisting(parseFilePath("note.md"))).resolves.toBe("Note.md");
    });

    it("scans resolved entries with one read per directory", async () => {
        const parent = "café".normalize("NFD");
        const { resolver, readDirectory } = fixture({
            "": [folder(parent), file("one.md")],
            [parent]: [file("two.md")],
        });
        const paths: string[] = [];
        async function scan(directory: StoragePath): Promise<void> {
            for (const entry of (await resolver.listResolvedDirectory(directory)) ?? []) {
                if (entry.kind === "directory") await scan(entry.path);
                else paths.push(entry.path);
            }
        }
        await scan(await resolver.resolveForWrite(parseFilePath("")));
        expect(paths.sort()).toEqual([`${parent}/two.md`, "one.md"].sort());
        expect(readDirectory.mock.calls.map(([path]) => path)).toEqual(["", parent]);
    });

    it("preserves explicit leaf spelling while retaining the actual parent on rename", async () => {
        const parent = "café".normalize("NFD");
        const leaf = "Résumé.md".normalize("NFD");
        const { resolver } = fixture({ "": [folder(parent)], [parent]: [file(leaf), file("other.md")] }, false);
        await expect(
            resolver.resolveRename(parseFilePath("café/Résumé.md"), parseFilePath("CAFÉ/résumé.md"))
        ).resolves.toEqual({ source: `${parent}/${leaf}`, target: `${parent}/résumé.md` });
        await expect(
            resolver.resolveRename(parseFilePath("café/Résumé.md"), parseFilePath("café/OTHER.md"))
        ).resolves.toEqual({ source: `${parent}/${leaf}`, target: `${parent}/other.md` });
        await expect(resolver.resolveRename(parseFilePath("missing.md"), parseFilePath("new.md"))).resolves.toBeNull();
    });

    it("does not treat an unsupported identity policy as Legacy", () => {
        expect(() =>
            createStoragePathResolver({
                readDirectory: async () => [],
                policy: { pathNormalizationVersion: 0, handleFilenameCaseSensitive: true },
            } as never)
        ).toThrow(/requires NFC/);
        expect(() =>
            createStoragePathResolver({
                readDirectory: async () => [],
                policy: { pathNormalizationVersion: 2, handleFilenameCaseSensitive: true },
            } as never)
        ).toThrow(/unsupported/i);
    });
});
