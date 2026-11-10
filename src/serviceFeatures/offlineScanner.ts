import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/types";
import { isRemediationModeActive } from "@lib/common/utils";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import type { VaultScanOptions, VaultScanResult } from "@lib/services/base/VaultScanResult";
import { collectDeletedFiles } from "./offlineScanner/metadata";
import { synchroniseAllFilesBetweenDBandStorage } from "./offlineScanner/scan";
import { FullScanModes, type FullScanOptions } from "./offlineScanner/types";

export { VaultScanResults } from "@lib/services/base/VaultScanResult";
export type { VaultScanResult } from "@lib/services/base/VaultScanResult";
export {
    FilePairProcessResults,
    MetadataDocumentNamespaces,
    MetadataDocumentIdentityStatuses,
    OfflineScanUnresolvedReasons,
    MetadataDocumentRepairResults,
    FullScanModes,
    ExtraOnRemote,
    ExtraOnLocal,
} from "./offlineScanner/types";
export type {
    FilePairProcessResult,
    MetadataDocumentNamespace,
    OfflineScanUnresolvedDiagnostic,
    MetadataDocumentIdentityInspection,
    MetadataDocumentIdentityIssue,
    MetadataDocumentRepairRequest,
    MetadataDocumentRepairResult,
    FullScanOptions,
    FullScanMode,
} from "./offlineScanner/types";
export {
    getMetadataDocumentNamespace,
    inspectMetadataDocumentIdentity,
    inspectMetadataDocumentIdentities,
    repairMetadataDocumentIdentity,
    collectDeletedFiles,
} from "./offlineScanner/metadata";
export { getPathFromEntry, convertCase } from "./offlineScanner/paths";
export { clearOfflineScannerLastSeen } from "./offlineScanner/fileStatus";
export {
    syncFileBetweenDBandStorage,
    collectFilesOnStorage,
    collectDatabaseFiles,
    updateToDatabase,
    updateToStorage,
    syncStorageAndDatabase,
} from "./offlineScanner/files";
export { getFilePairState, resolveFilePairAction, synchroniseAllFilesBetweenDBandStorage } from "./offlineScanner/scan";

/**
 * Check configuration, suspension, and remediation policy before a full scan.
 * @param host - Borrowed settings and store capabilities.
 * @param errorManager - Owner of the existing scan notices.
 * @param log - Logger retained by the scan call contract.
 * @param showingNotice - Whether blocked-policy notices should be visible.
 * @param ignoreSuspending - Allow an explicitly requested scan while watching is suspended.
 * @returns Whether the current policy permits scanning; no file work is started.
 */
