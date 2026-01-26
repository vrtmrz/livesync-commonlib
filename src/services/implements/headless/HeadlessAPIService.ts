import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
const module = await import("node:crypto");

export class HeadlessAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
    override getPlatform(): string {
        return "server";
    }
    override getCrypto(): Crypto {
        const webcrypto = module.webcrypto as Crypto;
        return webcrypto;
    }
}
