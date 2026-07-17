#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { collectBoundaryFindings } from "./package-boundary.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const baselinePath = resolve(root, "_tools/package-boundary-baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const actual = await collectBoundaryFindings(root);

const serialise = (finding) => `${finding.file}: ${finding.specifier}`;
const expectedSet = new Set(baseline.forbiddenImports.map(serialise));
const actualSet = new Set(actual.map(serialise));
const added = [...actualSet].filter((finding) => !expectedSet.has(finding));
const removed = [...expectedSet].filter((finding) => !actualSet.has(finding));

if (added.length > 0 || removed.length > 0) {
    if (added.length > 0) console.error(`New forbidden package imports:\n- ${added.join("\n- ")}`);
    if (removed.length > 0) {
        console.error(`Resolved imports still present in the baseline:\n- ${removed.join("\n- ")}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Package boundary matches the ${actual.length}-import migration baseline.`);
}
