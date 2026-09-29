import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HashManager } from "./HashManager.ts";
import { DEFAULT_SETTINGS, HashAlgorithms, type HashAlgorithm, type RemoteDBSettings } from "@lib/common/types.ts";
import { HashEncryptedPrefix } from "./HashManagerCore.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";
import { getWebCrypto } from "@lib/mods.ts";
import { computeKeyedId } from "@lib/common/idDerivation.ts";

const generateSettings = (hashAlg: HashAlgorithm, passphrase?: string) =>
    ({
        ...DEFAULT_SETTINGS,
        hashAlg,
        encrypt: passphrase !== undefined,
        passphrase,
    }) as RemoteDBSettings;

const CompatibilityPlain = {
    [HashAlgorithms.XXHASH64]: "37me21jj44pcc",
    [HashAlgorithms.XXHASH32]: "1n069eb",
    [HashAlgorithms.MIXED_PUREJS]: "1b68nom123qfyd",
    [HashAlgorithms.SHA1]: "2pGPxorWFQvCZq2k1uh76tH9ABc=",
    [HashAlgorithms.LEGACY]: "-vyucau",
} as const;

const CompatibilityEncrypted = {
    [HashAlgorithms.XXHASH64]: "+1ztcqdkimja8x",
    [HashAlgorithms.XXHASH32]: "+jsnawm",
    [HashAlgorithms.MIXED_PUREJS]: "+jtawwv4wlm1n",
    [HashAlgorithms.SHA1]: "+GU01wMj2+f/NPVC5z+Rz2gjLIlM=",
    [HashAlgorithms.LEGACY]: "+-gslt6r",
} as const;

function createMockSettingService(settings: RemoteDBSettings) {
    return {
        currentSettings: () => settings,
    } as SettingService;
}
const generateHashManager = (settings: RemoteDBSettings) => {
    if (!HashManager.isAvailableFor(settings.hashAlg)) {
        throw new Error(`HashManager for ${settings.hashAlg} is not available`);
    }
    return new HashManager({ settingService: createMockSettingService(settings) });
};

