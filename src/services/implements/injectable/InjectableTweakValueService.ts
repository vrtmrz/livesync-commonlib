import type { ITweakValueService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { TweakValueService } from "@lib/services/base/TweakValueService";
import { handlers } from "@lib/services/lib/HandlerUtils";

export class InjectableTweakValueService<T extends ServiceContext> extends TweakValueService<T> {
    fetchRemotePreferred = handlers<ITweakValueService>().binder("fetchRemotePreferred");
    checkAndAskResolvingMismatched = handlers<ITweakValueService>().binder("checkAndAskResolvingMismatched");

    askResolvingMismatched = handlers<ITweakValueService>().binder("askResolvingMismatched");
    checkAndAskUseRemoteConfiguration = handlers<ITweakValueService>().binder("checkAndAskUseRemoteConfiguration");
    askUseRemoteConfiguration = handlers<ITweakValueService>().binder("askUseRemoteConfiguration");
}
