import type { IRemoteService } from "../../base/IService";
import { RemoteService } from "../../base/RemoteService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    // _throughHole: ThroughHole;
    replicateAllToRemote = handlers<IRemoteService>().binder("replicateAllToRemote");
    replicateAllFromRemote = handlers<IRemoteService>().binder("replicateAllFromRemote");
    markLocked = handlers<IRemoteService>().binder("markLocked");
    markUnlocked = handlers<IRemoteService>().binder("markUnlocked");
    markResolved = handlers<IRemoteService>().binder("markResolved");
    tryResetDatabase = handlers<IRemoteService>().binder("tryResetDatabase");
    tryCreateDatabase = handlers<IRemoteService>().binder("tryCreateDatabase");
    connect = handlers<IRemoteService>().binder("connect");
}
