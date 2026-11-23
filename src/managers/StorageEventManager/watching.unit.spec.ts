import { describe, expect, it } from "vitest";
import type { FilePath } from "@lib/common/types";
import type { IStorageEventTypeGuardAdapter } from "../adapters";
import { isStorageEventPath, isWatchedFile, readEditorChangePath } from "./watching";

type HostFile = { kind: "file"; path: unknown };
const guard: IStorageEventTypeGuardAdapter<HostFile, { kind: "folder" }> = {
    isFile(value): value is HostFile {
        return (
            typeof value === "object" && value !== null && "kind" in value && value.kind === "file" && "path" in value
        );
    },
    isFolder(value): value is { kind: "folder" } {
        return typeof value === "object" && value !== null && "kind" in value && value.kind === "folder";
    },
};

describe("StorageEventManager watcher payloads", () => {
    it("requires both a platform file and a string path before narrowing", () => {
        expect(isWatchedFile({ kind: "folder", path: "folder" }, guard)).toBe(false);
        expect(isWatchedFile({ kind: "file", path: 42 }, guard)).toBe(false);
        expect(isWatchedFile({ path: "unrecognised.md" }, guard)).toBe(false);
        expect(isWatchedFile(null, guard)).toBe(false);
        const candidate: unknown = { kind: "file", path: "notes/current.md" };
        if (!isWatchedFile(candidate, guard)) throw new Error("Expected a recognised host file");
        const path: FilePath = candidate.path;
        expect(path).toBe("notes/current.md");
        expect(candidate.kind).toBe("file");
    });

    it("preserves the host path verbatim without database-prefix normalisation", () => {
        const path: unknown = "folder/note:part.md";
        if (!isStorageEventPath(path)) throw new Error("Expected a host path");
        const accepted: FilePath = path;
        expect(accepted).toBe("folder/note:part.md");
    });

    it("uses a recognised file's path ahead of the editor envelope", () => {
        const file = { kind: "file", path: "current.md" };
        expect(readEditorChangePath({ path: "stale.md", file }, guard.isFile)).toBe("current.md");
    });

    it("retains the envelope-path fallback for other host editor payloads", () => {
        const file = { hostMetadata: true };
        expect(readEditorChangePath({ path: "current.md", file }, guard.isFile)).toBe("current.md");
    });

    it("rejects unusable editor payloads and paths", () => {
        const file = { kind: "file", path: 42 };
        expect(readEditorChangePath({ path: "fallback.md", file }, guard.isFile)).toBeNull();
        expect(readEditorChangePath({ path: 42, file: {} }, guard.isFile)).toBeNull();
        expect(readEditorChangePath({ path: "current.md" }, guard.isFile)).toBeNull();
    });
});
