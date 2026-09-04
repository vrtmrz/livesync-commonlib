import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";

const preparationFailureMessages = new WeakMap<UnresolvedErrorManager, string>();

function reportPreparationFailure(errorManager: UnresolvedErrorManager, message: string): false {
    const previousMessage = preparationFailureMessages.get(errorManager);
    if (previousMessage !== undefined && previousMessage !== message) {
        errorManager.clearError(previousMessage);
    }
    errorManager.showError(message, LOG_LEVEL_NOTICE);
    preparationFailureMessages.set(errorManager, message);
    return false;
}

function clearPreparationFailure(errorManager: UnresolvedErrorManager): void {
    const previousMessage = preparationFailureMessages.get(errorManager);
    if (previousMessage === undefined) return;
    errorManager.clearError(previousMessage);
    preparationFailureMessages.delete(errorManager);
}

/**
 * Initialise the database and trigger a full vault scan.
 * @param host Services container
 * @param log Logging function
 * @param errorManager Error manager
 * @param showingNotice Whether to show notices during initialisation
 * @param reopenDatabase Whether to reopen the database connection
 * @param ignoreSuspending Whether to ignore suspension settings
 * @param continueOnFileFailure Whether individual file failures may satisfy application readiness
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
    ignoreSuspending: boolean = false,
    continueOnFileFailure: boolean = false
): Promise<boolean> {
    const appLifecycle = host.services.appLifecycle;
    appLifecycle.resetIsReady();

    try {
        if (
            reopenDatabase &&
            !(await host.services.database.openDatabase({
                databaseEvents: host.services.databaseEvents,
                replicator: host.services.replicator,
            }))
        ) {
            return reportPreparationFailure(
                errorManager,
                host.services.context.translate("DatabasePreparation.Message.OpenFailed")
            );
        }
        if (!host.services.database.isDatabaseReady()) {
            return reportPreparationFailure(
                errorManager,
                host.services.context.translate("DatabasePreparation.Message.DatabaseNotReady")
            );
        }
        if (!(await host.services.vault.scanVault(showingNotice, ignoreSuspending, continueOnFileFailure))) {
            return reportPreparationFailure(
                errorManager,
                host.services.context.translate("DatabasePreparation.Message.ScanFailed")
            );
        }
        if (!(await host.services.databaseEvents.onDatabaseInitialised(showingNotice))) {
            return reportPreparationFailure(
                errorManager,
                host.services.context.translate("DatabasePreparation.Message.InitialisationStepFailed")
            );
        }
        // Run queued event once.
        if (!(await host.services.fileProcessing.commitPendingFileEvents())) {
            return reportPreparationFailure(
                errorManager,
                host.services.context.translate("DatabasePreparation.Message.PendingEventsFailed")
            );
        }
        clearPreparationFailure(errorManager);
        appLifecycle.markIsReady();
        return true;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reportPreparationFailure(
            errorManager,
            host.services.context.translate("DatabasePreparation.Message.UnexpectedFailure", { reason })
        );
        throw error;
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
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle, host.services.context.events);

    // Handler for database initialisation
    const initialiseDatabaseHandler = async (
        showingNotice: boolean = false,
        reopenDatabase: boolean = true,
        ignoreSuspending: boolean = false,
        continueOnFileFailure: boolean = false
    ): Promise<boolean> => {
        return await prepareDatabaseForUse(
            host,
            log,
            errorManager,
            showingNotice,
            reopenDatabase,
            ignoreSuspending,
            continueOnFileFailure
        );
    };

    // Bind handlers to lifecycle events
    host.services.databaseEvents.initialiseDatabase.addHandler(initialiseDatabaseHandler);
}
