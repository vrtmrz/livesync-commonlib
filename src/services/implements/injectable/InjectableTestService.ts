import type { ITestService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { TestService } from "../../base/TestService";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableTestService<T extends ServiceContext> extends TestService<T> {
    addTestResult = handlers<ITestService>().binder("addTestResult");
}
