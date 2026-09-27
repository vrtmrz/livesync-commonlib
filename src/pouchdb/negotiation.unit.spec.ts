import { describe, expect, it, vi } from "vitest";
import { VERSIONING_DOCID } from "@lib/common/types";
import { bumpRemoteVersion, checkRemoteVersion } from "./negotiation";
import { assessRemoteFeatureDocument, describeRemoteFeatureRejection } from "./remoteFeatureCompatibility";

function versionDatabase(version: number, used_features?: unknown) {
    const document = {
        _id: VERSIONING_DOCID,
        type: "versioninfo",
        version,
        ...(used_features === undefined ? {} : { used_features }),
    };
    return {
        get: vi.fn(async () => document),
        put: vi.fn(async () => ({ ok: true })),
    } as unknown as PouchDB.Database;
}

describe("remote feature compatibility", () => {
    it("accepts a supported feature in the new remote generation", async () => {
        const db = versionDatabase(13, ["encrypted-internal-metadata-v1"]);
        await expect(checkRemoteVersion(db, vi.fn(async () => false))).resolves.toBe(true);
    });

    it("rejects an undeclared feature list in the legacy generation", async () => {
        const db = versionDatabase(12, ["unknown-future-feature"]);
        await expect(checkRemoteVersion(db, vi.fn(async () => false))).resolves.toBe(false);
    });

    it("continues to accept an unpromoted legacy database", async () => {
        const db = versionDatabase(12);
        await expect(checkRemoteVersion(db, vi.fn(async () => false))).resolves.toBe(true);
        expect(db.put).not.toHaveBeenCalled();
    });

    it("declares the feature before a writer may use its representation", async () => {
        const db = versionDatabase(12);
        await expect(checkRemoteVersion(
            db, vi.fn(async () => false), 12, ["encrypted-internal-metadata-v1"]
        )).resolves.toBe(true);
        expect(db.put).toHaveBeenCalledWith(expect.objectContaining({
            version: 13,
            used_features: ["encrypted-internal-metadata-v1"],
        }));
    });

    it("retains unknown identifiers for a generic diagnostic", () => {
        const assessment = assessRemoteFeatureDocument({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["future-index-v2", "encrypted-internal-metadata-v1", "future-format-v7"],
        });
        expect(assessment).toEqual({
            status: "unknown-features",
            identifiers: ["future-index-v2", "future-format-v7"],
        });
        expect(describeRemoteFeatureRejection(assessment)).toContain("future-index-v2, future-format-v7");
    });

    it.each([
        { version: 13 },
        { version: 13, used_features: "encrypted-internal-metadata-v1" },
        { version: 13, used_features: [""] },
        { version: 12, used_features: [] },
        { version: 13, used_features: [], _deleted: true },
        { version: 13, used_features: [], type: "plain" },
    ])("rejects malformed version documents: %j", (input) => {
        expect(assessRemoteFeatureDocument({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            ...input,
        })).toEqual({ status: "invalid-control" });
    });

    it("preserves unrelated control fields when declaring a feature", async () => {
        const document = {
            _id: VERSIONING_DOCID, _rev: "1-existing", type: "versioninfo", version: 12,
            retained_field: "keep-me",
        };
        const db = {
            get: vi.fn(async () => document),
            put: vi.fn(async () => ({ ok: true })),
        } as unknown as PouchDB.Database;
        await expect(checkRemoteVersion(db, vi.fn(async () => false), 12, [
            "encrypted-internal-metadata-v1",
        ])).resolves.toBe(true);
        expect(db.put).toHaveBeenCalledWith(expect.objectContaining({
            _rev: "1-existing", retained_field: "keep-me", version: 13,
        }));
    });

    it("retains a concurrent writer's feature declaration during an initial version update", async () => {
        const concurrent = {
            _id: VERSIONING_DOCID,
            _rev: "1-concurrent",
            type: "versioninfo",
            version: 13,
            used_features: ["encrypted-internal-metadata-v1"],
        };
        const db = {
            get: vi.fn().mockRejectedValueOnce({ status: 404 }).mockResolvedValue(concurrent),
            put: vi.fn().mockRejectedValueOnce({ status: 409 }),
        } as unknown as PouchDB.Database;

        await expect(bumpRemoteVersion(db, 12)).resolves.toBe(true);
        expect(db.put).toHaveBeenCalledOnce();
    });
});
