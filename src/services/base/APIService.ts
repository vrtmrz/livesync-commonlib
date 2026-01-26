import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { LOG_LEVEL } from "@lib/common/logger";
import type { IAPIService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The APIService provides methods for interacting with the plug-in's API,
 */
export abstract class APIService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IAPIService
{
    /**
     * Get a custom fetch handler for making HTTP requests (e.g., S3 without CORS issues).
     */
    abstract getCustomFetchHandler(): FetchHttpHandler;

    /**
     * Add a log entry to the log (Now not used).
     * @param message The log message.
     * @param level The log level.
     * @param key The log key.
     */
    abstract addLog(message: any, level: LOG_LEVEL, key: string): void;

    /**
     * Check if the app is running on a mobile device.
     * @returns true if running on mobile, false otherwise.
     */
    abstract isMobile(): boolean;

    /**
     * Show a window (or in Obsidian, a leaf).
     * @param type The type of window to show.
     */
    abstract showWindow(type: string): Promise<void>;

    /**
     * returns App ID. In Obsidian, it is vault ID.
     */
    abstract getAppID(): string;

    /**
     * Check if the last POST request failed due to payload size.
     */
    abstract isLastPostFailedDueToPayloadSize(): boolean;

    abstract getPlatform(): string;

    abstract getAppVersion(): string;

    abstract getPluginVersion(): string;

    abstract getCrypto(): Crypto;
}
