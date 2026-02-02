import { APIService } from "../../base/APIService";
import type { IAPIService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export abstract class InjectableAPIService<T extends ServiceContext> extends APIService<T> {
    addLog = handlers<IAPIService>().binder("addLog");
    isLastPostFailedDueToPayloadSize = handlers<IAPIService>().binder("isLastPostFailedDueToPayloadSize");

    override getPlatform(): string {
        return "unknown";
    }
    override getCrypto(): Crypto {
        if (typeof crypto !== "undefined") {
            return crypto;
        }
        throw new Error("Crypto API is not available in this environment.");
    }
}
