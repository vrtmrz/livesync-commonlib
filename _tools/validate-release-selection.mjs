#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const BRANCH_REF_PATTERN = /^refs\/heads\/[^\s]+$/u;

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

export function validateReleaseSelection({
    sourceManifest,
    builtManifest,
    version,
    expectedSha,
    actualSha,
    sourceRef,
    confirmation,
}) {
    requireCondition(VERSION_PATTERN.test(version), `Invalid release version: ${version}`);
    requireCondition(!version.includes("package-proof"), "Package-proof versions cannot be published.");
    requireCondition(COMMIT_PATTERN.test(expectedSha), "The expected commit must be a full lowercase SHA.");
    requireCondition(actualSha === expectedSha, `Expected ${expectedSha}, but the workflow is running ${actualSha}.`);
    requireCondition(BRANCH_REF_PATTERN.test(sourceRef), "The release source must be selected from a branch ref.");
    if (!version.includes("-")) {
        requireCondition(sourceRef === "refs/heads/main", "Stable releases must be selected from refs/heads/main.");
    }
    requireCondition(sourceManifest.version === version, `Source manifest version is ${sourceManifest.version}, not ${version}.`);
    requireCondition(sourceManifest.private === true, "The source repository manifest must remain private.");
    requireCondition(builtManifest.name === sourceManifest.name, "The built package name differs from the source manifest.");
    requireCondition(builtManifest.version === version, `Built package version is ${builtManifest.version}, not ${version}.`);
    requireCondition(builtManifest.private !== true, "The built package is marked private.");
    requireCondition(
        builtManifest.publishConfig?.access === "public" && builtManifest.publishConfig?.tag === "next",
        "The built package must default to public publication on the next dist-tag."
    );
    const expectedConfirmation = `stage ${sourceManifest.name}@${version} from ${expectedSha}`;
    requireCondition(confirmation === expectedConfirmation, `Confirmation must be: ${expectedConfirmation}`);
}

async function main() {
    const [version, expectedSha, actualSha, sourceRef, confirmation] = process.argv.slice(2);
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const sourceManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const builtManifest = JSON.parse(await readFile(resolve(root, ".package/package.json"), "utf8"));
    validateReleaseSelection({ sourceManifest, builtManifest, version, expectedSha, actualSha, sourceRef, confirmation });
    console.log(`Validated ${sourceManifest.name}@${version} from ${sourceRef} at ${actualSha} for staged publication.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
