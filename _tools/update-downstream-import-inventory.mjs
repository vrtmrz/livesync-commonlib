#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { extractImportSpecifiers } from "./package-boundary.mjs";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".svelte"];
const ignoredDirectories = new Set([".git", "_types", "dist", "node_modules"]);
const obsoleteImports = new Set(["UI/svelteDialog", "services/InjectableServices", "worker/bgWorker.mock"]);
const hostOwnedPatterns = [
    /^UI\/(?:DialogHost\.svelte|components\/|dialogues\/)/u,
    /^serviceFeatures\/setupObsidian\//u,
    /^services\/implements\/browser\/(?:BrowserConfirm|BrowserUIService|Menu|SvelteDialogBrowser|ui\/)/u,
    /^services\/implements\/obsidian\//u,
];

function parseArguments(argv) {
    const downstreamIndex = argv.indexOf("--downstream");
    if (downstreamIndex < 0 || !argv[downstreamIndex + 1]) {
        throw new Error("Usage: update-downstream-import-inventory.mjs --downstream <Self-hosted LiveSync checkout>");
    }
    return { downstream: resolve(argv[downstreamIndex + 1]) };
}

async function collectSourceFiles(directory, downstreamRoot) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            if (relative(downstreamRoot, path).split(sep).join("/") === "src/lib") continue;
            files.push(...(await collectSourceFiles(path, downstreamRoot)));
        } else if (entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
            files.push(path);
        }
    }
    return files;
}

function normaliseLibSpecifier(specifier) {
    return specifier.slice("@lib/".length).replace(/\.(?:ts|js)$/u, "");
}

function classify(specifier) {
    if (obsoleteImports.has(specifier)) return "obsolete";
    if (hostOwnedPatterns.some((pattern) => pattern.test(specifier))) return "hostOwned";
    return "compatibility";
}

async function sourceExists(root, specifier) {
    const candidates = specifier.endsWith(".svelte")
        ? [resolve(root, "src", specifier)]
        : [resolve(root, "src", `${specifier}.ts`), resolve(root, "src", specifier, "index.ts")];
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return true;
        } catch {
            // Try the next supported source shape.
        }
    }
    return false;
}

const root = resolve(new URL("..", import.meta.url).pathname);
const { downstream } = parseArguments(process.argv.slice(2));
const downstreamSources = [resolve(downstream, "src"), resolve(downstream, "test")];
const specifiers = new Set();

for (const sourceRoot of downstreamSources) {
    for (const path of await collectSourceFiles(sourceRoot, downstream)) {
        const source = await readFile(path, "utf8");
        for (const specifier of extractImportSpecifiers(source)) {
            if (specifier.startsWith("@lib/")) specifiers.add(normaliseLibSpecifier(specifier));
        }
    }
}

const inventory = {
    repository: "vrtmrz/obsidian-livesync",
    revision: execFileSync("git", ["-C", downstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    compatibility: [],
    hostOwned: [],
    obsolete: [],
};

for (const specifier of [...specifiers].sort()) {
    const category = classify(specifier);
    inventory[category].push(specifier);
    if (category === "compatibility" && !(await sourceExists(root, specifier))) {
        throw new Error(`Compatibility import has no Commonlib source: @lib/${specifier}`);
    }
}

const outputPath = resolve(root, "docs/migration/downstream-imports.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);

console.log(
    `Recorded ${specifiers.size} imports: ${inventory.compatibility.length} compatibility, ` +
        `${inventory.hostOwned.length} host-owned, and ${inventory.obsolete.length} obsolete.`
);
