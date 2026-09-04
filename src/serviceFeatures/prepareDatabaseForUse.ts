import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import { VaultScanResults, type VaultScanResult } from "@lib/services/base/VaultScanResult.ts";

function reportPreparationFailure(log: LogFunction, message: string): false {
    log(message, LOG_LEVEL_VERBOSE);
    return false;
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
 * @returns The initialisation outcome, including accepted individual file failures
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
): Promise<VaultScanResult> {
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
                log,
                "Database preparation stopped because the local database could not be opened."
            );
        }
        if (!host.services.database.isDatabaseReady()) {
            return reportPreparationFailure(
                log,
                "Database preparation stopped because the local database is not ready."
            );
        }
        const scanResult = await host.services.vault.scanVault(showingNotice, ignoreSuspending, continueOnFileFailure);
        if (scanResult === VaultScanResults.FAILED) {
            return reportPreparationFailure(log, "Database preparation stopped because the Vault scan failed.");
        }
        if (scanResult === VaultScanResults.COMPLETED_WITH_FILE_FAILURES && continueOnFileFailure !== true) {
            return reportPreparationFailure(
                log,
                "Database preparation stopped because the Vault scan could not process every file."
            );
        }
        if (!(await host.services.databaseEvents.onDatabaseInitialised(showingNotice))) {
            return reportPreparationFailure(
                log,
                "Database preparation stopped because an initialisation handler failed."
            );
        }
        // Run queued event once.
        if (!(await host.services.fileProcessing.commitPendingFileEvents())) {
            return reportPreparationFailure(
                log,
                "Database preparation stopped because pending file events could not be committed."
            );
        }
        appLifecycle.markIsReady();
        return scanResult;
    } catch (error) {
        log(error, LOG_LEVEL_VERBOSE);
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
    ): Promise<VaultScanResult> => {
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
