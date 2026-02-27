import { describe, it, expect, beforeEach } from "vitest";
import { HashManager } from "./HashManager.ts";
import { DEFAULT_SETTINGS, HashAlgorithms, type HashAlgorithm, type RemoteDBSettings } from "@lib/common/types.ts";
import { HashEncryptedPrefix } from "./HashManagerCore.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";

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
