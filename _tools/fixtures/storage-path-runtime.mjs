import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AmbiguousNormalisedPathError,
    createStoragePathResolver,
    parseFilePath,
} from "@vrtmrz/livesync-commonlib/storage";
import { UnicodeResolvingNodeStorageAdapter } from "@vrtmrz/livesync-commonlib/node";

const actual = "Café.md".normalize("NFD");
const resolver = createStoragePathResolver({
    policy: { pathNormalizationVersion: 1, handleFilenameCaseSensitive: true },
    readDirectory: async () => [{ name: actual, kind: "file" }],
});
assert.equal(await resolver.resolveExisting(parseFilePath("Café.md")), actual);
const root = await mkdtemp(join(tmpdir(), "commonlib-path-consumer-"));
try {
    await writeFile(join(root, actual), "original");
    const storage = new UnicodeResolvingNodeStorageAdapter(root, () => 1);
    await storage.write("Café.md", "updated");
    assert.deepEqual(await readdir(root), [actual]);
    assert.equal(await readFile(join(root, actual), "utf8"), "updated");
    const ambiguous = createStoragePathResolver({
        policy: { pathNormalizationVersion: 1, handleFilenameCaseSensitive: true },
        readDirectory: async () => [
            { name: actual, kind: "file" },
            { name: "Café.md", kind: "file" },
        ],
    });
    await assert.rejects(ambiguous.resolveForWrite(parseFilePath(actual)), AmbiguousNormalisedPathError);
} finally {
    await rm(root, { recursive: true, force: true });
}
console.log("Packed storage path contract passed.");
