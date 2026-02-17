import type { IRemoteService } from "../../base/IService";
import { RemoteService } from "../../base/RemoteService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    replicateAllToRemote = handlers<IRemoteService>().binder("replicateAllToRemote");
    replicateAllFromRemote = handlers<IRemoteService>().binder("replicateAllFromRemote");
    markLocked = handlers<IRemoteService>().binder("markLocked");
    markUnlocked = handlers<IRemoteService>().binder("markUnlocked");
    markResolved = handlers<IRemoteService>().binder("markResolved");
    connect = handlers<IRemoteService>().binder("connect");
}
