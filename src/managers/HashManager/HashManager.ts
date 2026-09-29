import type { HashAlgorithm } from "@lib/common/models/setting.type.ts";
import { FallbackWasmHashManager, XXHash32RawHashManager, XXHash64HashManager } from "./XXHashHashManager.ts";
import { FallbackPureJSHashManager, PureJSHashManager, SHA1HashManager } from "./PureJSHashManager.ts";
import { HashEncryptedPrefix, HashManagerCore, type HashManagerCoreOptions } from "./HashManagerCore.ts";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { createChunkIdGenerator, configuredIdKey } from "@lib/common/idDerivation.ts";
/**
 * List of available hash managers.
 * For compatibility, please retain fallback managers.
 */
const HashManagers = [
    XXHash64HashManager,
    XXHash32RawHashManager,
    SHA1HashManager,
    PureJSHashManager,
    // Please retain these fallback managers, as they are essential for compatibility.
    FallbackWasmHashManager,
    FallbackPureJSHashManager,
];

/**
 * Class for managing hash managers and performing hash calculations.
 * Selects an appropriate manager according to the available hash algorithm.
 */
export class HashManager extends HashManagerCore {
    /**
     * Instance of the hash manager currently in use.
     */
    manager: HashManagerCore = undefined!;
    private chunkIdGenerator?: { key: string; task: ReturnType<typeof createChunkIdGenerator> };

    clearCaches(): void {
        this.chunkIdGenerator = undefined;
    }

    private async computeIndependentChunkId(key: string, piece: string): Promise<string> {
        let cached = this.chunkIdGenerator;
        if (cached?.key !== key) {
            const entry = { key, task: createChunkIdGenerator(key) };
            this.chunkIdGenerator = cached = entry;
            void entry.task.catch(() => {
                if (this.chunkIdGenerator === entry) this.clearCaches();
            });
        }
        const generate = await cached.task;
        return await generate(piece);
    }

    /**
     * Checks whether the specified hash algorithm is available.
     *
     * @param hashAlg The hash algorithm to check
     * @returns True if available
     */
    static override isAvailableFor(hashAlg: HashAlgorithm): boolean {
        return HashManagers.some((manager) => manager.isAvailableFor(hashAlg));
    }

    /**
     * Selects and initialises an available hash manager.
     *
     * @returns True if initialisation is successful
     * @throws Throws an error if no available manager exists
     */
    async setManager(): Promise<boolean> {
        const settings = this.options.settingService.currentSettings();
        for (const Manager of HashManagers) {
            if (Manager.isAvailableFor(settings.hashAlg)) {
                this.manager = new Manager(this.options);
                return await this.manager.initialise();
            }
        }
        // deno-coverage-ignore Fallback managers are always present, so this should never be reached.
        throw new Error(`HashManager for ${settings.hashAlg} is not available`);
    }

    /**
     * Constructs a new HashManager.
     *
     * @param options Initialisation options
     */
    constructor(options: HashManagerCoreOptions) {
        super(options);
    }

    /**
     * Initialises the hash manager.
     *
     * @returns True if initialisation is successful
     * @throws Throws an error if initialisation fails
     */
    async processInitialise(): Promise<boolean> {
        const settings = this.options.settingService.currentSettings();
        if (await this.setManager()) {
            Logger(`HashManager for ${settings.hashAlg} has been initialised`, LOG_LEVEL_VERBOSE);
            return true;
        }
        // deno-coverage-ignore-start This branch should never be reached.
        Logger(`HashManager for ${settings.hashAlg} failed to initialise`);
        throw new Error(`HashManager for ${settings.hashAlg} failed to initialise`);
        // deno-coverage-ignore-stop
    }

    /**
     * Computes the hash value for the specified string.
     *
     * @param piece The string to be hashed
     * @returns The hash value (returned as a Promise)
     */
    override async computeHash(piece: string): Promise<string> {
        const settings = this.options.settingService.currentSettings();
        const key = configuredIdKey(settings);
        if (settings.encrypt && key) {
            return HashEncryptedPrefix + (await this.computeIndependentChunkId(key, piece));
        }
        this.clearCaches();
        return settings.encrypt
            ? HashEncryptedPrefix + (await this.manager.computeHashWithEncryption(piece))
            : await this.manager.computeHashWithoutEncryption(piece);
    }

    usesIndependentIdKey(): boolean {
        const settings = this.options.settingService.currentSettings();
        const active = settings.encrypt && configuredIdKey(settings) !== false;
        if (!active) this.clearCaches();
        return active;
    }

    /**
     * Computes the hash value without encryption.
     *
     * @param piece The string to be hashed
     * @returns The hash value (returned as a Promise)
     */
    computeHashWithoutEncryption(piece: string): Promise<string> {
        return this.manager.computeHashWithoutEncryption(piece);
    }

    /**
     * Computes the hash value with encryption.
     *
     * @param piece The string to be hashed
     * @returns The hash value (returned as a Promise)
     */
    computeHashWithEncryption(piece: string): Promise<string> {
        const key = configuredIdKey(this.options.settingService.currentSettings());
        if (key) return this.computeIndependentChunkId(key, piece);
        this.clearCaches();
        return this.manager.computeHashWithEncryption(piece);
    }
}
