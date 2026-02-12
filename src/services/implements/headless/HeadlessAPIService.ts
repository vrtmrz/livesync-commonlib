import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ICommandCompat } from "../../base/IService";
const module = await import("node:crypto");
declare const MANIFEST_VERSION: string | undefined;
// declare const PACKAGE_VERSION: string | undefined;
export class HeadlessAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
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
}
