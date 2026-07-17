#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageDirectory = resolve(root, ".package");
const artefactDirectory = resolve(root, "artifacts");
const consumerDirectory = resolve(root, ".package-consumer");
const packageName = "@vrtmrz/livesync-commonlib";
const inventory = JSON.parse(await readFile(resolve(root, "docs/migration/downstream-imports.json"), "utf8"));

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd ?? root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    });
}

async function writeConsumerFile(relativePath, contents) {
    const path = resolve(consumerDirectory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
}

await rm(consumerDirectory, { recursive: true, force: true });
await mkdir(consumerDirectory, { recursive: true });
await mkdir(artefactDirectory, { recursive: true });

const packed = JSON.parse(
    run("npm", ["pack", packageDirectory, "--json", "--pack-destination", artefactDirectory])
)[0];
assert.equal(packed.name, packageName);
assert.ok(packed.size > 0, "The packed package must not be empty.");
assert.ok(packed.files.every(({ path }) => !path.startsWith("src/")), "Source files must not be published.");
assert.ok(
    packed.files.every(({ path }) => !path.includes(".svelte")),
    "Host-owned Svelte source and compiled components must not be published."
);

const tarballPath = resolve(artefactDirectory, packed.filename);
await writeConsumerFile(
    "package.json",
    `${JSON.stringify(
        {
            name: "commonlib-package-consumer",
            private: true,
            type: "module",
            dependencies: { [packageName]: pathToFileURL(tarballPath).href },
        },
        null,
        2
    )}\n`
);
await writeConsumerFile(
    "tsconfig.json",
    `${JSON.stringify(
        {
            compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                lib: ["ES2022", "DOM", "DOM.Iterable"],
                strict: true,
                noEmit: true,
                // The PouchDB 9 ecosystem still ships legacy DefinitelyTyped declarations
                // which conflict with current Node Buffer generics. Consumer source remains
                // strictly checked while those third-party declarations are skipped.
                skipLibCheck: true,
                types: [],
            },
            include: ["type-smoke.ts"],
        },
        null,
        2
    )}\n`
);
await writeConsumerFile(
    "type-smoke.ts",
    `import {
    createServiceContext,
    passthroughMessageTranslator,
    type ServiceContextOptions,
} from "${packageName}/context";
import { DirectFileManipulator, type DirectFileManipulatorOptions } from "${packageName}";
import { splitPieces2Worker } from "${packageName}/compat/worker/bgWorker";

const options: ServiceContextOptions = { translate: (key) => \`translated:\${key}\` };
const context = createServiceContext(options);
const untranslated: string = passthroughMessageTranslator("message.key");
const split = splitPieces2Worker(new Blob(["content"], { type: "text/plain" }), 4, false, 1);
const directOptions = {} as DirectFileManipulatorOptions;
const directType: typeof DirectFileManipulator = DirectFileManipulator;
void context;
void untranslated;
void split;
void directOptions;
void directType;
`
);
await writeConsumerFile(
    "node-smoke.mjs",
    `import assert from "node:assert/strict";

class FakeHTMLElement {}
class FakeSVGElement {}
globalThis.HTMLElement = FakeHTMLElement;
globalThis.SVGElement = FakeSVGElement;

const before = {
    htmlStyles: Object.hasOwn(FakeHTMLElement.prototype, "setCssStyles"),
    htmlProps: Object.hasOwn(FakeHTMLElement.prototype, "setCssProps"),
    svgStyles: Object.hasOwn(FakeSVGElement.prototype, "setCssStyles"),
    svgProps: Object.hasOwn(FakeSVGElement.prototype, "setCssProps"),
};

const contextApi = await import("${packageName}/context");
const rootApi = await import("${packageName}");
const workerApi = await import("${packageName}/compat/worker/bgWorker");
const runtimeCompat = await import("${packageName}/compat/common/coreEnvFunctions");
const p2pFeatureApi = await import(
    "${packageName}/compat/replication/trystero/useP2PReplicatorFeature"
);

assert.equal(contextApi.createServiceContext().translate("message.key"), "message.key");
assert.equal(typeof rootApi.DirectFileManipulator, "function");
assert.equal(runtimeCompat.compatGlobal, globalThis);
assert.equal(typeof p2pFeatureApi.useP2PReplicatorFeature, "function");

const piecesFactory = await workerApi.splitPieces2Worker(
    new Blob(["abcdef"], { type: "text/plain" }),
    3,
    false,
    1
);
const pieces = [];
for await (const piece of piecesFactory()) pieces.push(piece);
assert.ok(pieces.length > 0);

assert.deepEqual(
    {
        htmlStyles: Object.hasOwn(FakeHTMLElement.prototype, "setCssStyles"),
        htmlProps: Object.hasOwn(FakeHTMLElement.prototype, "setCssProps"),
        svgStyles: Object.hasOwn(FakeSVGElement.prototype, "setCssStyles"),
        svgProps: Object.hasOwn(FakeSVGElement.prototype, "setCssProps"),
    },
    before,
    "Importing the package, including the compatibility module used by the CLI, must not patch host DOM prototypes."
);
`
);
await writeConsumerFile(
    "browser-context.ts",
    `import { createServiceContext } from "${packageName}/context";

document.body.dataset.translation = createServiceContext().translate("message.key");
`
);
await writeConsumerFile(
    "browser-services.ts",
    `import { BrowserServiceHub } from "${packageName}/compat/services/BrowserServices";

(globalThis as typeof globalThis & { CommonlibBrowserServiceHub?: typeof BrowserServiceHub })
    .CommonlibBrowserServiceHub = BrowserServiceHub;
`
);
await writeConsumerFile(
    "browser-worker.ts",
    `export { initialiseWorkerModule, splitPieces2Worker } from "${packageName}/compat/worker/bgWorker";
`
);

run(
    "npm",
    [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefer-offline",
        "--loglevel=error",
    ],
    { cwd: consumerDirectory, capture: false }
);
run(process.execPath, [resolve(consumerDirectory, "node-smoke.mjs")], {
    cwd: consumerDirectory,
    capture: false,
});
run(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(consumerDirectory, "tsconfig.json")],
    { cwd: consumerDirectory, capture: false }
);

