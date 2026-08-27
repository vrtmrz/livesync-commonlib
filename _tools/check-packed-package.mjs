#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageDirectory = resolve(root, ".package");
const artefactDirectory = resolve(root, "artifacts");
const consumerDirectory = resolve(root, ".package-consumer");
const packageName = "@vrtmrz/livesync-commonlib";
const inventory = JSON.parse(await readFile(resolve(root, "docs/migration/downstream-imports.json"), "utf8"));

function formatFileMode(mode) {
    return typeof mode === "number" ? mode.toString(8).padStart(4, "0") : String(mode);
}

function normalisePackagePath(path) {
    return path.replace(/^\.\//u, "");
}

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
const generatedManifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
const declaredBinTargets = new Set(
    (typeof generatedManifest.bin === "string"
        ? [generatedManifest.bin]
        : Object.values(generatedManifest.bin ?? {})
    ).map(normalisePackagePath)
);
for (const file of packed.files) {
    const expectedMode = declaredBinTargets.has(normalisePackagePath(file.path)) ? 0o755 : 0o644;
    assert.equal(
        file.mode,
        expectedMode,
        `Packed file '${file.path}' has mode ${formatFileMode(file.mode)}; expected ${formatFileMode(expectedMode)}.`
    );
}
assert.equal(
    generatedManifest.types,
    "./dist/index.d.ts",
    "The generated package manifest must declare its root type entry for legacy TypeScript resolution."
);
assert.ok(
    generatedManifest.typesVersions?.["*"],
    "The generated package manifest must include typesVersions for legacy TypeScript resolution."
);
const exportedSubpaths = Object.keys(generatedManifest.exports)
    .filter((subpath) => subpath !== "." && subpath !== "./package.json")
    .map((subpath) => subpath.slice(2))
    .sort();
assert.deepEqual(
    Object.keys(generatedManifest.typesVersions["*"]).sort(),
    exportedSubpaths,
    "Every public subpath must have a declaration mapping."
);
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
    packed.files.some(({ path }) => path === "docs/conflict-resolution.md"),
    "The conflict-resolution guide linked from the README must be included in the package."
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
assert.ok(
    packed.files.every(
        ({ path }) =>
            path !== "dist/common/i18n.js" &&
            path !== "dist/common/i18n.d.ts" &&
            path !== "dist/common/rosetta.js" &&
            path !== "dist/common/rosetta.d.ts" &&
            !path.startsWith("dist/common/messages/") &&
            !path.startsWith("dist/common/messagesJson/")
    ),
    "The Commonlib package must not publish the LiveSync-owned translation runtime or catalogue."
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
import {
    DirectFileManipulator,
    type DirectFileManipulatorOptions,
    type DirectFileManipulatorRuntimeOptions,
} from "${packageName}";
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
import {
    NO_INTERACTION,
    isReplicationCompleted,
    type ReplicationOutcome,
} from "${packageName}/replication";
import type {
    CouchDBReplicationConnection,
    LiveSyncCouchDBReplicator,
    OwnedCouchDBConnection,
    RemoteConnectionOpenOptions,
} from "${packageName}/compat/replication/couchdb/LiveSyncReplicator";

const options: ServiceContextOptions = { translate: (key) => \`translated:\${key}\` };
const context = createServiceContext(options);
const contextContract: ServiceContextContract = context;
const untranslated: string = passthroughMessageTranslator("moduleLocalDatabase.logWaitingForReady");
const split = splitPieces2Worker(new Blob(["content"], { type: "text/plain" }), 4, false, 1);
const directOptions = {} as DirectFileManipulatorOptions;
const directRuntimeOptions: DirectFileManipulatorRuntimeOptions = { fetch: globalThis.fetch };
const directType: typeof DirectFileManipulator = DirectFileManipulator;
const createDirect = (options: DirectFileManipulatorOptions): DirectFileManipulator =>
    new DirectFileManipulator(options, directRuntimeOptions);
const fileSystemAccessOptions = {} as CreateFileSystemAccessStorageOptions;
const fileSystemAccessFactory: typeof createFileSystemAccessStorage = createFileSystemAccessStorage;
const prepared = prepareSettingsForLoad(undefined);
const migrationState: SettingsMigrationState = prepared;
const newVaultSetting = NEW_VAULT_SETTINGS.usePluginSyncV2;
const schemaFallback = SETTINGS_SCHEMA_DEFAULTS.usePluginSyncV2;
const mutableNewVaultSettings = createNewVaultSettings();
const remoteConfigurationOptions: UpsertRemoteConfigurationOptions = { activate: true };
const remoteConfigurationUpsert: typeof upsertRemoteConfigurationInPlace = upsertRemoteConfigurationInPlace;
const remoteConnectionOptions: RemoteConnectionOpenOptions = { allowNativeFallback: false };
const closeRemoteConnection = (connection: OwnedCouchDBConnection<Record<string, unknown>>): Promise<void> =>
    connection.close();
const replicationConnection = {} as CouchDBReplicationConnection;
type LegacyRemoteDatabase = Awaited<ReturnType<LiveSyncCouchDBReplicator["_ensureConnection"]>>;
const readLegacyRemoteDatabase = (database: LegacyRemoteDatabase) => database.get("document-id");
const completedOutcome: ReplicationOutcome = { status: "completed" };
const noInteractionKind: string = NO_INTERACTION.kind;
const completedCheck: boolean = isReplicationCompleted(completedOutcome);
void context;
void contextContract;
void untranslated;
void split;
void directOptions;
void directRuntimeOptions;
void directType;
void createDirect;
void fileSystemAccessOptions;
void fileSystemAccessFactory;
void migrationState;
void newVaultSetting;
void schemaFallback;
void mutableNewVaultSettings;
void remoteConfigurationOptions;
void remoteConfigurationUpsert;
void remoteConnectionOptions;
void closeRemoteConnection;
void replicationConnection;
void readLegacyRemoteDatabase;
void noInteractionKind;
void completedCheck;
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
const replicationApi = await import("${packageName}/replication");
const workerApi = await import("${packageName}/compat/worker/bgWorker");
const runtimeCompat = await import("${packageName}/compat/common/coreEnvFunctions");
const nodeRuntime = await import("${packageName}/node");
const p2pFeatureApi = await import(
    "${packageName}/compat/replication/trystero/useP2PReplicatorFeature"
);

assert.equal(
    contextApi.createServiceContext().translate("moduleCheckRemoteSize.optionIncreaseLimit", { newMax: "800" }),
    "increase to 800MB"
);
assert.equal(typeof rootApi.DirectFileManipulator, "function");
assert.equal(settingsApi.NEW_VAULT_SETTINGS.usePluginSyncV2, true);
assert.equal(settingsApi.SETTINGS_SCHEMA_DEFAULTS.usePluginSyncV2, false);
assert.equal(settingsApi.prepareSettingsForLoad(undefined).isNewVault, true);
assert.notEqual(settingsApi.createNewVaultSettings(), settingsApi.NEW_VAULT_SETTINGS);
assert.equal(typeof remoteConfigurationsApi.upsertRemoteConfigurationInPlace, "function");
assert.equal(replicationApi.NO_INTERACTION.kind, "forbidden");
assert.equal(typeof replicationApi.isReplicationCompleted, "function");
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

document.body.dataset.translation = createServiceContext().translate("moduleLocalDatabase.logWaitingForReady");

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
    "dialogue-compat.ts",
    `import { SvelteDialogMixIn } from "${packageName}/compat/services/implements/base/SvelteDialog";

void SvelteDialogMixIn;
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
assert.ok(
    contextBundle.outputFiles[0].contents.length < 50_000,
    "The context bundle, including the canonical English fallback, has grown unexpectedly."
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
const installedPackageDirectory = resolve(consumerDirectory, "node_modules", "@vrtmrz", "livesync-commonlib");
const { default: ts } = await import("typescript");
const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
};
const containingFile = resolve(consumerDirectory, "type-smoke.ts");
const rootResolution = ts.resolveModuleName(packageName, containingFile, compilerOptions, ts.sys);
assert.equal(
    relative(installedPackageDirectory, rootResolution.resolvedModule?.resolvedFileName ?? "")
        .split("\\")
        .join("/"),
    manifest.types.replace(/^\.\//u, ""),
    "Node10 resolution selected an unexpected root declaration."
);
for (const [subpath, targets] of Object.entries(manifest.typesVersions["*"])) {
    assert.equal(targets.length, 1, `Expected one declaration target for '${subpath}'.`);
    const resolution = ts.resolveModuleName(`${packageName}/${subpath}`, containingFile, compilerOptions, ts.sys);
    const resolved = resolution.resolvedModule?.resolvedFileName;
    assert.ok(resolved, `Node10 resolution could not resolve '${packageName}/${subpath}'.`);
    assert.equal(
        relative(installedPackageDirectory, resolved).split("\\").join("/"),
        targets[0],
        `Node10 resolution selected an unexpected declaration for '${packageName}/${subpath}'.`
    );
}
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
    [
        ".",
        "./browser",
        "./context",
        "./node",
        "./package.json",
        "./remote-configurations",
        "./replication",
        "./rpc",
        "./settings",
    ],
    "The focused package surface must remain explicit."
);
assert.equal(Object.keys(manifest.exports).length, inventory.compatibility.length + 9);

console.log(
    JSON.stringify(
        {
            package: `${manifest.name}@${manifest.version}`,
            integrity: packed.integrity,
            packedBytes: packed.size,
            unpackedBytes: packed.unpackedSize,
            contextBundleBytes: contextBundle.outputFiles[0].contents.length,
            browserStorageBundleBytes: browserStorageBundle.outputFiles[0].contents.length,
            workerBundleBytes: workerBundle.outputFiles[0].contents.length,
        },
        null,
        2
    )
);
