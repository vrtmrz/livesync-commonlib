#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

// A restrictive caller umask previously changed npm tar headers even though
// every generated package file had identical contents. Keep that environment
// in the regular package gate so the builder must produce canonical modes.
process.umask(0o077);

for (const script of ["build:package", "check:package"]) {
    execFileSync(npmCommand, ["run", script], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
    });
}
