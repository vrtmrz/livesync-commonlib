import { describe, expect, it } from "vitest";

import type { FilePathWithPrefix } from "@lib/common/types";

import { createFileHandlerFixture } from "../../../_tools/fixtures/file-handler-context";
import { queueConflictCheckFor, withFileEventPaths } from "./locking";

describe("withFileEventPaths", () => {
    // The outcome table covers normal completion, hook failure, and callback failure with a simultaneous hook failure.
    it("delivers deferred hooks after the document queue is cleared", async () => {
        const fixture = createFileHandlerFixture();
        const path = "locked.md" as FilePathWithPrefix;
        fixture.conflict.queueCheckFor.mockImplementation(async () => {
            expect(fixture.ctx.state.deferredConflictChecks.size).toBe(0);
        });

        const result = await withFileEventPaths(fixture.ctx, [path], async () => {
            await queueConflictCheckFor(fixture.ctx, path);
            expect(fixture.conflict.queueCheckFor).not.toHaveBeenCalled();
            return "completed";
        });

        expect(result).toBe("completed");
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(path);
    });

    it("propagates a post-lock conflict-hook failure", async () => {
        const fixture = createFileHandlerFixture();
        const path = "hook-error.md" as FilePathWithPrefix;
        const hookError = new Error("conflict queue failed");
        fixture.conflict.queueCheckFor.mockRejectedValueOnce(hookError);

        await expect(
            withFileEventPaths(fixture.ctx, [path], async () => {
                await queueConflictCheckFor(fixture.ctx, path);
                return true;
            })
        ).rejects.toBe(hookError);

        expect(fixture.ctx.state.deferredConflictChecks.size).toBe(0);
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(path);
    });

    it("keeps a callback failure authoritative when the deferred hook also fails", async () => {
        const fixture = createFileHandlerFixture();
        const path = "callback-error.md" as FilePathWithPrefix;
        const callbackError = new Error("locked operation failed");
        const hookError = new Error("open-conflict hook failed");
        fixture.conflict.queueCheckForIfOpen.mockRejectedValueOnce(hookError);

        await expect(
            withFileEventPaths(fixture.ctx, [path], async () => {
                await queueConflictCheckFor(fixture.ctx, path, true);
                throw callbackError;
            })
        ).rejects.toBe(callbackError);

        expect(fixture.ctx.state.deferredConflictChecks.size).toBe(0);
        expect(fixture.conflict.queueCheckForIfOpen).toHaveBeenCalledExactlyOnceWith(path);
        expect(fixture.conflict.queueCheckFor).not.toHaveBeenCalled();
    });
});

describe("queueConflictCheckFor", () => {
    it("delivers the selected hook immediately when no file lock is active", async () => {
        const fixture = createFileHandlerFixture();
        const path = "unlocked.md" as FilePathWithPrefix;

        await queueConflictCheckFor(fixture.ctx, path, true);
        await queueConflictCheckFor(fixture.ctx, path);

        expect(fixture.conflict.queueCheckForIfOpen).toHaveBeenCalledExactlyOnceWith(path);
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(path);
    });
});
