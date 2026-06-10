import type { ITestService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { TestService } from "@lib/services/base/TestService";
import { handlers } from "@lib/services/lib/HandlerUtils";

export class InjectableTestService<T extends ServiceContext> extends TestService<T> {
    addTestResult = handlers<ITestService>().binder("addTestResult");
}
