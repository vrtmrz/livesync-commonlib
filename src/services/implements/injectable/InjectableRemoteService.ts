import type { IRemoteService } from "../../base/IService";
import { RemoteService } from "../../base/RemoteService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    connect = handlers<IRemoteService>().binder("connect");
}
