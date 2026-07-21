import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const temporaryRoots = [];

after(async () => {
    await Promise.all(temporaryRoots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

test("collects compatibility imports from downstream utilities", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "commonlib-downstream-inventory-"));
    temporaryRoots.push(fixtureRoot);
    const packageRoot = join(fixtureRoot, "package");
    const fixtureToolsRoot = join(packageRoot, "_tools");
    const downstreamRoot = join(fixtureRoot, "downstream");

    await mkdir(fixtureToolsRoot, { recursive: true });
    await mkdir(join(packageRoot, "src", "common"), { recursive: true });
    await mkdir(join(downstreamRoot, "src"), { recursive: true });
    await mkdir(join(downstreamRoot, "test"), { recursive: true });
    await mkdir(join(downstreamRoot, "utils"), { recursive: true });
    await mkdir(join(downstreamRoot, "utilsdeno"), { recursive: true });
    await Promise.all([
        cp(join(toolsRoot, "package-boundary.mjs"), join(fixtureToolsRoot, "package-boundary.mjs")),
        cp(
            join(toolsRoot, "update-downstream-import-inventory.mjs"),
            join(fixtureToolsRoot, "update-downstream-import-inventory.mjs")
        ),
        writeFile(join(packageRoot, "src", "common", "types.ts"), "export type Example = string;\n"),
        writeFile(join(packageRoot, "src", "common", "utils.ts"), "export const example = true;\n"),
        writeFile(
            join(downstreamRoot, "utils", "setup.ts"),
            'import type { Example } from "@vrtmrz/livesync-commonlib/compat/common/types";\n'
        ),
        writeFile(
            join(downstreamRoot, "utilsdeno", "migration.ts"),
            'import { example } from "@vrtmrz/livesync-commonlib/compat/common/utils";\n'
        ),
    ]);

    execFileSync("git", ["init", "--quiet", downstreamRoot]);
    execFileSync("git", ["-C", downstreamRoot, "add", "."]);
    execFileSync(
        "git",
        [
            "-C",
            downstreamRoot,
            "-c",
            "user.name=Commonlib test",
            "-c",
            "user.email=commonlib-test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Create downstream fixture",
        ],
        {
            stdio: "ignore",
            env: {
                ...process.env,
                GIT_CONFIG_COUNT: "2",
                GIT_CONFIG_KEY_0: "commit.gpgsign",
                GIT_CONFIG_VALUE_0: "true",
                GIT_CONFIG_KEY_1: "gpg.program",
                GIT_CONFIG_VALUE_1: join(fixtureRoot, "missing-gpg-program"),
            },
        }
    );

    execFileSync(
        process.execPath,
        [join(fixtureToolsRoot, "update-downstream-import-inventory.mjs"), "--downstream", downstreamRoot],
        { stdio: "ignore" }
    );
    const inventory = JSON.parse(
        await readFile(join(packageRoot, "docs", "migration", "downstream-imports.json"), "utf8")
    );

    assert.deepEqual(inventory.compatibility, ["common/types", "common/utils"]);
});