describe("HashManager", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps encrypted Chunk IDs stable when only the E2EE passphrase changes", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "first E2EE passphrase",
            idDerivationVersion: 1 as const,
            idDerivationKey: "f3205cc41d24116d8c2484993c9d9a2e667373af338ba02f2ee71199adb82f2e",
        };
        const manager = generateHashManager(settings);
        await manager.initialise();
        const first = await manager.computeHash("sample chunk");
        expect(first).toBe("+5868bc5fff9c1537ad5e6dfdf016b46daad9cf3827cb607150aa9e3feaaf36ce");
        settings.passphrase = "second E2EE passphrase";
        expect(await manager.computeHash("sample chunk")).toBe(first);
    });

    describe("independent Chunk key reuse", () => {
        const key = "f3205cc41d24116d8c2484993c9d9a2e667373af338ba02f2ee71199adb82f2e";
        const createSettings = () => ({
            ...DEFAULT_SETTINGS,
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: true,
            passphrase: "test",
            idDerivationVersion: 1 as 0 | 1,
            idDerivationKey: key,
        });

        it("shares key preparation between concurrent calls and sends only short digests to HMAC", async () => {
            const settings = createSettings();
            const manager = generateHashManager(settings);
            await manager.initialise();
            const crypto = await getWebCrypto();
            const imports = vi.spyOn(crypto.subtle, "importKey");
            const signs = vi.spyOn(crypto.subtle, "sign");
            const inputs = Array.from({ length: 8 }, (_, i) => "r".repeat(32 * 1024) + i);
            const ids = await Promise.all(inputs.map((input) => manager.computeHash(input)));

            expect(new Set(ids).size).toBe(inputs.length);
            expect(imports).toHaveBeenCalledTimes(2);
            expect(signs).toHaveBeenCalledTimes(inputs.length + 1);
            expect(signs.mock.calls.every((call) => call[2].byteLength < 128)).toBe(true);
            expect(imports.mock.calls.every((call) => call[3] === false && call[4].join() === "sign")).toBe(true);
            expect(await manager.computeHash(inputs[0])).toBe(ids[0]);
            settings.passphrase = "replacement E2EE passphrase";
            expect(await manager.computeHashWithEncryption(inputs[0])).toBe(ids[0].slice(1));
            expect(imports).toHaveBeenCalledTimes(2);
        });

        it("replaces the current key and isolates separate manager instances", async () => {
            const settings = createSettings();
            const first = generateHashManager(settings);
            const second = generateHashManager(createSettings());
            await Promise.all([first.initialise(), second.initialise()]);
            const crypto = await getWebCrypto();
            const imports = vi.spyOn(crypto.subtle, "importKey");
            const original = await first.computeHash("sample chunk");
            expect(await second.computeHash("sample chunk")).toBe(original);
            expect(imports).toHaveBeenCalledTimes(4);

            settings.idDerivationKey = "ab".repeat(32);
            const replacement = await first.computeHash("sample chunk");
            expect(replacement).not.toBe(original);
            expect(await second.computeHash("sample chunk")).toBe(original);
            expect(imports).toHaveBeenCalledTimes(6);
            settings.idDerivationKey = key;
            expect(await first.computeHash("sample chunk")).toBe(original);
            expect(imports).toHaveBeenCalledTimes(8);
        });

        it("suspends key use and releases cached preparation when E2EE is off or legacy mode is selected", async () => {
            const settings = createSettings();
            const manager = generateHashManager(settings);
            await manager.initialise();
            const crypto = await getWebCrypto();
            const imports = vi.spyOn(crypto.subtle, "importKey");
            const original = await manager.computeHash("helloWorld");
            settings.encrypt = false;
            expect(manager.usesIndependentIdKey()).toBe(false);
            expect(await manager.computeHash("helloWorld")).toBe(CompatibilityPlain.xxhash64);
            expect(settings.idDerivationKey).toBe(key);
            expect(imports).toHaveBeenCalledTimes(2);

            settings.encrypt = true;
            expect(await manager.computeHash("helloWorld")).toBe(original);
            expect(imports).toHaveBeenCalledTimes(4);
            settings.idDerivationVersion = 0;
            settings.idDerivationKey = "";
            expect(await manager.computeHash("helloWorld")).toBe(CompatibilityEncrypted.xxhash64);
            settings.idDerivationVersion = 1;
            settings.idDerivationKey = key;
            expect(await manager.computeHash("helloWorld")).toBe(original);
            expect(imports).toHaveBeenCalledTimes(6);
            settings.idDerivationKey = "invalid";
            await expect(manager.computeHash("helloWorld")).rejects.toThrow("invalid");
            expect(imports).toHaveBeenCalledTimes(6);
        });

        it("does not let a failed old preparation evict a newer key and permits retry", async () => {
            const settings = createSettings();
            const manager = generateHashManager(settings);
            await manager.initialise();
            const crypto = await getWebCrypto();
            let rejectOld!: (error: Error) => void;
            const pending = new Promise<CryptoKey>((_, reject) => {
                rejectOld = reject;
            });
            const imports = vi.spyOn(crypto.subtle, "importKey").mockImplementationOnce(() => pending);
            const oldResult = expect(manager.computeHash("sample chunk")).rejects.toThrow("Import failed");
            await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1));

            settings.idDerivationKey = "ab".repeat(32);
            const current = await manager.computeHash("sample chunk");
            rejectOld(new Error("Import failed"));
            await oldResult;
            expect(await manager.computeHash("sample chunk")).toBe(current);
            expect(imports).toHaveBeenCalledTimes(3);

            settings.idDerivationKey = key;
            expect(await manager.computeHash("sample chunk")).toBe(
                "+5868bc5fff9c1537ad5e6dfdf016b46daad9cf3827cb607150aa9e3feaaf36ce"
            );
            expect(imports).toHaveBeenCalledTimes(5);
        });

        it("retries failed preparation for the same key and releases it when caches are cleared", async () => {
            const manager = generateHashManager(createSettings());
            await manager.initialise();
            const crypto = await getWebCrypto();
            const imports = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("Import failed"));
            await expect(manager.computeHash("sample chunk")).rejects.toThrow("Import failed");
            const first = await manager.computeHash("sample chunk");
            expect(imports).toHaveBeenCalledTimes(3);
            manager.clearCaches();
            expect(await manager.computeHash("sample chunk")).toBe(first);
            expect(imports).toHaveBeenCalledTimes(5);
        });

        it("uses the independent algorithm regardless of the legacy hash selection", async () => {
            for (const hashAlg of Object.values(HashAlgorithms)) {
                const settings = { ...createSettings(), hashAlg };
                const manager = generateHashManager(settings);
                await manager.initialise();
                expect(await manager.computeHash("sample chunk")).toBe(
                    "+5868bc5fff9c1537ad5e6dfdf016b46daad9cf3827cb607150aa9e3feaaf36ce"
                );
            }
            expect(await computeKeyedId(key, "document", "sample chunk")).toBe(
                "a2a525f9d994e83f29588ad43513be468e137135a88689cd0790e48834d9d3f3"
            );
        });
    });

    describe.each(Object.values(HashAlgorithms))("HashManager for %s", (hashAlg) => {
        let manager: HashManager;
        let managerWithEncryption: HashManager;

        beforeEach(async () => {
            manager = generateHashManager(generateSettings(hashAlg));
            await manager.initialise();
            managerWithEncryption = generateHashManager(generateSettings(hashAlg, "test"));
            await managerWithEncryption.initialise();
        });

        it("should be available", () => {
            expect(manager.manager).toBeDefined();
        });

        it("should compute hash without encryption", async () => {
            const piece = "test";
            const hash = await manager.computeHash(piece);
            expect(typeof hash).toBe("string");

            const piece2 = "test2";
            const hash2 = await manager.computeHash(piece2);
            expect(hash).not.toBe(hash2);

            const hash3 = await manager.computeHash(piece);
            expect(hash).toBe(hash3);
        });

        it("should compute hash with encryption", async () => {
            const piece = "test";
            const hash = await managerWithEncryption.computeHash(piece);
            expect(typeof hash).toBe("string");

            const hash1Encrypted = HashEncryptedPrefix + (await managerWithEncryption.computeHashWithEncryption(piece));
            expect(hash).toBe(hash1Encrypted);

            const hash1Plain = await managerWithEncryption.computeHashWithoutEncryption(piece);
            expect(hash1Plain).not.toBe(hash);

            const hash1PlainWithUnEncryptedManager = await manager.computeHash(piece);
            expect(hash1PlainWithUnEncryptedManager).toBe(hash1Plain);

            const piece2 = "test2";
            const hash2 = await managerWithEncryption.computeHash(piece2);
            expect(hash).not.toBe(hash2);

            const hash3 = await managerWithEncryption.computeHash(piece);
            expect(hash).toBe(hash3);
        });

        it("should compute correct hashes", async () => {
            const piece = "helloWorld";
            const hash = await manager.computeHash(piece);
            expect(hash).toBe(CompatibilityPlain[hashAlg]);

            const hashWithEncryption = await managerWithEncryption.computeHash(piece);
            expect(hashWithEncryption).toBe(CompatibilityEncrypted[hashAlg]);
        });

        it("should initialise without throwing on double-call", async () => {
            await expect(manager.initialise()).resolves.toBeTruthy();
            expect(manager.manager).toBeDefined();
        });

        it("should produce consistent plain hashes", async () => {
            const inputs = ["test", "helloWorld", "foo", "bar123"];
            const hashes = new Map<string, string>();

            for (const input of inputs) {
                const hash = await manager.computeHash(input);
                hashes.set(input, hash);
            }

            for (const [input, originalHash] of hashes.entries()) {
                const newHash = await manager.computeHash(input);
                expect(newHash).toBe(originalHash);
            }
        });

        it("should produce different hashes for different inputs with encryption", async () => {
            const inputs = ["test1", "test2", "test3"];
            const hashes = new Set<string>();

            for (const input of inputs) {
                const hash = await managerWithEncryption.computeHash(input);
                hashes.add(hash);
            }

            expect(hashes.size).toBe(inputs.length);
        });

        it("encrypted hash should always start with prefix", async () => {
            const inputs = ["test", "helloWorld", "foo"];

            for (const input of inputs) {
                const hash = await managerWithEncryption.computeHash(input);
                expect(hash.startsWith(HashEncryptedPrefix)).toBe(true);
            }
        });

        it("plain hash without encryption should not start with prefix", async () => {
            const inputs = ["test", "helloWorld", "foo"];

            for (const input of inputs) {
                const hash = await manager.computeHash(input);
                expect(hash.startsWith(HashEncryptedPrefix)).toBe(false);
            }
        });
    });

    describe("HashManager availability", () => {
        it("all hash algorithms should be available", () => {
            for (const hashAlg of Object.values(HashAlgorithms)) {
                expect(HashManager.isAvailableFor(hashAlg)).toBe(true);
            }
        });

        it("should generate valid hash manager for all algorithms", async () => {
            for (const hashAlg of Object.values(HashAlgorithms)) {
                const manager = generateHashManager(generateSettings(hashAlg));
                await expect(manager.initialise()).resolves.toBeTruthy();
                expect(manager.manager).toBeDefined();
            }
        });
    });
});
