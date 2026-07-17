/** Node-only host capabilities for Commonlib headless and CLI consumers. */
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeReadlinePromises from "node:readline/promises";
import * as nodeOs from "node:os";
import { builtinModules as nodeBuiltinModules, isBuiltin as nodeIsBuiltin } from "node:module";

export { fileURLToPath, pathToFileURL } from "node:url";
export type { Stats } from "node:fs";

/** Synchronous Node file-system API. */
export const fs = nodeFs;

/** Promise-based Node file-system API. */
export const fsPromises = nodeFsPromises;

/** Node path API. */
export const path = nodePath;

/** Node operating-system API. */
export const os = nodeOs;

/** Promise-based Node readline API. */
export const readline = nodeReadlinePromises;

/** Names recognised by the current Node runtime as built-in modules. */
export const builtinModules = nodeBuiltinModules;

/** Returns whether a module specifier refers to a Node built-in. */
export const isBuiltin = nodeIsBuiltin;

export {
    NodeStorageAdapter,
    createNodeStorage,
    validateStoragePath,
    type CreateNodeStorageOptions,
    type NodeStorageStat,
} from "./storage.ts";
