// Sync Parameters management functions
// This file is responsible for managing synchronisation parameters, including fetching, creating, and updating them.
//
// The Security Seed (represented as PBKDF2 Salt in logs) derives the encryption key for replication, so it should be stored on the server prior to synchronisation.
import { createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import type { SyncParameters } from "@lib/common/types.ts";
import { arrayBufferToBase64Single, base64ToArrayBufferInternalBrowser } from "@lib/string_and_binary/convert.ts";
import { LiveSyncError } from "@lib/common/LSError.ts";

/**
 * Creates a SyncParamsHandler for managing synchronisation parameters.
 */
type putFunc = (params: SyncParameters) => Promise<boolean>;
/**
 * Fetches synchronisation parameters from the server.
 */
type getFunc = () => Promise<SyncParameters>;
/**
 * The function to create new synchronisation parameters.
 * Note that this function should not return `pbkdf2salt` in the result; it should be generated and stored in the handler.
 */
type createFunc = () => Promise<SyncParameters>;

type CreateSyncParamsHanderOptions = {
    put: putFunc;
    get: getFunc;
    create: createFunc;
};

export type SyncParamsHandler = {
    fetch: (refresh?: boolean) => Promise<SyncParameters | false>;
    getPBKDF2Salt: (refresh?: boolean) => Promise<Uint8Array<ArrayBuffer>>;
};
const _handlers = new Map<string, SyncParamsHandler>();

export function createSyncParamsHanderForServer(
    key: string,
    options: CreateSyncParamsHanderOptions
): SyncParamsHandler {
    if (_handlers.has(key)) {
        return _handlers.get(key)!;
    }
    const handler = createSyncParamsHandler(options);
    _handlers.set(key, handler);
    return handler;
}
export function clearHandlers() {
    _handlers.clear();
}
export class SyncParamsHandlerError extends LiveSyncError {}
export class SyncParamsFetchError extends SyncParamsHandlerError {}
export class SyncParamsNotFoundError extends SyncParamsHandlerError {}
export class SyncParamsUpdateError extends SyncParamsHandlerError {}

export function isSyncParamsError(
    error: unknown
): error is SyncParamsFetchError | SyncParamsNotFoundError | SyncParamsUpdateError {
    return (
        error instanceof SyncParamsFetchError ||
        error instanceof SyncParamsNotFoundError ||
        error instanceof SyncParamsUpdateError
    );
}

/**
 * SyncParameters with decoded PBKDF2 salt (as Uint8Array).
 * This is for performance reasons, to avoid decoding it every time.
 */
type SyncParametersWithDecoded = SyncParameters & {
    pbkdf2saltDecoded: Uint8Array<ArrayBuffer>;
};

type SyncParamsFetchResult =
    | { readonly status: "success"; readonly parameters: SyncParametersWithDecoded }
    | { readonly status: "failure"; readonly cause: unknown };

/** Create a handler owned by one operation rather than the process-wide server cache. */
export function createSyncParamsHandler({ put, get, create }: CreateSyncParamsHanderOptions): SyncParamsHandler {
    // Share the current fetch result; an explicit refresh starts a new operation.
    let taskFetchParameters: Promise<SyncParamsFetchResult> | undefined;

    // This function fetches synchronisation parameters from the server, ensuring that they have PBKDF2 salt.
    const readSyncParameters = async (): Promise<SyncParamsFetchResult> => {
        let syncParams: SyncParameters | undefined;
        try {
            let shouldRetry = false;
            do {
                shouldRetry = false;
                // 1. Try to fetch the synchronisation parameters from the server.
                try {
                    syncParams = await get();
                    Logger(`Fetched synchronisation parameters`, LOG_LEVEL_INFO);
                } catch (ex) {
                    if (LiveSyncError.isCausedBy(ex, SyncParamsNotFoundError)) {
                        // Expected error; we will create new synchronisation parameters.
                        Logger(`Synchronisation parameters not found, creating new ones`, LOG_LEVEL_INFO);
                        const newSyncParams = await create();
                        // If we have created new synchronisation parameters, immediately store them to the server, without salt.
                        // If a race condition occurs, it will cause a 409 (conflict) error. This should be detected and handled as an error; purging the cache and retrying.
                        const putResult = await put(newSyncParams);
                        if (!putResult) {
                            Logger(`Failed to store initial synchronisation parameters`, LOG_LEVEL_INFO);
                            throw new SyncParamsUpdateError(`Failed to store initial synchronisation parameters`);
                        }
                        Logger(
                            `Initial synchronisation parameters stored successfully, retrying fetch`,
                            LOG_LEVEL_INFO
                        );
                        shouldRetry = true;
                    } else {
                        // Unexpected error; rethrow it, as we cannot proceed without synchronisation parameters.
                        throw ex;
                    }
                }
            } while (shouldRetry);

            // 2. If the synchronisation parameters are fetched, ensure that they have PBKDF2 salt.
            // 2.1. If something went wrong, we cannot proceed without synchronisation parameters.
            if (!syncParams) {
                throw new SyncParamsFetchError(`Unexpected empty synchronisation parameters`);
            }
            // 2.2. If the synchronisation parameters do not have PBKDF2 salt, create a new one.
            if (!syncParams.pbkdf2salt) {
                Logger(`Synchronisation parameters do not have PBKDF2 salt, generating a new salt`, LOG_LEVEL_INFO);
                const salt = await arrayBufferToBase64Single(createPBKDF2Salt());
                if (!salt) {
                    Logger(`Failed to generate PBKDF2 salt`, LOG_LEVEL_INFO);
                    throw new SyncParamsFetchError(`Failed to generate PBKDF2 salt`);
                }
                syncParams.pbkdf2salt = salt;
                // We need to store the synchronisation parameters with the new salt immediately. If this fails, we cannot proceed (this means synchronisation parameters are created with another device).
                const putResult = await put(syncParams);
                if (!putResult) {
                    Logger(`Failed to store synchronisation parameters with new PBKDF2 salt`, LOG_LEVEL_INFO);
                    throw new SyncParamsUpdateError(`Failed to store synchronisation parameters with new PBKDF2 salt`);
                }
                syncParams = await get();
            }

            if (!syncParams) {
                // Again, something went wrong; we cannot proceed without synchronisation parameters. Indeed, this should not happen.
                throw new Error(`Failed to prepare synchronisation key in synchronisation parameters`);
            }

            Logger(`Synchronisation parameters fetched successfully`, LOG_LEVEL_INFO);
            const parameters = {
                ...syncParams,
                pbkdf2saltDecoded: new Uint8Array(base64ToArrayBufferInternalBrowser(syncParams.pbkdf2salt)),
            };
            return { status: "success", parameters };
        } catch (cause) {
            Logger(`Failed to fetch synchronisation parameters`, LOG_LEVEL_INFO);
            Logger(cause, LOG_LEVEL_VERBOSE);
            return { status: "failure", cause };
        }
    };
    const fetchSyncParameters = (refresh = false): Promise<SyncParamsFetchResult> => {
        if (taskFetchParameters && !refresh) return taskFetchParameters;
        const task = readSyncParameters();
        taskFetchParameters = task;
        void task.then((result) => {
            // An older refresh may settle after a newer cache entry has been installed.
            if (result.status === "failure" && taskFetchParameters === task) taskFetchParameters = undefined;
        });
        return task;
    };

    return {
        fetch: async (refresh) => {
            const result = await fetchSyncParameters(refresh);
            return result.status === "success" ? result.parameters : false;
        },
        getPBKDF2Salt: async (refresh: boolean = false) => {
            const result = await fetchSyncParameters(refresh);
            if (result.status === "failure") {
                Logger(`Failed to fetch synchronisation parameters`, LOG_LEVEL_INFO);
                throw new SyncParamsFetchError(`Failed to fetch synchronisation parameters`, { cause: result.cause });
            }
            return result.parameters.pbkdf2saltDecoded;
        },
    };
}
