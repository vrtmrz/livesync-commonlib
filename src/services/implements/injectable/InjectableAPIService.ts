import { APIService } from "../../base/APIService";
import type { IAPIService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableAPIService<T extends ServiceContext> extends APIService<T> {
    addLog = handlers<IAPIService>().binder("addLog");
    getCustomFetchHandler = handlers<IAPIService>().binder("getCustomFetchHandler");
    isMobile = handlers<IAPIService>().binder("isMobile");
    showWindow = handlers<IAPIService>().binder("showWindow");
    getAppID = handlers<IAPIService>().binder("getAppID");
    getAppVersion = handlers<IAPIService>().binder("getAppVersion");
    getPluginVersion = handlers<IAPIService>().binder("getPluginVersion");
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
