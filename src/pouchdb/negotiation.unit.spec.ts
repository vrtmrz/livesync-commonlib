import { describe, expect, it, vi } from "vitest";
import { VERSIONING_DOCID } from "@lib/common/types";
import { bumpRemoteVersion, checkRemoteVersion, declareRemoteFeatures } from "./negotiation";
import { assessRemoteFeatureDocument, describeRemoteFeatureRejection, requiredRemoteFeatures } from "./remoteFeatureCompatibility";

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
    it("declares independent ID support and accepts its feature identifier", async () => {
        const features = requiredRemoteFeatures({
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: "v2",
            encryptInternalMetadata: false,
            idDerivationVersion: 1,
            idDerivationKey: "f3205cc41d24116d8c2484993c9d9a2e667373af338ba02f2ee71199adb82f2e",
        });
        expect(features).toEqual(["independent-id-derivation-v1"]);
        const db = versionDatabase(12);
        await expect(checkRemoteVersion(db, vi.fn(async () => false), 12, features)).resolves.toBe(true);
        expect(db.put).toHaveBeenCalledWith(expect.objectContaining({ version: 13, used_features: features }));
        expect(assessRemoteFeatureDocument({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: features,
        })).toEqual({ status: "supported", usedFeatures: features });
    });

    it("does not declare independent ID support while E2EE is off", () => {
        expect(requiredRemoteFeatures({
            encrypt: false,
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        })).toEqual([]);
    });

    it("accepts generation 13 with a declared feature when feature writes are disabled", async () => {
        const features = ["encrypted-internal-metadata-v1"];
        const db = versionDatabase(13, features);
        await expect(checkRemoteVersion(db, vi.fn(async () => false))).resolves.toBe(true);
        expect(db.put).not.toHaveBeenCalled();
        await expect(db.get(VERSIONING_DOCID)).resolves.toMatchObject({
            version: 13,
            used_features: features,
        });
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

    it.each([false, true])("re-reads a 409 conflict and preserves fields (feature already declared: %s)", async (declared) => {
        const feature = "encrypted-internal-metadata-v1";
        const concurrent: Record<string, unknown> = {
            _id: VERSIONING_DOCID,
            _rev: "2-concurrent",
            type: "versioninfo",
            version: declared ? 13 : 12,
            ...(declared ? { used_features: [feature] } : {}),
            retained_field: "keep-concurrent-value",
        };
        let current: Record<string, unknown> = {
            _id: VERSIONING_DOCID,
            _rev: "1-stale",
            type: "versioninfo",
            version: 12,
            retained_field: "stale-value",
        };
        let rejectFirstPut = true;
        const db = {
            get: vi.fn(async () => current),
            put: vi.fn(async (document: unknown) => {
                if (rejectFirstPut) {
                    rejectFirstPut = false;
                    current = concurrent;
                    throw { status: 409 };
                }
                current = document as Record<string, unknown>;
                return { ok: true };
            }),
        } as unknown as PouchDB.Database;

        await expect(declareRemoteFeatures(db, [feature])).resolves.toBe(true);
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.put).toHaveBeenCalledTimes(declared ? 1 : 2);
        expect(current).toEqual({ ...concurrent, version: 13, used_features: [feature] });

        await expect(declareRemoteFeatures(db, [feature])).resolves.toBe(true);
        expect(db.get).toHaveBeenCalledTimes(3);
        expect(db.put).toHaveBeenCalledTimes(declared ? 1 : 2);
        expect(current).toEqual({ ...concurrent, version: 13, used_features: [feature] });
    });

    it("rejects and preserves an unknown feature added during a 409 conflict", async () => {
        const concurrent: Record<string, unknown> = {
            _id: VERSIONING_DOCID,
            _rev: "2-concurrent",
            type: "versioninfo",
            version: 13,
            used_features: ["unknown-future-feature"],
            retained_field: "keep-concurrent-value",
        };
        let current: Record<string, unknown> = {
            _id: VERSIONING_DOCID,
            _rev: "1-stale",
            type: "versioninfo",
            version: 12,
        };
        const db = {
            get: vi.fn(async () => current),
            put: vi.fn(async () => {
                current = concurrent;
                throw { status: 409 };
            }),
        } as unknown as PouchDB.Database;

        await expect(declareRemoteFeatures(db, ["encrypted-internal-metadata-v1"])).resolves.toBe(false);
        expect(db.get).toHaveBeenCalledTimes(2);
        expect(db.put).toHaveBeenCalledOnce();
        expect(current).toEqual(concurrent);
    });
});
