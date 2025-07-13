import { createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE, Logger } from "../common/logger";
import type { SyncParameters } from "../common/types";
import { arrayBufferToBase64Single, base64ToArrayBuffer } from "../string_and_binary/convert";
import { shareRunningResult } from "../concurrency/lock";
type putFunc = (params: SyncParameters) => Promise<boolean>;
type getFunc = () => Promise<SyncParameters>;
type createFunc = () => Promise<SyncParameters>;

type CreateSyncParamsHanderOptions = {
    put: putFunc;
    get: getFunc;
    create: createFunc;
};
export type SyncParamsHandler = {
    fetch: (refresh?: boolean) => Promise<SyncParameters>;
    update: (params: Partial<SyncParameters>) => Promise<boolean>;
    getPBKDF2Salt: (refresh?: boolean) => Promise<Uint8Array>;
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

function createSyncParamsHandler({ put, get, create }: CreateSyncParamsHanderOptions): SyncParamsHandler {
    let buffer: SyncParameters | undefined;
    let saltBuffer: Uint8Array | undefined;

    const updateSyncParameters = async (params: Partial<SyncParameters>): Promise<boolean> => {
        // if (!buffer) {
        return await shareRunningResult(`sync-params-update`, async () => {
            let buffer: SyncParameters = {} as SyncParameters;
            try {
                buffer = await fetchSyncParameters();
                delete params._id;
            } catch (ex) {
                Logger(`Failed to fetch previous sync parameters`, LOG_LEVEL_INFO);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
            delete params._rev; // we don't want to change ID or revision
            const allKeys = [
                ...new Set([...Object.keys(params), ...Object.keys(buffer)]),
            ] as const as (keyof SyncParameters)[];
            let someChanged = false;
            for (const key of allKeys) {
                if (key.startsWith("_")) continue; // skip internal keys
                if (params?.[key] !== buffer?.[key]) {
                    someChanged = true;
                    break;
                }
            }
            if (someChanged) {
                Logger(`Updating synchronisation parameters`, LOG_LEVEL_INFO);
                Logger(params, LOG_LEVEL_VERBOSE);
            } else {
                Logger(`No changes in synchronisation parameters`, LOG_LEVEL_VERBOSE);
                return false;
            }

            // Put the updated parameters to the database
            const updatedParams = { ...buffer, ...params };
            Logger(`Updated synchronisation parameters`, LOG_LEVEL_VERBOSE);
            Logger(updatedParams, LOG_LEVEL_VERBOSE);
            const result = await put(updatedParams);
            if (result) {
                Logger(`Synchronisation parameters updated successfully`, LOG_LEVEL_VERBOSE);
            } else {
                Logger(`Failed to update synchronisation parameters`, LOG_LEVEL_INFO);
            }
            return result;
        });
    };
    const fetchSyncParameters = async (refresh: boolean = false): Promise<SyncParameters> => {
        return await shareRunningResult(`sync-params-fetch`, async () => {
            if (buffer && !refresh) {
                return buffer;
            }
            let syncParams: SyncParameters;
            let isModified = false;
            try {
                syncParams = await get();
                Logger(`Fetched synchronisation parameters`, LOG_LEVEL_INFO);
            } catch (ex: any) {
                Logger(`Failed to fetch sync parameters`, LOG_LEVEL_INFO);
                Logger(ex, LOG_LEVEL_VERBOSE);
                // If the document does not exist, create it.
                syncParams = await create();
                isModified = true;
                Logger(`Created new synchronisation parameters`, LOG_LEVEL_INFO);
                Logger(syncParams, LOG_LEVEL_VERBOSE);
            }
            if (!syncParams.pbkdf2salt) {
                // If the salt is not set, generate a new one.
                syncParams.pbkdf2salt = await arrayBufferToBase64Single(createPBKDF2Salt());
                Logger(`Generated new PBKDF2 salt: ${syncParams.pbkdf2salt}`, LOG_LEVEL_INFO);
                isModified = true;
            }
            if (isModified && (await put(syncParams))) {
                Logger(`Synchronisation parameters fetched and updated successfully`, LOG_LEVEL_INFO);
                Logger(syncParams, LOG_LEVEL_VERBOSE);
            } else {
                Logger(`No changes in synchronisation parameters after fetch`, LOG_LEVEL_VERBOSE);
            }
            buffer = syncParams;
            // Store the salt in a buffer for quick access
            return syncParams;
        });
    };
    return {
        fetch: fetchSyncParameters,
        update: updateSyncParameters,
        getPBKDF2Salt: async (refresh: boolean = false) => {
            if (saltBuffer && !refresh) {
                return saltBuffer;
            }
            const syncParams = await fetchSyncParameters(refresh);
            saltBuffer = new Uint8Array(base64ToArrayBuffer(syncParams.pbkdf2salt));
            return saltBuffer;
        },
    };
}
export function createSyncPBKDF2SaltFetcher(
    fetchSyncParameters: () => Promise<SyncParameters>
): () => Promise<Uint8Array> {
    let salt: Uint8Array | undefined;
    return async () => {
        if (salt) {
            return salt;
        }
        const syncParams = await fetchSyncParameters();
        salt = new Uint8Array(base64ToArrayBuffer(syncParams.pbkdf2salt));
        return salt;
    };
}
