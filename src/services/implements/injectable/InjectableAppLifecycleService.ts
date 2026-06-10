import { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { IAppLifecycleService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { handlers } from "@lib/services/lib/HandlerUtils";

export abstract class AppLifecycleServiceBase<T extends ServiceContext> extends AppLifecycleService<T> {
    askRestart = handlers<IAppLifecycleService>().binder("askRestart");
    scheduleRestart = handlers<IAppLifecycleService>().binder("scheduleRestart");
    isReloadingScheduled = handlers<IAppLifecycleService>().binder("isReloadingScheduled");
}

export abstract class InjectableAppLifecycleService<T extends ServiceContext = ServiceContext>
    extends AppLifecycleServiceBase<T>
    implements IAppLifecycleService
{
    performRestart = handlers<IAppLifecycleService>().binder("performRestart");
}
