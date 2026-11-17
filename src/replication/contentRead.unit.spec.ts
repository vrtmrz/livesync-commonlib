import { describe, expect, it } from "vitest";
import { ContentReadError } from "./contentRead";
import { LiveSyncError } from "@lib/common/LSError";
import type { DocumentID } from "@lib/common/types";

describe("terminal content-read error", () => {
    it.each([undefined, null, false, "opaque cause", new LiveSyncError("default status"), { name: "AbortError", status: 503 }])("preserves unknown cause identity without deriving resources: %o", (cause) => {
        const error = new ContentReadError({ documentId: "note.md" as DocumentID, revision: "2-target", resources: [], cause });
        expect(error.cause).toBe(cause);
        expect(error.failure.resources).toEqual([]);
    });
    it("retains both directly observed resources independently of cause names", () => {
        const cause = new Error("diagnostic");
        const error = new ContentReadError({ documentId: "note.md" as DocumentID, resources: ["local-database", "remote"], cause });
        expect(error.failure.resources).toEqual(["local-database", "remote"]);
        expect(error.failure.cause).toBe(cause);
    });
});
