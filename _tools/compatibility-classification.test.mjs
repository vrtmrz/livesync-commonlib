import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readJson(path) {
    return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("classifies every current downstream compatibility path exactly once", async () => {
    const inventory = await readJson("../docs/migration/downstream-imports.json");
    const classification = await readJson("../docs/migration/compatibility-classification.json");
    const classifiedPaths = classification.categories.flatMap((category) => category.paths);
    const uniquePaths = new Set(classifiedPaths);

    assert.equal(classification.repository, inventory.repository);
    assert.equal(classification.revision, inventory.revision);
    assert.equal(uniquePaths.size, classifiedPaths.length, "Compatibility classification contains duplicates");
    assert.deepEqual([...uniquePaths].sort(), [...inventory.compatibility].sort());
});
