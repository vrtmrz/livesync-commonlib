import { describe, expect, it, vi } from "vitest";

import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";

function createCore(storage: Partial<IJournalStorage>): JournalSyncCore {
    return new JournalSyncCore(
        {} as BucketSyncSetting,
        {} as never,
        {} as LiveSyncJournalReplicatorEnv,
        storage as IJournalStorage
    );
}

describe("JournalSyncCore JSON conditional writes", () => {
    it("forwards a JSON read revision with the parsed value", async () => {
        const storage = {
            downloadWithResult: vi.fn(async () => ({
                status: "available" as const,
                value: new TextEncoder().encode('{"node":"device"}'),
                revision: '"etag-1"',
            })),
        };
        const core = createCore(storage);

        await expect(core.downloadJsonWithResult<{ node: string }>("node.json")).resolves.toEqual({
            status: "available",
            value: { node: "device" },
            revision: '"etag-1"',
        });
        expect(storage.downloadWithResult).toHaveBeenCalledWith("node.json", true);
    });

    it("keeps the JSON result shape when the storage result has no revision", async () => {
        const storage = {
            downloadWithResult: vi.fn(async () => ({
                status: "available" as const,
                value: new TextEncoder().encode('{"node":"device"}'),
            })),
        };
        const core = createCore(storage);

        await expect(core.downloadJsonWithResult<{ node: string }>("node.json")).resolves.toEqual({
            status: "available",
            value: { node: "device" },
        });
    });

    it("encodes JSON and forwards the key, mime type, and revision", async () => {
        const uploadIfUnchanged = vi.fn(async () => "updated" as const);
        const storage = {
            upload: vi.fn(async () => true),
            uploadIfUnchanged,
        };
        const core = createCore(storage);

        await expect(core.uploadJsonIfUnchanged("node.json", { forgotten: true }, '"etag-1"')).resolves.toBe("updated");
        expect(uploadIfUnchanged).toHaveBeenCalledWith(
            "node.json",
            new TextEncoder().encode('{"forgotten":true}'),
            "application/json",
            '"etag-1"'
        );
        expect(storage.upload).not.toHaveBeenCalled();
    });

    it("returns unsupported without falling back to an unconditional upload", async () => {
        const upload = vi.fn(async () => true);
        const core = createCore({ upload });

        await expect(core.uploadJsonIfUnchanged("node.json", { forgotten: true }, '"etag-1"')).resolves.toBe(
            "unsupported"
        );
        expect(upload).not.toHaveBeenCalled();
    });

    it("rejects an empty revision before invoking storage", async () => {
        const uploadIfUnchanged = vi.fn(async () => "updated" as const);
        const core = createCore({ uploadIfUnchanged });

        await expect(core.uploadJsonIfUnchanged("node.json", {}, "")).rejects.toThrow(TypeError);
        expect(uploadIfUnchanged).not.toHaveBeenCalled();
    });
});
