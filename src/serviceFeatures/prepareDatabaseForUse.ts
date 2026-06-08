import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import type { NecessaryServices } from "../interfaces/ServiceModule";
import { UnresolvedErrorManager } from "../services/base/UnresolvedErrorManager";
import { createInstanceLogFunction, type LogFunction } from "../services/lib/logUtils";

/**
 * Initialise the database and trigger a full vault scan.
 * @param host Services container
 * @param log Logging function
 * @param errorManager Error manager
 * @param showingNotice Whether to show notices during initialisation
 * @param reopenDatabase Whether to reopen the database connection
 * @param ignoreSuspending Whether to ignore suspension settings
 * @returns True if initialisation succeeded
 */

export async function prepareDatabaseForUse(
    host: NecessaryServices<
        "appLifecycle" | "setting" | "vault" | "path" | "database" | "databaseEvents" | "fileProcessing" | "replicator",
        never
    >,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNotice: boolean = false,
    reopenDatabase: boolean = true,
    ignoreSuspending: boolean = false
): Promise<boolean> {
    const appLifecycle = host.services.appLifecycle;
    appLifecycle.resetIsReady();

    if (
        !reopenDatabase ||
        (await host.services.database.openDatabase({
            databaseEvents: host.services.databaseEvents,
            replicator: host.services.replicator,
        }))
    ) {
        if (host.services.database.localDatabase.isReady) {
            await host.services.vault.scanVault(showingNotice, ignoreSuspending);
        }
        const ERR_INITIALISATION_FAILED = `Initializing database has been failed on some module!`;
        if (!(await host.services.databaseEvents.onDatabaseInitialised(showingNotice))) {
            errorManager.showError(ERR_INITIALISATION_FAILED, LOG_LEVEL_NOTICE);
            return false;
        }
        errorManager.clearError(ERR_INITIALISATION_FAILED);
        appLifecycle.markIsReady();
        // Run queued event once.
        await host.services.fileProcessing.commitPendingFileEvents();
        return true;
    } else {
        appLifecycle.resetIsReady();
        return false;
    }
}

/**
 * Associate the initialiser file feature with the app lifecycle events.
 * This function binds initialization handlers to the appropriate lifecycle events.
 * @param host Services container with required dependencies
 */
export function usePrepareDatabaseForUse(
    host: NecessaryServices<
        | "API"
        | "appLifecycle"
        | "setting"
        | "vault"
        | "path"
        | "database"
        | "databaseEvents"
        | "fileProcessing"
        | "replicator",
        never
    >
) {
    const log = createInstanceLogFunction("SF:prepareDatabaseForUse", host.services.API);
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle);

    // Handler for database initialisation
    const initialiseDatabaseHandler = async (
        showingNotice: boolean = false,
        reopenDatabase: boolean = true,
        ignoreSuspending: boolean = false
    ): Promise<boolean> => {
        return await prepareDatabaseForUse(host, log, errorManager, showingNotice, reopenDatabase, ignoreSuspending);
    };

    // Bind handlers to lifecycle events
    host.services.databaseEvents.initialiseDatabase.addHandler(initialiseDatabaseHandler);
}
