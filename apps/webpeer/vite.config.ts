import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vite.dev/config/
export default defineConfig({
    plugins: [svelte()],
    base: "./",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: "index.html",
                // uitest: "uitest.html",
            },
        },
    },
});
