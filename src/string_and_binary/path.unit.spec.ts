import { beforeEach, describe, expect, it, vi } from "vitest";

const minimatchStats = vi.hoisted(() => ({ constructions: 0 }));
const webCryptoStats = vi.hoisted(() => ({ digests: 0 }));

vi.mock("minimatch", async (importOriginal) => {
    const actual = await importOriginal<typeof import("minimatch")>();

    class CountingMinimatch extends actual.Minimatch {
        constructor(pattern: string, options?: import("minimatch").MinimatchOptions) {
            super(pattern, options);
            minimatchStats.constructions++;
        }
    }

    return {
        ...actual,
        Minimatch: CountingMinimatch,
    };
});

vi.mock("@lib/mods.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lib/mods.ts")>();
    const webcrypto = await actual.getWebCrypto();
    const countedWebCrypto = {
        subtle: {
            digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
                webCryptoStats.digests++;
                return webcrypto.subtle.digest(algorithm, data);
            },
        },
    } as Crypto;

    return {
        ...actual,
        getWebCrypto: async () => countedWebCrypto,
    };
});

import type { FilePath } from "@lib/common/types";
import { isAccepted, path2id_base } from "./path";

describe("path2id_base path case", () => {
    it("maps case variants to one document ID in case-insensitive mode", async () => {
        const upperCasePath = await path2id_base("Calculus.md" as FilePath, false, true);
        const lowerCasePath = await path2id_base("calculus.md" as FilePath, false, true);

        expect(upperCasePath).toBe(lowerCasePath);
    });

    it("keeps case variants separate in case-sensitive mode", async () => {
        const upperCasePath = await path2id_base("Calculus.md" as FilePath, false, false);
        const lowerCasePath = await path2id_base("calculus.md" as FilePath, false, false);

        expect(upperCasePath).not.toBe(lowerCasePath);
    });
});

describe("path2id_base path obfuscation", () => {
    it("performs one digest for each uncached hash input", async () => {
        webCryptoStats.digests = 0;
        const passphrase = "digest-count-regression-secret";

        await path2id_base("First.md" as FilePath, passphrase, false);
        expect(webCryptoStats.digests).toBe(2);

        await path2id_base("Second.md" as FilePath, passphrase, false);
        expect(webCryptoStats.digests).toBe(3);
    });

    it.each([
        ["資料/概要.md", true, "f:d17ef57666777963bdb6875c83e16b39fee9ca7f7c3593f1b50af691c7bc2fa8"],
        ["_private/Calculus.md", false, "f:2a18fa03d734284a8ace4d3c0a7b65558209b8f092ae36be1fdfc3626bc99268"],
    ])("keeps the established document ID for %s", async (path, caseInsensitive, expected) => {
        await expect(
            path2id_base(path as FilePath, "path-obfuscation-regression-secret", caseInsensitive)
        ).resolves.toBe(expected);
    });
});

describe("isAccepted matcher cache", () => {
    beforeEach(() => {
        minimatchStats.constructions = 0;
    });

    it("reuses compiled matchers for the same ignore array", () => {
        const ignore = ["*.tmp"];

        expect(isAccepted("scratch.tmp", ignore)).toBe(false);
        expect(isAccepted("other.tmp", ignore)).toBe(false);

        expect(minimatchStats.constructions).toBe(1);
    });

    it("compiles new matchers when the ignore array is replaced", () => {
        const original = ["*.tmp"];
        const replacement = ["*.tmp"];

        expect(isAccepted("scratch.tmp", original)).toBe(false);
        expect(isAccepted("scratch.tmp", replacement)).toBe(false);

        expect(minimatchStats.constructions).toBe(2);
    });
});
