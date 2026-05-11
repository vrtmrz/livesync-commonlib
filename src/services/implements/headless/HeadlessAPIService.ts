import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ICommandCompat } from "../../base/IService";
import type { Confirm } from "@lib/interfaces/Confirm";
// const module = await import("node:crypto");
import module from "node:crypto";
declare const MANIFEST_VERSION: string | undefined;
// declare const PACKAGE_VERSION: string | undefined;
/**
 * Headless implementation of Confirm that returns sensible defaults instead
 * of throwing. Dialogs are logged to stderr so the prompts are visible in
 * service logs, and the default/conservative action is taken automatically.
 */
export class HeadlessConfirm implements Confirm {
    askYesNo(message: string): Promise<"yes" | "no"> {
        console.error(`[Headless] ${message} → no`);
        return Promise.resolve("no");
    }
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false> {
        console.error(`[Headless] String input required: ${title} → declined`);
        return Promise.resolve(false);
    }
    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no"> {
        const result = opt.defaultOption === "Yes" ? "yes" as const : "no" as const;
        console.error(`[Headless] ${opt.title ?? "Confirm"}: ${message} → ${result}`);
        return Promise.resolve(result);
    }
    askSelectString(message: string, items: string[]): Promise<string> {
        console.error(`[Headless] ${message} → ${items[0]}`);
        return Promise.resolve(items[0]);
    }
    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false> {
        console.error(`[Headless] ${opt.title ?? "Confirm"}: ${message} → ${String(opt.defaultAction)}`);
        return Promise.resolve(opt.defaultAction);
    }
    askInPopup(key: string, dialogText: string, anchorCallback: (anchor: HTMLAnchorElement) => void): void {
        console.error(`[Headless] Popup (${key}): ${dialogText}`);
    }
    confirmWithMessage(
        title: string,
        contentMd: string,
        buttons: string[],
        defaultAction: (typeof buttons)[number],
        timeout?: number
    ): Promise<(typeof buttons)[number] | false> {
        console.error(`[Headless] ${title}: ${contentMd} → ${defaultAction}`);
        return Promise.resolve(defaultAction);
    }
}
export class HeadlessAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
    private _confirmInstance: Confirm;
    private _systemVaultName: string | undefined;
    constructor(context: T) {
        super(context);
        this._confirmInstance = new HeadlessConfirm();
    }
    get confirm(): Confirm {
        return this._confirmInstance;
    }
    showWindow(type: string): Promise<void> {
        // In a browser environment, showing a window might not be applicable.
        // TODO: Think implementation
        return Promise.resolve();
    }
    getCustomFetchHandler(): FetchHttpHandler {
        return undefined!;
    }
    isMobile(): boolean {
        return false;
    }
    getAppID(): string {
        return "headless-app";
    }
    getAppVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    getPluginVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    override getPlatform(): string {
        return "server";
    }

    override getCrypto(): Crypto {
        const webcrypto = module.webcrypto as Crypto;
        return webcrypto;
    }
    addCommand<TCommand extends ICommandCompat>(command: TCommand): TCommand {
        // In a browser environment, command registration might not be applicable.
        return command;
    }
    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
        return document?.createElement("div") || ({} as HTMLElement);
    }
    registerWindow(type: string, factory: (leaf: any) => any): void {
        // In a browser environment, window registration might not be applicable.
    }
    registerProtocolHandler(action: string, handler: (params: Record<string, string>) => any): void {
        // In a browser environment, protocol handler registration might not be applicable.
    }
    addStatusBarItem(): HTMLElement | undefined {
        // In a browser environment, status bar item might not be applicable.
        return undefined;
    }

    private toSafeKeyPart(value: string): string {
        const trimmed = value.trim();
        if (trimmed === "") {
            return "vault";
        }
        return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
    }

    private hash32(value: string): string {
        // Simple FNV-1a hash to create a short stable suffix for key separation.
        let hash = 0x811c9dc5;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    private deriveSystemVaultName(): string {
        const contextLike = this.context as ServiceContext & { vaultPath?: string; vaultName?: string };
        const explicitName = contextLike.vaultName;
        if (typeof explicitName === "string" && explicitName.trim() !== "") {
            return this.toSafeKeyPart(explicitName);
        }

        const vaultPath = contextLike.vaultPath;
        if (typeof vaultPath === "string" && vaultPath.trim() !== "") {
            const normalised = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
            const leaf =
                normalised
                    .split("/")
                    .filter((e) => e !== "")
                    .pop() ?? "vault";
            return `${this.toSafeKeyPart(leaf)}-${this.hash32(normalised)}`;
        }

        return "headless-vault";
    }

    getSystemVaultName(): string {
        if (!this._systemVaultName) {
            this._systemVaultName = this.deriveSystemVaultName();
        }
        return this._systemVaultName;
    }

    override get isOnline(): boolean {
        return true;
    }
    override nativeFetch(req: string | Request, opts?: RequestInit): Promise<Response> {
        return fetch(req, opts);
    }
}
