import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
export declare const PACKAGE_VERSION: string;
export declare const MANIFEST_VERSION: string;

export class BrowserAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
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
        return "browser-app";
    }
    getAppVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    getPluginVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    override getPlatform(): string {
        return "browser";
    }
    override getCrypto(): Crypto {
        return globalThis.crypto;
    }
}
