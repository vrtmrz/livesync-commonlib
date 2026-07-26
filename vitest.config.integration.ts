import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@lib": resolve(root, "src"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.integration.spec.ts", "src/**/*.integration.test.ts"],
    },
});
