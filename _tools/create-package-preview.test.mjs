import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPackagePreview } from "./create-package-preview.mjs";

const packageName = "@vrtmrz/livesync-commonlib";
const version = "0.1.44";
const sourceSha = "a".repeat(40);
const packageFile = "vrtmrz-livesync-commonlib-0.1.44.tgz";

async function makeFixture({ sourceManifest = {}, packedManifest = {}, filename = packageFile } = {}) {
    const baseDirectory = await mkdtemp(join(tmpdir(), "commonlib-package-preview-"));
    const rootDirectory = join(baseDirectory, "repository");
    const artifactDirectory = join(rootDirectory, "artifacts");
    const outputDirectory = join(baseDirectory, "commonlib-package-preview");
    const packageDirectory = join(baseDirectory, "package");
    const tarballPath = join(artifactDirectory, filename);

    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(packageDirectory);
    await writeFile(
        join(rootDirectory, "package.json"),
        JSON.stringify({ name: packageName, version, ...sourceManifest })
    );
    await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: packageName, version, ...packedManifest })
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", baseDirectory, "package"], { stdio: "ignore" });

    return {
        artifactDirectory,
        baseDirectory,
        outputDirectory,
        rootDirectory,
        tarball: await readFile(tarballPath),
        async clean() {
            await rm(baseDirectory, { recursive: true, force: true });
        },
        create({ githubOutputPath, output = outputDirectory } = {}) {
            return createPackagePreview({
                artifactDirectory,
                outputDirectory: output,
                rootDirectory,
                sourceSha,
                githubOutputPath,
            });
        },
    };
}

test("creates a preview manifest with the checked source identity and exact tarball checksum", async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.clean);
    const githubOutputPath = join(fixture.baseDirectory, "github-output");

    const manifest = await fixture.create({ githubOutputPath });
    const expected = {
        schemaVersion: 1,
        repository: "vrtmrz/livesync-commonlib",
        sha: sourceSha,
        packages: [
            {
                name: packageName,
                version,
                file: packageFile,
                sha256: createHash("sha256").update(fixture.tarball).digest("hex"),
            },
        ],
    };
    assert.deepEqual(manifest, expected);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.outputDirectory, "preview.json"), "utf8")), expected);
    assert.deepEqual(await readFile(join(fixture.outputDirectory, packageFile)), fixture.tarball);
    assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [packageFile, "preview.json"].sort());
    assert.equal(
        await readFile(githubOutputPath, "utf8"),
        `sha=${sourceSha}\ndirectory=${fixture.outputDirectory}\n`
    );
});

test("writes into an existing empty ordinary output directory", async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.clean);
    await mkdir(fixture.outputDirectory);

    await fixture.create();

    assert.deepEqual((await readdir(fixture.outputDirectory)).sort(), [packageFile, "preview.json"].sort());
});

test("rejects a non-empty output directory without changing its files", async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.clean);
    await mkdir(fixture.outputDirectory);
    await writeFile(join(fixture.outputDirectory, "keep.txt"), "caller data");

    await assert.rejects(fixture.create(), /output directory must be empty/u);
    assert.deepEqual(await readdir(fixture.outputDirectory), ["keep.txt"]);
    assert.equal(await readFile(join(fixture.outputDirectory, "keep.txt"), "utf8"), "caller data");
});

test("rejects a symlink output without changing its target", async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.clean);
    const targetDirectory = join(fixture.baseDirectory, "caller-directory");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "keep.txt"), "caller data");
    await symlink(targetDirectory, fixture.outputDirectory);

    await assert.rejects(fixture.create(), /ordinary directory/u);
    assert.deepEqual(await readdir(targetDirectory), ["keep.txt"]);
    assert.equal(await readFile(join(targetDirectory, "keep.txt"), "utf8"), "caller data");
});

test("rejects unexpected files beside the validated tarball", async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.clean);
    await writeFile(join(fixture.artifactDirectory, "notes.txt"), "unexpected");

    await assert.rejects(fixture.create(), /exactly one \.tgz file and no other files/u);
});

test("rejects a tarball with a basename that does not match the source package version", async (t) => {
    const fixture = await makeFixture({ filename: "commonlib.tgz" });
    t.after(fixture.clean);

    await assert.rejects(fixture.create(), /must be named 'vrtmrz-livesync-commonlib-0\.1\.44\.tgz'/u);
});

test("rejects packed manifest names and versions which do not match Commonlib", async (t) => {
    for (const packedManifest of [{ name: "@vrtmrz/other", version }, { name: packageName, version: "0.1.45" }]) {
        const fixture = await makeFixture({ packedManifest });
        try {
            await assert.rejects(fixture.create(), /identity and version must match/u);
        } finally {
            await fixture.clean();
        }
    }
});

test("rejects a source manifest for a different package", async (t) => {
    const fixture = await makeFixture({ sourceManifest: { name: "@vrtmrz/other" } });
    t.after(fixture.clean);

    await assert.rejects(fixture.create(), /source package name must be exactly/u);
});
