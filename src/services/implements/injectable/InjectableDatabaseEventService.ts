import { DatabaseEventService } from "../../base/DatabaseEventService";
import type { IDatabaseEventService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableDatabaseEventService<T extends ServiceContext> extends DatabaseEventService<T> {
    initialiseDatabase = handlers<IDatabaseEventService>().binder("initialiseDatabase");
}
