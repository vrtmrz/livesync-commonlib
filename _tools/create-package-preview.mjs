#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = "vrtmrz/livesync-commonlib";
const packageName = "@vrtmrz/livesync-commonlib";
const previewDirectoryName = "commonlib-package-preview";
const previewManifestName = "preview.json";

function isPathInside(parent, candidate) {
    const path = relative(parent, candidate);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function readPackedManifest(tarballPath) {
    try {
        const contents = execFileSync("tar", ["-xOzf", tarballPath, "package/package.json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return JSON.parse(contents);
    } catch (error) {
        throw new Error(`The package tarball does not contain a valid package/package.json: ${error.message}`);
    }
}

async function readPackageManifest(path, description) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        throw new Error(`Cannot read ${description}: ${error.message}`);
    }
}

async function listPackageTarball(artifactDirectory) {
    let directoryInfo;
    try {
        directoryInfo = await lstat(artifactDirectory);
    } catch (error) {
        throw new Error(`Cannot read package artefacts: ${error.message}`);
    }
    if (!directoryInfo.isDirectory()) throw new Error("The package artefacts path must be a directory.");

    let entries;
    try {
        entries = await readdir(artifactDirectory, { withFileTypes: true });
    } catch (error) {
        throw new Error(`Cannot read package artefacts: ${error.message}`);
    }

    if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.endsWith(".tgz")) {
        throw new Error("The package artefacts directory must contain exactly one .tgz file and no other files.");
    }
    return entries[0].name;
}

async function prepareOutputDirectory(outputDirectory) {
    let info;
    try {
        info = await lstat(outputDirectory);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    if (!info) {
        await mkdir(outputDirectory);
        return true;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("The package preview output path must be an ordinary directory.");
    }
    if ((await readdir(outputDirectory)).length !== 0) {
        throw new Error("The package preview output directory must be empty.");
    }
    return false;
}

async function writeOwnedFile(path, contents, ownedFiles) {
    const handle = await open(path, "wx");
    ownedFiles.add(path);
    try {
        await handle.writeFile(contents);
    } finally {
        await handle.close();
    }
}

async function cleanFailedPreview(outputDirectory, createdDirectory, ownedFiles) {
    for (const path of ownedFiles) await rm(path, { force: true }).catch(() => undefined);
    if (createdDirectory) await rmdir(outputDirectory).catch(() => undefined);
}

async function writeGitHubOutput(path, values) {
    if (!path) return;
    if (/[\r\n]/u.test(path) || values.some(([, value]) => /[\r\n]/u.test(value))) {
        throw new Error("The GitHub Actions output path or value contains a line break.");
    }
    const contents = values.map(([name, value]) => `${name}=${value}\n`).join("");
    await writeFile(path, contents, { flag: "a" });
}

export async function createPackagePreview({ artifactDirectory, outputDirectory, rootDirectory, sourceSha, githubOutputPath }) {
    const root = resolve(rootDirectory);
    const artifacts = resolve(artifactDirectory);
    const output = resolve(outputDirectory);
    if (basename(output) !== previewDirectoryName || isPathInside(root, output)) {
        throw new Error(`The preview directory must be named '${previewDirectoryName}' and located outside the repository.`);
    }
    if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("The checked-out source SHA must be 40 lowercase hexadecimal characters.");

    const sourceManifest = await readPackageManifest(resolve(root, "package.json"), "the source package manifest");
    if (sourceManifest.name !== packageName) {
        throw new Error(`The source package name must be exactly '${packageName}'.`);
    }
    if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) {
        throw new Error("The source package manifest must declare a package version.");
    }

    const file = await listPackageTarball(artifacts);
    const expectedFile = `vrtmrz-livesync-commonlib-${sourceManifest.version}.tgz`;
    if (file !== expectedFile || basename(file) !== file) {
        throw new Error(`The package tarball must be named '${expectedFile}'.`);
    }

    const tarballPath = resolve(artifacts, file);
    const tarball = await readFile(tarballPath);
    const packedManifest = readPackedManifest(tarballPath);
    if (packedManifest?.name !== packageName || packedManifest?.version !== sourceManifest.version) {
        throw new Error("The packed package manifest identity and version must match the Commonlib source manifest.");
    }

    const manifest = {
        schemaVersion: 1,
        repository,
        sha: sourceSha,
        packages: [
            {
                name: packageName,
                version: sourceManifest.version,
                file,
                sha256: createHash("sha256").update(tarball).digest("hex"),
            },
        ],
    };

    const createdDirectory = await prepareOutputDirectory(output);
    const ownedFiles = new Set();
    try {
        await writeOwnedFile(resolve(output, file), tarball, ownedFiles);
        await writeOwnedFile(resolve(output, previewManifestName), `${JSON.stringify(manifest, null, 2)}\n`, ownedFiles);

        const outputFiles = (await readdir(output)).sort();
        if (JSON.stringify(outputFiles) !== JSON.stringify([file, previewManifestName].sort())) {
            throw new Error("The package preview output directory contains unexpected files.");
        }
        await writeGitHubOutput(githubOutputPath, [
            ["sha", sourceSha],
            ["directory", output],
        ]);
    } catch (error) {
        await cleanFailedPreview(output, createdDirectory, ownedFiles);
        throw error;
    }

    return manifest;
}

async function main() {
    if (process.argv.length !== 3) {
        throw new Error(`Usage: node _tools/create-package-preview.mjs <${previewDirectoryName} directory outside the repository>`);
    }
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
    }).trim();
    const outputDirectory = resolve(process.argv[2]);
    const manifest = await createPackagePreview({
        artifactDirectory: resolve(repositoryRoot, "artifacts"),
        outputDirectory,
        rootDirectory: repositoryRoot,
        sourceSha,
        githubOutputPath: process.env.GITHUB_OUTPUT,
    });
    console.log(`Created package preview for ${manifest.sha} in ${outputDirectory}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