export function canProceedScan(
    host: NecessaryServices<"keyValueDB" | "setting", never>,
    errorManager: UnresolvedErrorManager,
    log: LogFunction,
    showingNotice: boolean = false,
    ignoreSuspending: boolean = false
): boolean {
    // const isInitialized = (await host.services.keyValueDB.kvDB.get("initialized")) || false;

    const settings = host.services.setting.currentSettings();

    // Check if LiveSync is configured
    const ERR_NOT_CONFIGURED =
        "LiveSync is not configured yet. Synchronising between the storage and the local database is now prevented.";
    if (!settings.isConfigured) {
        errorManager.showError(ERR_NOT_CONFIGURED, showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
        return false;
    }
    errorManager.clearError(ERR_NOT_CONFIGURED);

    // Check if file watching is suspended
    const ERR_SUSPENDING =
        "Now suspending file watching. Synchronising between the storage and the local database is now prevented.";
    if (!ignoreSuspending && settings.suspendFileWatching) {
        errorManager.showError(ERR_SUSPENDING, showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
        return false;
    }
    errorManager.clearError(ERR_SUSPENDING);

    // Check if in remediation mode
    const MSG_IN_REMEDIATION = `Started in remediation Mode! (Max mtime for reflect events is set). Synchronising between the storage and the local database is now prevented.`;
    if (isRemediationModeActive(settings)) {
        errorManager.showError(MSG_IN_REMEDIATION, LOG_LEVEL_NOTICE);
        return false;
    }
    errorManager.clearError(MSG_IN_REMEDIATION);
    return true;
}

/**
 * Convert legacy notice flags or an options object into the shared scan contract.
 * @param showingNoticeOrOptions - Current options or the legacy notice flag.
 * @param ignoreSuspending - Legacy suspension override.
 * @returns Options with the ordinary newer-wins mode supplied as the default.
 */
export function normaliseFullScanOptions(
    showingNoticeOrOptions: Partial<FullScanOptions> | boolean | undefined,
    ignoreSuspending: boolean = false
): FullScanOptions {
    if (typeof showingNoticeOrOptions === "object") {
        return {
            mode: FullScanModes.NEWER_WINS,
            ...showingNoticeOrOptions,
        };
    }
    return {
        mode: FullScanModes.NEWER_WINS,
        showingNotice: showingNoticeOrOptions ?? false,
        ignoreSuspending,
    };
}

/**
 * Perform a full scan and synchronisation between database and storage.
 * @param host Services container
 * @param log Logging function
 * @param errorManager Error manager
 * @param showingNoticeOrOptions Full-scan options, or the legacy notice flag
 * @param ignoreSuspending Legacy suspension flag used with the notice flag
 * @returns The scan outcome, including accepted individual file failures
 */
export async function performFullScan(
    host: NecessaryServices<"setting" | "vault" | "path" | "database" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    options?: Partial<FullScanOptions>
): Promise<VaultScanResult>;
export async function performFullScan(
    host: NecessaryServices<"setting" | "vault" | "path" | "database" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNotice?: boolean,
    ignoreSuspending?: boolean
): Promise<VaultScanResult>;
export async function performFullScan(
    host: NecessaryServices<"setting" | "vault" | "path" | "database" | "keyValueDB", "storageAccess" | "fileHandler">,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNoticeOrOptions: Partial<FullScanOptions> | boolean = false,
    ignoreSuspending: boolean = false
): Promise<VaultScanResult> {
    const options = normaliseFullScanOptions(showingNoticeOrOptions, ignoreSuspending);
    const showingNotice = options.showingNotice ?? false;
    const shouldIgnoreSuspending = options.ignoreSuspending ?? false;

    if (!canProceedScan(host, errorManager, log, showingNotice, shouldIgnoreSuspending)) {
        return false;
    }
    log("Opening the key-value database", LOG_LEVEL_VERBOSE);
    const isInitialized = (await host.services.keyValueDB.kvDB.get("initialized")) || false;

    if (showingNotice) {
        log("Initializing", LOG_LEVEL_NOTICE, "syncAll");
    }
    if (isInitialized) {
        log("Restoring storage state", LOG_LEVEL_VERBOSE);
        await host.serviceModules.storageAccess.restoreState();
    }

    log("Initialize and checking database files");
    log("Checking deleted files");
    await collectDeletedFiles(host, log);
    const scanResult = await synchroniseAllFilesBetweenDBandStorage(host, log, errorManager, options);

    log("Initialized, NOW TRACKING!");
    if (!isInitialized) {
        await host.services.keyValueDB.kvDB.set("initialized", true);
    }
    if (showingNotice) {
        log("Initialize done!", LOG_LEVEL_NOTICE, "syncAll");
    }
    return scanResult;
}

/**
 * Associate the initialiser file feature with the app lifecycle events.
 * This function binds initialisation handlers to the appropriate lifecycle events.
 * @param host Services container with required dependencies
 */
export function useOfflineScanner(
    host: NecessaryServices<
        "API" | "appLifecycle" | "setting" | "vault" | "path" | "database" | "keyValueDB",
        "storageAccess" | "fileHandler"
    >
) {
    const log = createInstanceLogFunction("SF:OfflineScanner", host.services.API);
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle, host.services.context.events);

    // Handler for vault scanning
    const handleScanVault = async (
        showingNotice?: boolean,
        ignoreSuspending: boolean = false,
        continueOnFileFailure: boolean = false,
        scanOptions?: VaultScanOptions
    ): Promise<VaultScanResult> => {
        return await performFullScan(host, log, errorManager, {
            showingNotice,
            ignoreSuspending,
            continueOnFileFailure,
            strictContentCheck: scanOptions?.strictContentCheck,
        });
    };
    // Bind handlers to lifecycle events
    host.services.vault.scanVault.addHandler(handleScanVault);
}
