import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
export declare const PACKAGE_VERSION: string;
export declare const MANIFEST_VERSION: string;

export class BrowserAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
    override getPlatform(): string {
        return "browser";
    }
    override getCrypto(): Crypto {
        return globalThis.crypto;
    }
}
