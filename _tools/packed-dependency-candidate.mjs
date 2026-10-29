import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Reads an explicitly selected local Octagonal Wheels candidate for package tests.
 * The caller applies it only to the disposable consumer, never to the packed manifest.
 */
export async function loadOctagonalWheelsCandidate(args) {
    if (args.length === 0) return undefined;
    if (args.length !== 2 || args[0] !== "--octagonal-wheels-tarball" || !args[1]) {
        throw new Error("Usage: check-packed-package.mjs [--octagonal-wheels-tarball <local-tarball>]");
    }
    const path = resolve(args[1]);
    const bytes = await readFile(path);
    return {
        path,
        url: pathToFileURL(path).href,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
