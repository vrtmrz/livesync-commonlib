import { RemoteService } from "@lib/services/base/RemoteService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";

export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    // connect = handlers<IRemoteService>().binder("connect");
}
