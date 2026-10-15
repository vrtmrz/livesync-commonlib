import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeStorage } from "./index.ts";

vi.mock("node:fs/promises", () => ({
    lstat: vi.fn(),
    stat: vi.fn(),
}));

describe("Node storage timestamps", () => {
    beforeEach(() => {
        vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as Stats);
    });

    it.each(["stat", "trystat"] as const)("%s preserves creation time when change time advances", async (method) => {
        const storage = createNodeStorage({ rootPath: "/vault" });
        const stats = { birthtimeMs: 1000.9, ctimeMs: 2000.8, mtimeMs: 2000.7, size: 7, isDirectory: () => false };
        vi.mocked(fs.stat).mockResolvedValue(stats as Stats);

        expect(await storage[method]("note.md")).toEqual({ ctime: 1000, mtime: 2000, size: 7, type: "file" });

        vi.mocked(fs.stat).mockResolvedValue({ ...stats, ctimeMs: 3000.8, mtimeMs: 3000.7, size: 8 } as Stats);
        expect(await storage[method]("note.md")).toEqual({ ctime: 1000, mtime: 3000, size: 8, type: "file" });
    });

    it("falls back to change time when creation time is unavailable", async () => {
        vi.mocked(fs.stat).mockResolvedValue({
            birthtimeMs: 0,
            ctimeMs: 2000.8,
            mtimeMs: 3000.7,
            size: 7,
            isDirectory: () => false,
        } as Stats);

        const storage = createNodeStorage({ rootPath: "/vault" });
        expect(await storage.stat("note.md")).toEqual({ ctime: 2000, mtime: 3000, size: 7, type: "file" });
    });
});
