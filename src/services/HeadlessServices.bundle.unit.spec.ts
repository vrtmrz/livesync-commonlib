import { describe, expect, it } from "vitest";
import { build } from "esbuild";

describe("HeadlessServiceHub bundle", () => {
    it("does not import the Svelte runtime", async () => {
        const result = await build({
            entryPoints: [new URL("./HeadlessServices.ts", import.meta.url).pathname],
            bundle: true,
            conditions: ["node"],
            format: "esm",
            metafile: true,
            packages: "external",
            platform: "node",
            write: false,
        });

        const externalImports = Object.values(result.metafile.outputs)
            .flatMap((output) => output.imports)
            .filter((entry) => entry.external)
            .map((entry) => entry.path);

        expect(externalImports).not.toContain("svelte");
    });
});
