import { DatabaseEventService } from "@lib/services/base/DatabaseEventService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";

export class InjectableDatabaseEventService<T extends ServiceContext> extends DatabaseEventService<T> {
    // initialiseDatabase = handlers<IDatabaseEventService>().binder("initialiseDatabase");
}
