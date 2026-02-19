import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { LOG_LEVEL } from "@lib/common/logger";
import type { IAPIService, ICommandCompat } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import type { Confirm } from "../../interfaces/Confirm";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

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
     * Returns the vaultName which system has identified, without any additional suffix.
     */
    abstract getSystemVaultName(): string;
    /**
     * Check if the last POST request failed due to payload size.
     */
    abstract isLastPostFailedDueToPayloadSize(): boolean;

    abstract getPlatform(): string;

    abstract getAppVersion(): string;

    abstract getPluginVersion(): string;

    abstract getCrypto(): Crypto;

    /**
     * Register a command to the runtime.
     * @param command
     */
    abstract addCommand<TCommand extends ICommandCompat>(command: TCommand): TCommand;

    /**
     * Register a window (or leaf) type to the runtime.
     * @param type
     * @param factory
     */
    abstract registerWindow(type: string, factory: (leaf: any) => any): void;

    /**
     * Add a ribbon icon to the UI.
     * @param icon
     * @param title
     * @param callback
     */
    abstract addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement;

    /**
     * Register a protocol handler.
     * @param action The action string for the protocol.
     * @param handler The handler function for the protocol.
     */
    abstract registerProtocolHandler(action: string, handler: (params: Record<string, string>) => any): void;

    /**
     * Get the basic UI component for showing a confirmation dialog to the user.
     */
    abstract get confirm(): Confirm;
    requestCount = reactiveSource(0);
    responseCount = reactiveSource(0);
}
