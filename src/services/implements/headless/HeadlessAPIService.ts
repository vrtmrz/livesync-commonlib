import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { IAPIService, ICommandCompat } from "../../base/IService";
import { handlers } from "../../lib/HandlerUtils";
import type { Confirm } from "@lib/interfaces/Confirm";
// const module = await import("node:crypto");
import module from "node:crypto";
declare const MANIFEST_VERSION: string | undefined;
// declare const PACKAGE_VERSION: string | undefined;
export class HeadlessConfirm implements Confirm {
    askYesNo(message: string): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false> {
        throw new Error("Method not implemented.");
    }
    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askSelectString(message: string, items: string[]): Promise<string> {
        throw new Error("Method not implemented.");
    }
    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false> {
        throw new Error("Method not implemented.");
    }
    askInPopup(key: string, dialogText: string, anchorCallback: (anchor: HTMLAnchorElement) => void): void {
        throw new Error("Method not implemented.");
    }
    confirmWithMessage(
        title: string,
        contentMd: string,
        buttons: string[],
        defaultAction: (typeof buttons)[number],
        timeout?: number
    ): Promise<(typeof buttons)[number] | false> {
        throw new Error("Method not implemented.");
    }
}
export class HeadlessAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
    private _confirmInstance: Confirm;
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
    getSystemVaultName = handlers<IAPIService>().binder("getSystemVaultName");
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
}
