import { RemoteService } from "../../base/RemoteService";
import type { ServiceContext } from "../../base/ServiceBase";

export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    // connect = handlers<IRemoteService>().binder("connect");
}
