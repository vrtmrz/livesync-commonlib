import { LOG_LEVEL_DEBUG, LOG_LEVEL_VERBOSE, type UXFileInfoStub } from "@lib/common/types";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";
import { isAcceptedAll } from "@lib/string_and_binary/path";
import { Computed } from "octagonal-wheels/dataobject/Computed";

import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { promiseWithResolvers } from "octagonal-wheels/promises";

/**
 * This is a simple handler that accepts all files.
 */
export function isAcceptedAlwaysFactory(host: NecessaryServices<any, any>, log: LogFunction) {
    return (file: string | UXFileInfoStub) => {
        log("File is target finally: " + getStoragePathFromUXFileInfo(file), LOG_LEVEL_DEBUG);
        return Promise.resolve(true);
    };
}

/**
 * Check if a file is accepted based on filename duplication in the vault.
 */
export function isAcceptedInFilenameDuplicationFactory(
    host: NecessaryServices<"vault" | "fileProcessing", "storageAccess">,
    log: LogFunction
) {
    const fileCountMapComputed = new Computed({
        evaluation: (fileEventCount: number) => {
            const vaultFiles = host.serviceModules.storageAccess.getFileNames().sort();
            const fileCountMap: Record<string, number> = {};
            for (const file of vaultFiles) {
                const lc = file.toLowerCase();
                if (!fileCountMap[lc]) {
                    fileCountMap[lc] = 1;
                } else {
                    fileCountMap[lc]++;
                }
            }
            return fileCountMap;
        },
        requiresUpdate: (args, previousArgs, previousResult) => {
            if (!previousResult) return true;
            if (previousResult instanceof Error) return true;
            if (!previousArgs) return true;
            if (args[0] === previousArgs[0]) {
                return false;
            }
            return true;
        },
    });

    return async function isAcceptedInFilenameDuplication(file: string | UXFileInfoStub): Promise<boolean> {
        const fileCountMap = (
            await fileCountMapComputed.update(host.services.fileProcessing.totalStorageFileEventCount)
        ).value;

        const filepath = getStoragePathFromUXFileInfo(file);
        const lc = filepath.toLowerCase();

        if (host.services.vault.shouldCheckCaseInsensitively()) {
            if (lc in fileCountMap && fileCountMap[lc] > 1) {
                log("File is duplicated (case-insensitive): " + filepath);
                return false;
            }
        }
        log("File is not duplicated: " + filepath, LOG_LEVEL_DEBUG);
        return true;
    };
}
/**
 * Check if a file is accepted by the local database (e.g., not rejected by the local DB's target file check).
 * Local database responsible for non-internal files, syncOnlyRegEx, syncIgnoreRegEx
 * This possibly should be separated.
 */
export function isAcceptedByLocalDBFactory(
    host: NecessaryServices<"database" | "databaseEvents", any>,
    log: LogFunction
) {
    const database = host.services.database;
    const databaseEvents = host.services.databaseEvents;

    let isReady = promiseWithResolvers();
    databaseEvents.onDatabaseHasReady.addHandler(() => {
        isReady.resolve();
        return Promise.resolve(true);
    });
    databaseEvents.onUnloadDatabase.addHandler(() => {
        isReady = promiseWithResolvers();
        return Promise.resolve(true);
    });
    return async (file: string | UXFileInfoStub): Promise<boolean> => {
        // If DB is not ready, we might consider it not accepted or handle gracefully.
        await isReady.promise;
        const filepath = getStoragePathFromUXFileInfo(file);
        // Assuming DB exists for this check based on original logic.
        if (!(await Promise.resolve(database.localDatabase.isTargetFile(filepath)))) {
            log("File is not target by local DB: " + filepath);
            return false;
        }
        log("File is target by local DB: " + filepath, LOG_LEVEL_DEBUG);
        return true;
    };
}

/**
 * Factory function to create the isAcceptedByIgnoreFiles handler.
 * This handler checks if a file is ignored based on the ignore files specified in the settings.
 * It also caches the ignore file contents for performance and listens to settings changes to invalidate the cache.
 */
