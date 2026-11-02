import { describe, expect, it, vi } from "vitest";
import { VERSIONING_DOCID } from "@lib/common/types.ts";
import { inspectDatabasePathIdentity } from "./pathIdentityCompatibility.ts";

function databaseWith(document: unknown, count = 0) {
    const get = vi.fn(async () => {
        if (document === undefined) throw { status: 404, name: "not_found" };
        return document;
    });
    const info = vi.fn(async () => ({ doc_count: count }));
    return { get, info };
}

describe("initial remote path identity inspection", () => {
    it("distinguishes an empty remote from legacy data without a declaration", async () => {
        const empty = databaseWith(undefined);
        const legacy = databaseWith(undefined, 1);
        await expect(inspectDatabasePathIdentity(empty as never)).resolves.toEqual({ status: "empty" });
        await expect(inspectDatabasePathIdentity(legacy as never)).resolves.toEqual({
            status: "configured",
            pathNormalizationVersion: 0,
        });
        expect(empty.get).toHaveBeenCalledWith(VERSIONING_DOCID);
    });

    it.each([
        [11, undefined, 0],
        [12, undefined, 0],
        [13, [], 0],
        [13, ["nfc-path-identity-v1"], 1],
    ] as const)(
        "reads the existing declaration for generation %s and features %s",
        async (version, features, expected) => {
            const database = databaseWith({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version,
                ...(features ? { used_features: features } : {}),
            });
            await expect(inspectDatabasePathIdentity(database as never)).resolves.toEqual({
                status: "configured",
                pathNormalizationVersion: expected,
            });
            expect(database.info).not.toHaveBeenCalled();
        }
    );

    it("does not turn an unavailable remote into a new environment", async () => {
        const failure = new Error("remote unavailable");
        const database = {
            get: vi.fn(async () => {
                throw failure;
            }),
            info: vi.fn(),
        };
        await expect(inspectDatabasePathIdentity(database as never)).rejects.toBe(failure);
        expect(database.info).not.toHaveBeenCalled();
    });

    it("rejects unsupported feature declarations", async () => {
        const database = databaseWith({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["future-feature"],
        });
        await expect(inspectDatabasePathIdentity(database as never)).rejects.toThrow();
    });
});
