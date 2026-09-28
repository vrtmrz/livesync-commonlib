import { describe, expect, it } from "vitest";
import {
    computeKeyedId,
    configuredIdKey,
    deriveIdKey,
    deriveOrImportIdKey,
    formatIdRecoveryCode,
} from "./idDerivation.ts";

const key = "f3205cc41d24116d8c2484993c9d9a2e667373af338ba02f2ee71199adb82f2e";

describe("independent ID derivation", () => {
    it("derives the portable PBKDF2 key from a source at save time", async () => {
        await expect(deriveIdKey("sample source")).resolves.toBe(key);
        await expect(deriveIdKey("cafe\u0301")).resolves.toBe(await deriveIdKey("café"));
        await expect(deriveIdKey("sample source ")).resolves.not.toBe(key);
        await expect(deriveIdKey("")).rejects.toThrow("source");
    });

    it("round-trips a saved key through a tagged recovery code without deriving it twice", async () => {
        const code = formatIdRecoveryCode(key);
        expect(code).toBe(`sls-id-v1:${key}`);
        await expect(deriveOrImportIdKey(code)).resolves.toBe(key);
        await expect(deriveOrImportIdKey(`\n${code}\n`)).resolves.toBe(key);
        await expect(deriveOrImportIdKey("sample source")).resolves.toBe(key);
        await expect(deriveOrImportIdKey("sls-id-v1:wrong")).rejects.toThrow("recovery code");
        await expect(deriveOrImportIdKey(`sls-id-v2:${key}`)).rejects.toThrow("unsupported");
        expect(() => formatIdRecoveryCode("wrong")).toThrow("key");
    });

    it("uses the full key and distinct purposes for content and paths", async () => {
        await expect(computeKeyedId(key, "chunk", "sample chunk")).resolves.toBe(
            "c277e863054a30ef61beed1a3165b999a093d73e8282859cd6d0a6e61c95dfdf"
        );
        await expect(computeKeyedId(key, "document", "sample chunk")).resolves.toBe(
            "a2a525f9d994e83f29588ad43513be468e137135a88689cd0790e48834d9d3f3"
        );
    });

    it("rejects partial or unsupported configuration instead of falling back", () => {
        expect(configuredIdKey({ idDerivationVersion: 0, idDerivationKey: "" })).toBe(false);
        expect(configuredIdKey({ idDerivationVersion: 1, idDerivationKey: key })).toBe(key);
        expect(() => configuredIdKey({ idDerivationVersion: 1, idDerivationKey: "" })).toThrow();
        expect(() => configuredIdKey({ idDerivationVersion: 0, idDerivationKey: key })).toThrow();
        expect(() => configuredIdKey({ idDerivationVersion: 2 as 1, idDerivationKey: key })).toThrow();
    });
});
