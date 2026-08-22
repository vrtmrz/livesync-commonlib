#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

export function extractReleaseNotes(updates, version) {
    const lines = updates.replaceAll("\r\n", "\n").split("\n");
    const heading = `## ${version}`;
    const matches = lines.flatMap((line, index) => (line === heading ? [index] : []));
    requireCondition(matches.length === 1, `Expected exactly one ${heading} heading in updates.md.`);

    const start = matches[0] + 1;
    let end = lines.length;
    for (let index = start; index < lines.length; index += 1) {
        if (lines[index].startsWith("## ")) {
            end = index;
            break;
        }
    }
    const notes = lines.slice(start, end).join("\n").trim();
    requireCondition(notes.length > 0, `Release notes for ${version} are empty.`);
    return notes;
}

export function prepareGitHubRelease({ sourceManifest, updates, version, expectedSha, confirmation }) {
    requireCondition(STABLE_VERSION_PATTERN.test(version), `Invalid stable release version: ${version}`);
    requireCondition(COMMIT_PATTERN.test(expectedSha), "The release commit must be a full lowercase SHA.");
    requireCondition(
        sourceManifest.name === "@vrtmrz/livesync-commonlib",
        `Unexpected package name: ${sourceManifest.name}`
    );
    requireCondition(
        sourceManifest.version === version,
        `Source manifest version is ${sourceManifest.version}, not ${version}.`
    );
    requireCondition(sourceManifest.private === true, "The source repository manifest must remain private.");
    const expectedConfirmation = `release ${sourceManifest.name}@${version} from ${expectedSha}`;
    requireCondition(confirmation === expectedConfirmation, `Confirmation must be: ${expectedConfirmation}`);
    return extractReleaseNotes(updates, version);
}

async function main() {
    const [version, expectedSha, confirmation, manifestPath, updatesPath, notesPath] = process.argv.slice(2);
    requireCondition(
        notesPath !== undefined,
        "GitHub Release preparation requires a version, commit, confirmation, manifest, updates file, and output path."
    );
    const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const updates = await readFile(updatesPath, "utf8");
    const notes = prepareGitHubRelease({ sourceManifest, updates, version, expectedSha, confirmation });
    await writeFile(notesPath, `${notes}\n`, "utf8");
    console.log(`Prepared GitHub Release notes for ${sourceManifest.name}@${version} from ${expectedSha}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
