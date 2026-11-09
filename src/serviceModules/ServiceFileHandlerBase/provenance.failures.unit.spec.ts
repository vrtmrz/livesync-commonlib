import { describe, expect, it, vi } from "vitest";
import type { FilePathWithPrefix } from "@lib/common/types";
import { createFileHandlerFixture, makeFile } from "../../../_tools/fixtures/file-handler-context";
import { contentEvidence, deleteProvenance, findUniqueContentRevision, setProvenance } from "./provenance";

const path = "evidence.md" as FilePathWithPrefix;

describe("provenance boundary failure decisions", () => {
    it("evicts a failed content hash and retries the same immutable Blob on a later request", async () => {
        const f = createFileHandlerFixture();
        const body = new Blob(["immutable bytes"]);
        const error = new Error("content read failed");
        const read = vi.spyOn(body, "arrayBuffer").mockRejectedValueOnce(error);
        await expect(contentEvidence(f.ctx, body)).resolves.toEqual({});
        expect(f.ctx.state.contentHashes.has(body)).toBe(false);
        expect(f.log).toHaveBeenCalledWith(error, expect.any(Number));

        await expect(contentEvidence(f.ctx, body)).resolves.toEqual({
            contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            contentSize: body.size,
        });
        await contentEvidence(f.ctx, body);
        expect(read).toHaveBeenCalledTimes(2);
        expect(f.provenance.set).not.toHaveBeenCalled();
        expect(f.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("does not read or hash a body when the host has no provenance service", async () => {
        const f = createFileHandlerFixture({ includeProvenance: false });
        const body = new Blob(["local bytes"]);
        const read = vi.spyOn(body, "arrayBuffer");
        await expect(contentEvidence(f.ctx, body)).resolves.toEqual({});
        await setProvenance(f.ctx, path, "1-local", 1, body);
        await deleteProvenance(f.ctx, path);
        expect(read).not.toHaveBeenCalled();
        expect(f.provenance.set).not.toHaveBeenCalled();
        expect(f.provenance.delete).not.toHaveBeenCalled();
    });

    it("retains best-effort deletion failure for diagnostics without reversing a caller's completed effect", async () => {
        const f = createFileHandlerFixture();
        const error = new Error("provenance delete failed");
        f.provenanceRecords.set(path, { revision: "1-local" });
        f.provenance.delete.mockRejectedValue(error);
        await expect(deleteProvenance(f.ctx, path)).resolves.toBeUndefined();
        expect(f.provenanceRecords.get(path)).toEqual({ revision: "1-local" });
        expect(f.log).toHaveBeenCalledWith(error, expect.any(Number));
        expect(f.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });

    it("treats a history lookup error as unknown ancestry without guessing a revision", async () => {
        const f = createFileHandlerFixture();
        const file = makeFile(path, "edited bytes");
        const error = new Error("history lookup failed");
        f.db.findContentRevisions.mockRejectedValue(error);
        await expect(findUniqueContentRevision(f.ctx, file)).resolves.toBeUndefined();
        expect(f.log).toHaveBeenCalledWith(error, expect.any(Number));
        expect(f.provenance.set).not.toHaveBeenCalled();
        expect(f.db.storeWithBaseRevision).not.toHaveBeenCalled();
    });
});
