import type { ITweakValueService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { TweakValueService } from "../../base/TweakValueService";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableTweakValueService<T extends ServiceContext> extends TweakValueService<T> {
    fetchRemotePreferred = handlers<ITweakValueService>().binder("fetchRemotePreferred");
    checkAndAskResolvingMismatched = handlers<ITweakValueService>().binder("checkAndAskResolvingMismatched");

    askResolvingMismatched = handlers<ITweakValueService>().binder("askResolvingMismatched");
    checkAndAskUseRemoteConfiguration = handlers<ITweakValueService>().binder("checkAndAskUseRemoteConfiguration");
    askUseRemoteConfiguration = handlers<ITweakValueService>().binder("askUseRemoteConfiguration");
}
