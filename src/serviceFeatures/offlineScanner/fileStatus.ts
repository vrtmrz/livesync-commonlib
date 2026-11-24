import { withLock } from "octagonal-wheels/concurrency/lock.scoped";
import type { FilePathWithPrefix } from "@lib/common/types";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { convertCase } from "./paths";

// In-memory map to track file modification times for offline scanning.
type FileStatusState = {
    map: Map<string, number>;
    timeout: number | ReturnType<typeof setTimeout> | null;
    loaded: boolean;
    scanLock: symbol;
};
const fileStatuses = new WeakMap<object, FileStatusState>();
const FILE_STATUS_MAP_KEY = "fileStatusMap";
const FILE_STATUS_MAP_LOCK = "offlineScanner-fileStatusMap";

/** Replace the in-memory last-seen map from a persisted snapshot and mark it loaded. */
function replaceLoadedFileStatus(state: FileStatusState, items: Record<string, number> | undefined): void {
    state.map = new Map(Object.entries(items ?? {}));
    state.loaded = true;
}

/**
 * Borrow the in-memory observations and scan lock for one backing store.
 * @param host - Owner of the active key-value database.
 * @returns Shared process-local state; no database operation is performed.
 */
export function fileStatus(host: NecessaryServices<"keyValueDB", never>): FileStatusState {
    // Wrappers sharing the same backing store must share observations and the scan lock.
    const owner = host.services.keyValueDB.kvDB ?? host.services.keyValueDB;
    let state = fileStatuses.get(owner);
    if (!state) {
        state = { map: new Map(), timeout: null, loaded: false, scanLock: Symbol("offlineScanner-scan") };
        fileStatuses.set(owner, state);
    }
    return state;
}

/**
 * Drain an earlier scheduled write before reloading durable observations.
 * @param host - Owner of the active key-value database.
 * @param isStopping - Optional stop predicate checked before and after reading durable state.
 * @returns After the map has been loaded under the persistence lock.
 * @throws If a required backing-store read or preceding write fails.
 */
export async function loadFileStatus(
    host: NecessaryServices<"keyValueDB", never>,
    isStopping?: () => boolean
) {
    // A preceding explicit scan may have returned with a scheduled write. Drain
    // that observation before replacing the map from durable state.
    if (fileStatus(host).timeout !== null) await flushFileStatus(host, isStopping);
    await withLock(FILE_STATUS_MAP_LOCK, async () => {
        if (isStopping?.()) return;
        const state = fileStatus(host);
        const kvDB = host.services.keyValueDB.kvDB;
        const items = kvDB?.get ? await kvDB.get<Record<string, number>>(FILE_STATUS_MAP_KEY) : undefined;
        if (isStopping?.()) return;
        replaceLoadedFileStatus(state, items);
    });
}

async function _saveFileStatus(host: NecessaryServices<"keyValueDB", never>, isStopping?: () => boolean) {
    await withLock(FILE_STATUS_MAP_LOCK, async () => {
        if (isStopping?.()) return;
        const kvDB = host.services.keyValueDB.kvDB;
        if (kvDB?.set) await kvDB.set(FILE_STATUS_MAP_KEY, Object.fromEntries(fileStatus(host).map));
    });
}

/**
 * Cancel the scheduled callback and await an ordered last-seen write.
 * @param host - Owner of the map and backing store.
 * @param isStopping - Optional stop predicate checked before persisting.
 * @returns After the store write settles successfully.
 * @throws If persistence fails; physical file effects are not rolled back.
 */
export async function flushFileStatus(
    host: NecessaryServices<"keyValueDB", never>,
    isStopping?: () => boolean
) {
    cancelFileStatusSave(host);
    await _saveFileStatus(host, isStopping);
}

/** Cancel any pending deferred `fileStatusMap` write without clearing in-memory observations. */
export function cancelFileStatusSave(host: NecessaryServices<"keyValueDB", never>): void {
    const state = fileStatus(host);
    const handle = state.timeout;
    state.timeout = null;
    if (handle !== null) compatGlobal.clearTimeout(handle);
}

/**
 * Remove a stale presence record before Metadata identity repair publishes its target.
 * @param host - Borrowed settings and key-value storage capabilities.
 * @param path - Logical path whose comparison key must be forgotten.
 * @returns After loading any missing map state and persisting the removal.
 */
export async function clearOfflineScannerLastSeen(
    host: NecessaryServices<"setting" | "keyValueDB", never>,
    path: FilePathWithPrefix
): Promise<void> {
    const key = convertCase(host.services.setting.currentSettings(), path);
    const state = fileStatus(host);
    cancelFileStatusSave(host);
    await withLock(FILE_STATUS_MAP_LOCK, async () => {
        const kvDB = host.services.keyValueDB.kvDB;
        if (!state.loaded) {
            const persisted = kvDB?.get ? await kvDB.get<Record<string, number>>(FILE_STATUS_MAP_KEY) : undefined;
            replaceLoadedFileStatus(state, persisted);
        }
        state.map.delete(key);
        if (kvDB?.set) await kvDB.set(FILE_STATUS_MAP_KEY, Object.fromEntries(state.map));
    });
}

/**
 * Schedule one coalesced map write without awaiting persistence.
 * @param host - Owner of the observations to save.
 * @param isStopping - Optional stop predicate checked before scheduling and when the timer fires.
 * @param immediate - Replace pending work with a zero-delay callback when true.
 */
export function saveFileStatus(
    host: NecessaryServices<"keyValueDB", never>,
    isStopping?: () => boolean,
    immediate = false
) {
    if (isStopping?.()) return;
    const state = fileStatus(host);
    if (immediate) cancelFileStatusSave(host);
    if (state.timeout === null) {
        state.timeout = compatGlobal.setTimeout(() => {
            state.timeout = null;
            if (!isStopping?.()) {
                // Deferred saves are best-effort; absorb teardown or I/O rejections so they do not go unhandled.
                void _saveFileStatus(host, isStopping).catch(() => {});
            }
        }, immediate ? 0 : 1000);
    }
}

/**
 * Remember a raw observed mtime and request a coalesced save.
 * @param host - Owner of the last-seen state.
 * @param key - Already-normalised comparison key.
 * @param mtime - Observed storage timestamp, which does not prove unchanged bytes.
 * @param isStopping - Optional stop predicate checked before mutating observations or scheduling persistence.
 */
export function updateFileMTimeInMap(
    host: NecessaryServices<"keyValueDB", never>,
    key: string,
    mtime: number,
    isStopping?: () => boolean
) {
    if (isStopping?.()) return;
    fileStatus(host).map.set(key, mtime);
    saveFileStatus(host, isStopping);
}

/**
 * Read the current in-memory last-seen observation without storage access.
 * @param host - Owner of the loaded map.
 * @param key - Already-normalised comparison key.
 * @returns The remembered timestamp, or undefined when no observation exists.
 */
export function getFileMTimeFromMap(host: NecessaryServices<"keyValueDB", never>, key: string): number | undefined {
    return fileStatus(host).map.get(key);
}
