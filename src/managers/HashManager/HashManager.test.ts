import { HashManager } from "./HashManager.ts";
import { DEFAULT_SETTINGS, HashAlgorithms, type HashAlgorithm, type RemoteDBSettings } from "../../common/types.ts";
import { HashEncryptedPrefix } from "./HashManagerCore.ts";
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

export const generateHashManager = (settings: RemoteDBSettings) => {
    if (!HashManager.isAvailableFor(settings.hashAlg)) {
        // Always available by fallback managers
        throw new Error(`HashManager for ${settings.hashAlg} is not available`);
    }
    return new HashManager({ settings });
};

for (const hashAlg of Object.values(HashAlgorithms)) {
    const manager = generateHashManager(generateSettings(hashAlg));
    await manager.initialise();
    const managerWithEncryption = generateHashManager(generateSettings(hashAlg, "test"));
    await managerWithEncryption.initialise();
    Deno.test({
        name: `HashManager for ${hashAlg} should be available`,
        fn: () => {
            if (!manager.manager) {
                throw new Error(`HashManager for ${hashAlg} is not initialized`);
            }
        },
    });
    Deno.test({
        name: `HashManager for ${hashAlg} should compute hash without encryption`,
        fn: async () => {
            const piece = "test";
            const hash = await manager.computeHash(piece);
            if (typeof hash !== "string") {
                throw new Error(`HashManager for ${hashAlg} did not return a string hash`);
            }
            const piece2 = "test2";
            const hash2 = await manager.computeHash(piece2);
            if (hash === hash2) {
                throw new Error(`HashManager for ${hashAlg} returned the same hash for different inputs`);
            }
            const hash3 = await manager.computeHash(piece);
            if (hash !== hash3) {
                throw new Error(`HashManager for ${hashAlg} returned different hashes for the same input`);
            }
        },
    });
    Deno.test({
        name: `HashManager for ${hashAlg} should compute hash with encryption`,
        fn: async () => {
            const piece = "test";
            const hash = await managerWithEncryption.computeHash(piece);
            if (typeof hash !== "string") {
                throw new Error(`HashManager for ${hashAlg} did not return a string hash`);
            }
            const hash1Encrypted = HashEncryptedPrefix + (await managerWithEncryption.computeHashWithEncryption(piece));
            if (hash !== hash1Encrypted) {
                console.log(`Hash1Encrypted: ${hash1Encrypted}`);
                console.log(`Hash: ${hash}`);
                throw new Error(
                    `HashManager for ${hashAlg} returned different hashes for the same input with encryption by explicit encryption method`
                );
            }
            const hash1Plain = await managerWithEncryption.computeHashWithoutEncryption(piece);
            if (hash1Plain === hash) {
                throw new Error(
                    `HashManager for ${hashAlg} returned the same hash for encrypted and unencrypted input`
                );
            }

            const hash1PlainWithUnEncryptedManager = await manager.computeHash(piece);
            if (hash1PlainWithUnEncryptedManager !== hash1Plain) {
                throw new Error(
                    `HashManager for ${hashAlg} returned different hashes for encrypted and unencrypted using different managers`
                );
            }
            const piece2 = "test2";
            const hash2 = await managerWithEncryption.computeHash(piece2);
            if (hash === hash2) {
                throw new Error(`HashManager for ${hashAlg} returned the same hash for different inputs`);
            }
            const hash3 = await managerWithEncryption.computeHash(piece);
            if (hash !== hash3) {
                throw new Error(`HashManager for ${hashAlg} returned different hashes for the same input`);
            }
        },
    });
    Deno.test({
        name: `HashManager for ${hashAlg} should compute correct hashes`,
        fn: async () => {
            const piece = "helloWorld";
            const hash = await manager.computeHash(piece);
            console.log(`Hash for ${hashAlg} without encryption: ${hash}`);
            console.log(`Expected: ${CompatibilityPlain[hashAlg]}`);

            if (hash !== CompatibilityPlain[hashAlg]) {
                throw new Error(`HashManager for ${hashAlg} returned incorrect hash for plain input: ${hash}`);
            }

            const hashWithEncryption = await managerWithEncryption.computeHash(piece);
            console.log(`Hash for ${hashAlg} with encryption: ${hashWithEncryption}`);
            console.log(`Expected: ${CompatibilityEncrypted[hashAlg]}`);
            if (hashWithEncryption !== CompatibilityEncrypted[hashAlg]) {
                throw new Error(
                    `HashManager for ${hashAlg} returned incorrect hash for encrypted input: ${hashWithEncryption}`
                );
            }
        },
    });
}
Deno.test({
    name: `Manager initialise double-calling should not throw`,
    fn: async () => {
        for (const hashAlg of Object.values(HashAlgorithms)) {
            const manager = generateHashManager(generateSettings(hashAlg));
            await manager.initialise();
            if (!manager.manager) {
                throw new Error(`No manager initialized`);
            }
            await manager.initialise(); // Should not throw
        }
    },
});
