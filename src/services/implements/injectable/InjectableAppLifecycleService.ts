import { AppLifecycleService } from "../../base/AppLifecycleService";
import type { IAppLifecycleService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export abstract class AppLifecycleServiceBase<T extends ServiceContext> extends AppLifecycleService<T> {
    askRestart = handlers<IAppLifecycleService>().binder("askRestart");
    scheduleRestart = handlers<IAppLifecycleService>().binder("scheduleRestart");
    isSuspended = handlers<IAppLifecycleService>().binder("isSuspended");
    setSuspended = handlers<IAppLifecycleService>().binder("setSuspended");
    isReady = handlers<IAppLifecycleService>().binder("isReady");
    markIsReady = handlers<IAppLifecycleService>().binder("markIsReady");
    resetIsReady = handlers<IAppLifecycleService>().binder("resetIsReady");
    hasUnloaded = handlers<IAppLifecycleService>().binder("hasUnloaded");
    isReloadingScheduled = handlers<IAppLifecycleService>().binder("isReloadingScheduled");
}

export abstract class InjectableAppLifecycleService<T extends ServiceContext = ServiceContext>
    extends AppLifecycleServiceBase<T>
    implements IAppLifecycleService
{
    performRestart = handlers<IAppLifecycleService>().binder("performRestart");
}
