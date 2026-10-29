import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { loadOctagonalWheelsCandidate } from "./packed-dependency-candidate.mjs";

test("ordinary package checks select no dependency override", async () => {
    assert.equal(await loadOctagonalWheelsCandidate([]), undefined);
});

test("rejects unknown, missing, empty, and extra candidate arguments", async () => {
    for (const args of [
        ["--other", "candidate.tgz"],
        ["--octagonal-wheels-tarball"],
        ["--octagonal-wheels-tarball", ""],
        ["--octagonal-wheels-tarball", "candidate.tgz", "extra"],
    ]) {
        await assert.rejects(loadOctagonalWheelsCandidate(args), /Usage:/);
    }
});

test("records the selected local bytes and safely encodes a relative path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "commonlib-dependency-candidate-"));
    try {
        const path = join(directory, "candidate #1.tgz");
        const bytes = Buffer.from([0, 1, 128, 255]);
        await writeFile(path, bytes);
        const selected = await loadOctagonalWheelsCandidate([
            "--octagonal-wheels-tarball",
            relative(process.cwd(), path),
        ]);
        assert.deepEqual(selected, {
            path,
            url: pathToFileURL(path).href,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        await assert.rejects(
            loadOctagonalWheelsCandidate(["--octagonal-wheels-tarball", join(directory, "missing.tgz")]),
            { code: "ENOENT" }
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
