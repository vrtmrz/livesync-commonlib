#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// A restrictive caller umask previously changed npm tar headers even though
// every generated package file had identical contents. Keep that environment
// in the regular package gate so the builder must produce canonical modes.
process.umask(0o077);

for (const script of ["build-package.mjs", "check-packed-package.mjs"]) {
    execFileSync(process.execPath, [resolve(root, "_tools", script)], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
    });
}
