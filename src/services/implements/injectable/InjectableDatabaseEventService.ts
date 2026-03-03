import { DatabaseEventService } from "../../base/DatabaseEventService";
import type { ServiceContext } from "../../base/ServiceBase";

export class InjectableDatabaseEventService<T extends ServiceContext> extends DatabaseEventService<T> {
    // initialiseDatabase = handlers<IDatabaseEventService>().binder("initialiseDatabase");
}
