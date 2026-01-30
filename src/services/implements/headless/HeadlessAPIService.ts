import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
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
}
