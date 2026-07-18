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

const packed = JSON.parse(run("npm", ["pack", packageDirectory, "--json", "--pack-destination", artefactDirectory]))[0];
assert.equal(packed.name, packageName);
assert.ok(packed.size > 0, "The packed package must not be empty.");
assert.ok(
    packed.files.every(({ path }) => !path.startsWith("src/")),
    "Source files must not be published."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/platform-storage.md"),
    "The platform storage guide must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/development.md"),
    "The developer guide linked from the README must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/proven-in-use.md"),
    "The maintained-host evidence linked from the README must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/releasing.md"),
    "The release guide linked from the developer guide must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/settings-lifecycle.md"),
    "The settings lifecycle guide linked from the README must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/remote-configurations.md"),
    "The remote configuration guide linked from the README must be included in the package."
);
assert.ok(
    packed.files.some(({ path }) => path === "docs/p2p-transport-lifecycle.md"),
    "The P2P transport lifecycle guide linked from the developer guide must be included in the package."
);
assert.ok(
    packed.files.every(({ path }) => !path.includes(".svelte")),
    "Host-owned Svelte source and compiled components must not be published."
);

const i18nModule = await readFile(resolve(packageDirectory, "dist/common/i18n.js"), "utf8");
assert.match(
    i18nModule,
    /from\s+["']\.\/messages\/combinedMessages\.prod\.js["']/u,
    "The i18n module must import the generated production catalogue instead of duplicating it in a pre-bundled file."
);
assert.ok(
    Buffer.byteLength(i18nModule) < 20_000,
    "The i18n entry point must remain a small ESM composition; consumers own final application bundling."
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
    type ServiceContextContract,
    type ServiceContextOptions,
} from "${packageName}/context";
import { DirectFileManipulator, type DirectFileManipulatorOptions } from "${packageName}";
import {
    createFileSystemAccessStorage,
    type CreateFileSystemAccessStorageOptions,
} from "${packageName}/browser";
import { splitPieces2Worker } from "${packageName}/compat/worker/bgWorker";
import {
    NEW_VAULT_SETTINGS,
    SETTINGS_SCHEMA_DEFAULTS,
    createNewVaultSettings,
    prepareSettingsForLoad,
    type SettingsMigrationState,
} from "${packageName}/settings";
import {
    upsertRemoteConfigurationInPlace,
    type UpsertRemoteConfigurationOptions,
} from "${packageName}/remote-configurations";

const options: ServiceContextOptions = { translate: (key) => \`translated:\${key}\` };
const context = createServiceContext(options);
const contextContract: ServiceContextContract = context;
const untranslated: string = passthroughMessageTranslator("message.key");
const split = splitPieces2Worker(new Blob(["content"], { type: "text/plain" }), 4, false, 1);
const directOptions = {} as DirectFileManipulatorOptions;
const directType: typeof DirectFileManipulator = DirectFileManipulator;
const fileSystemAccessOptions = {} as CreateFileSystemAccessStorageOptions;
const fileSystemAccessFactory: typeof createFileSystemAccessStorage = createFileSystemAccessStorage;
const prepared = prepareSettingsForLoad(undefined);
const migrationState: SettingsMigrationState = prepared;
const newVaultSetting = NEW_VAULT_SETTINGS.usePluginSyncV2;
const schemaFallback = SETTINGS_SCHEMA_DEFAULTS.usePluginSyncV2;
const mutableNewVaultSettings = createNewVaultSettings();
const remoteConfigurationOptions: UpsertRemoteConfigurationOptions = { activate: true };
const remoteConfigurationUpsert: typeof upsertRemoteConfigurationInPlace = upsertRemoteConfigurationInPlace;
void context;
void contextContract;
void untranslated;
void split;
void directOptions;
void directType;
void fileSystemAccessOptions;
void fileSystemAccessFactory;
void migrationState;
void newVaultSetting;
void schemaFallback;
void mutableNewVaultSettings;
void remoteConfigurationOptions;
void remoteConfigurationUpsert;
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
const settingsApi = await import("${packageName}/settings");
const remoteConfigurationsApi = await import("${packageName}/remote-configurations");
const i18nApi = await import("${packageName}/compat/common/i18n");
const workerApi = await import("${packageName}/compat/worker/bgWorker");
const runtimeCompat = await import("${packageName}/compat/common/coreEnvFunctions");
const nodeRuntime = await import("${packageName}/node");
const p2pFeatureApi = await import(
    "${packageName}/compat/replication/trystero/useP2PReplicatorFeature"
);

assert.equal(contextApi.createServiceContext().translate("message.key"), "message.key");
assert.equal(typeof rootApi.DirectFileManipulator, "function");
assert.equal(settingsApi.NEW_VAULT_SETTINGS.usePluginSyncV2, true);
assert.equal(settingsApi.SETTINGS_SCHEMA_DEFAULTS.usePluginSyncV2, false);
assert.equal(settingsApi.prepareSettingsForLoad(undefined).isNewVault, true);
assert.notEqual(settingsApi.createNewVaultSettings(), settingsApi.NEW_VAULT_SETTINGS);
assert.equal(typeof remoteConfigurationsApi.upsertRemoteConfigurationInPlace, "function");
assert.equal(i18nApi.$t("Activate", "es"), "Activar");
assert.equal(runtimeCompat.compatGlobal, globalThis);
assert.equal(typeof nodeRuntime.fs.readFileSync, "function");
assert.equal(typeof nodeRuntime.fsPromises.readFile, "function");
assert.equal(typeof nodeRuntime.path.join, "function");
assert.equal(typeof nodeRuntime.readline.createInterface, "function");
assert.equal(typeof nodeRuntime.createNodeStandardIo, "function");
assert.equal(typeof nodeRuntime.fileURLToPath, "function");
assert.ok(nodeRuntime.builtinModules.includes("fs"));
assert.equal(nodeRuntime.isBuiltin("stream"), true);
assert.equal(nodeRuntime.isBuiltin("node:stream"), true);
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
    `import { createServiceContext, type StandardIo } from "${packageName}/context";

document.body.dataset.translation = createServiceContext().translate("message.key");

const memoryIo: StandardIo = {
    readStdin: async () => "input",
    prompt: async () => "answer",
    writeStdout: () => undefined,
    writeStderr: () => undefined,
};
void memoryIo;
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
    "browser-rosetta.ts",
    `import { SUPPORTED_I18N_LANGS } from "${packageName}/compat/common/rosetta";

document.body.dataset.supportedLanguages = SUPPORTED_I18N_LANGS.join(",");
`
);
await writeConsumerFile(
    "browser-storage.ts",
    `import { createFileSystemAccessStorage } from "${packageName}/browser";

declare const rootHandle: FileSystemDirectoryHandle;
const storage = createFileSystemAccessStorage({ rootHandle });
void storage;
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
    contextInputs.every(
        (path) => !path.includes("svelte") && !path.includes("messagesJson") && !path.includes("/dist/node/")
    ),
    "The context entry point must not load Svelte, the language catalogue, or Node-only host APIs."
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

const browserRosettaBundle = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser"],
    entryPoints: [resolve(consumerDirectory, "browser-rosetta.ts")],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
});
const browserRosettaInputs = Object.keys(browserRosettaBundle.metafile.inputs);
assert.ok(
    browserRosettaInputs.every((path) => !path.includes("messagesJson")),
    "Importing language contracts must not load the generated message catalogue."
);

const browserStorageBundle = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ["browser"],
    entryPoints: [resolve(consumerDirectory, "browser-storage.ts")],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
});
const browserStorageInputs = Object.keys(browserStorageBundle.metafile.inputs);
assert.ok(
    browserStorageInputs.every((path) => !path.includes("/dist/platform/node/")),
    "The File System Access storage entry must not load Node-only host APIs."
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
assert.ok(
    workerInputs.every((path) => !path.includes("bgWorker.direct")),
    "Browser builds must not use the direct worker."
);
assert.match(workerSource, /new Blob\(/u);
assert.match(workerSource, /new Worker\(/u);

const manifest = JSON.parse(
    await readFile(resolve(consumerDirectory, "node_modules", "@vrtmrz", "livesync-commonlib", "package.json"), "utf8")
);
assert.equal(manifest.name, packageName);
assert.notEqual(manifest.private, true, "The generated package must be publishable.");
assert.deepEqual(
    manifest.publishConfig,
    { access: "public", tag: "next" },
    "The generated package must default to public staged publication on the next dist-tag."
);
assert.ok(Object.hasOwn(manifest.exports, "./browser"));
assert.ok(Object.hasOwn(manifest.exports, "./node"));
assert.deepEqual(
    Object.keys(manifest.exports)
        .filter((path) => !path.startsWith("./compat/"))
        .sort(),
    [".", "./browser", "./context", "./node", "./package.json", "./remote-configurations", "./rpc", "./settings"],
    "The focused package surface must remain explicit."
);
assert.equal(Object.keys(manifest.exports).length, inventory.compatibility.length + 8);

console.log(
    JSON.stringify(
        {
            package: `${manifest.name}@${manifest.version}`,
            integrity: packed.integrity,
            packedBytes: packed.size,
            unpackedBytes: packed.unpackedSize,
            contextBundleBytes: contextBundle.outputFiles[0].contents.length,
            browserServicesBundleBytes: browserServicesBundle.outputFiles[0].contents.length,
            browserStorageBundleBytes: browserStorageBundle.outputFiles[0].contents.length,
            workerBundleBytes: workerBundle.outputFiles[0].contents.length,
        },
        null,
        2
    )
);
