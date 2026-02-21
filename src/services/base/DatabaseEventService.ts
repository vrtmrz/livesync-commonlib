import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IDatabaseEventService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The DatabaseEventService provides methods for handling database lifecycle events.
 */
export abstract class DatabaseEventService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IDatabaseEventService
{
    /**
     * Event triggered when the database is about to be unloaded.
     */
    readonly onUnloadDatabase = handlers<IDatabaseEventService>().all("onUnloadDatabase");

    /**
     * Event triggered when the database is about to be closed.
     */
    readonly onCloseDatabase = handlers<IDatabaseEventService>().all("onCloseDatabase");

    /**
     * Event triggered when the database is being initialized.
     */
    readonly onDatabaseInitialisation = handlers<IDatabaseEventService>().bailFirstFailure("onDatabaseInitialisation");

    /**
     * Event triggered when the database has been initialized.
     */
    readonly onDatabaseInitialised = handlers<IDatabaseEventService>().bailFirstFailure("onDatabaseInitialised");

    /**
     * Event triggered when the database is being reset.
     */
    readonly onResetDatabase = handlers<IDatabaseEventService>().bailFirstFailure("onResetDatabase");

    /**
     * Event triggered when the database is ready for use.
     */
    readonly onDatabaseHasReady = handlers<IDatabaseEventService>().bailFirstFailure("onDatabaseHasReady");
    /**
     * Initialize the database.
     * @param showingNotice Whether to show a notice to the user.
     * @param reopenDatabase Whether to reopen the database if it is already open.
     * @param ignoreSuspending Whether to ignore any suspending state.
     */
    abstract initialiseDatabase(
        showingNotice?: boolean,
        reopenDatabase?: boolean,
        ignoreSuspending?: boolean
    ): Promise<boolean>;
}
