import assert from "node:assert/strict";
import { test } from "node:test";

import { extractImportSpecifiers, isForbiddenPackageImport } from "./package-boundary.mjs";

test("extracts static, type-only, side-effect, export, and dynamic imports", () => {
    const source = `
        import value from "@/value";
        import type { Type } from "obsidian";
        import "./side-effect.js";
        export { item } from "@lib/item";
        const dynamic = import("obsidian/unsupported");
    `;
    assert.deepEqual(extractImportSpecifiers(source), [
        "./side-effect.js",
        "@/value",
        "@lib/item",
        "obsidian",
        "obsidian/unsupported",
    ]);
});

test("ignores imports in line and block comments", () => {
    const source = `
        // import type { ParentType } from "@/deps";
        /*
         * export { parentValue } from "@/parent";
         */
        import { localValue } from "@lib/local";
    `;
    assert.deepEqual(extractImportSpecifiers(source), ["@lib/local"]);
});

test("rejects host aliases and Obsidian imports without rejecting package-local aliases", () => {
    assert.equal(isForbiddenPackageImport("@/common/events"), true);
    assert.equal(isForbiddenPackageImport("obsidian"), true);
    assert.equal(isForbiddenPackageImport("obsidian/unsupported"), true);
    assert.equal(isForbiddenPackageImport("@lib/common/types"), false);
    assert.equal(isForbiddenPackageImport("octagonal-wheels/promises"), false);
});