export function isAcceptedByIgnoreFilesFactory(
    host: NecessaryServices<"setting" | "appLifecycle", "storageAccess">,
    log: LogFunction
) {
    let ignoreFiles: string[] = [];
    const ignoreFileCacheMap = new Map<string, string[] | undefined | false>();
    const refreshSettings = () => {
        const settings = host.services.setting.currentSettings();
        ignoreFiles = settings?.ignoreFiles.split(",").map((e) => e.trim()) || [];
        return Promise.resolve(true);
    };
    const invalidateIgnoreFileCache = (path: string) => {
        const key = path.toLowerCase();
        ignoreFileCacheMap.delete(key);
    };
    const getIgnoreFile = async (path: string): Promise<string[] | false> => {
        const key = path.toLowerCase();
        const cached = ignoreFileCacheMap.get(key);
        if (cached !== undefined) {
            return cached;
        }
        try {
            if (!(await host.serviceModules.storageAccess.isExistsIncludeHidden(path))) {
                log(`[ignore] Ignore file does not exist: ${path}`, LOG_LEVEL_DEBUG);
                ignoreFileCacheMap.set(key, false);
                return false;
            }
            const file = await host.serviceModules.storageAccess.readHiddenFileText(path);
            const gitignore = file
                .split(/\r?\n/g)
                .map((e) => e.replace(/\r$/, ""))
                .map((e) => e.trim());
            ignoreFileCacheMap.set(key, gitignore);
            log(`[ignore] Ignore file loaded: ${path}`, LOG_LEVEL_VERBOSE);
            return gitignore;
        } catch (ex) {
            log(`[ignore] Failed to read ignore file ${path}`);
            log(ex, LOG_LEVEL_VERBOSE);
            ignoreFileCacheMap.set(key, undefined);
            return false;
        }
    };
    host.services.setting.onSettingRealised.addHandler(refreshSettings);
    host.services.appLifecycle.onLoaded.addHandler(refreshSettings);
    void refreshSettings();
    return async function isAcceptedByIgnoreFiles(file: string | UXFileInfoStub): Promise<boolean> {
        const settings = host.services.setting.currentSettings();
        if (!settings.useIgnoreFiles) {
            return true;
        }
        const filepath = getStoragePathFromUXFileInfo(file);
        // Accessing file invalidate cache,
        // This is a simple way to ensure the cache is updated when the ignore file is changed,
        // that because all file changes should trigger this check even if not rejected by other checks.
        // Hence, this check should be in early stage in the handler list.
        invalidateIgnoreFileCache(filepath);
        log("Checking ignore files for: " + filepath, LOG_LEVEL_DEBUG);
        if (!(await isAcceptedAll(filepath, ignoreFiles, (filename) => getIgnoreFile(filename)))) {
            log("File is ignored by ignore files: " + filepath);
            return false;
        }
        log("File is not ignored by ignore files: " + filepath, LOG_LEVEL_DEBUG);
        return true;
    };
}

export function useTargetFilters(
    host: NecessaryServices<
        "API" | "vault" | "fileProcessing" | "setting" | "appLifecycle" | "database" | "databaseEvents",
        "storageAccess"
    >
) {
    const logger = createInstanceLogFunction("SFTargetFilter", host.services.API);
    const services = host.services;
    const serviceModules = host.serviceModules;
    // Bind Middleware Functions
    // 1. Duplication Check
    const _isAcceptedFilenameDuplication = isAcceptedInFilenameDuplicationFactory(
        {
            services: { vault: services.vault, fileProcessing: services.fileProcessing },
            serviceModules: { storageAccess: serviceModules.storageAccess },
        },
        logger
    );

    // 2. Ignore File Check
    const _isAcceptedByIgnoreFiles = isAcceptedByIgnoreFilesFactory(
        {
            services: { setting: services.setting, appLifecycle: services.appLifecycle },
            serviceModules: { storageAccess: serviceModules.storageAccess },
        },
        logger
    );

    // 3. Local DB Check
    const _isAcceptedByLocalDB = isAcceptedByLocalDBFactory(
        {
            services: { database: services.database, databaseEvents: services.databaseEvents },
            serviceModules: {},
        },
        logger
    );

    // 4. Final Check
    const _isAcceptedAlways = isAcceptedAlwaysFactory(
        {
            services: {},
            serviceModules: {},
        },
        logger
    );

    // Register Handlers
    services.vault.isTargetFile.addHandler(_isAcceptedFilenameDuplication, 10);
    services.vault.isTargetFile.addHandler(_isAcceptedByIgnoreFiles, 20);
    services.vault.isTargetFile.addHandler(_isAcceptedByLocalDB, 30);
    // Meaningless. but just to be testing.
    services.vault.isTargetFile.addHandler(_isAcceptedAlways, 100);

    const isTargetIgnored = async (file: string | UXFileInfoStub) => {
        const result = await _isAcceptedByIgnoreFiles(file);
        return !result;
    };

    services.vault.isIgnoredByIgnoreFile.addHandler(isTargetIgnored);
}