const contextBundle = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser"],
    entryPoints: [resolve(consumerDirectory, "browser-context.ts")],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
});
const contextInputs = Object.keys(contextBundle.metafile.inputs);
assert.ok(
    contextInputs.every((path) => !path.includes("svelte") && !path.includes("messagesJson")),
    "The context entry point must not load Svelte or the language catalogue."
);
assert.ok(contextBundle.outputFiles[0].contents.length < 20_000, "The context bundle has grown unexpectedly.");

const browserServicesBundle = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser"],
    entryPoints: [resolve(consumerDirectory, "browser-services.ts")],
    external: ["crypto"],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
});
const browserServicesInputs = Object.keys(browserServicesBundle.metafile.inputs);
assert.ok(
    browserServicesInputs.every((path) => !path.includes("svelte")),
    "Importing the browser service composition must not load a Svelte runtime or component."
);

const workerBundle = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser"],
    entryPoints: [resolve(consumerDirectory, "browser-worker.ts")],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
});
const workerInputs = Object.keys(workerBundle.metafile.inputs);
const workerSource = workerBundle.outputFiles[0].text;
assert.ok(workerInputs.every((path) => !path.includes("bgWorker.direct")), "Browser builds must not use the direct worker.");
assert.match(workerSource, /new Blob\(/u);
assert.match(workerSource, /new Worker\(/u);

const manifest = JSON.parse(
    await readFile(resolve(consumerDirectory, "node_modules", "@vrtmrz", "livesync-commonlib", "package.json"), "utf8")
);
assert.equal(manifest.name, packageName);
assert.equal(Object.keys(manifest.exports).length, inventory.compatibility.length + 4);

console.log(
    JSON.stringify(
        {
            package: `${manifest.name}@${manifest.version}`,
            integrity: packed.integrity,
            packedBytes: packed.size,
            unpackedBytes: packed.unpackedSize,
            contextBundleBytes: contextBundle.outputFiles[0].contents.length,
            browserServicesBundleBytes: browserServicesBundle.outputFiles[0].contents.length,
            workerBundleBytes: workerBundle.outputFiles[0].contents.length,
        },
        null,
        2
    )
);
