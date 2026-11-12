import { promiseWithResolvers } from "octagonal-wheels/promises";
import { FilePathIndex, type FileNameLookup } from "@lib/platform/FilePathIndex.ts";
import type { FilePath, PathComparisonSettings } from "@lib/platform/pathTypes.ts";

/** The listing and invalidation inputs needed by a non-indexed storage host. */
export interface FileNameLookupDependencies {
    readonly getFileNames: () => Promise<FilePath[]>;
    readonly getStorageFileEventCount: () => number;
}

/** Values which make a retained name listing reusable for the active policy. */
export interface FileNameIndexSnapshot {
    readonly storageEventCount: number;
    readonly policy: PathComparisonSettings;
}

/** One shared pending or fulfilled listing; rejected requests are removed. */
export interface FileNameIndexRequest extends FileNameIndexSnapshot {
    readonly index: Promise<FilePathIndex>;
}

/** The factory owns one active request; operations receive that ownership explicitly. */
export interface FallbackFileNameLookupState {
    retained: FileNameIndexRequest | undefined;
}

/** Private fallback view used by the storage facade when its host has no index. */
export interface FallbackFileNameLookup extends Pick<FileNameLookup, "findPathIdentityCandidates"> {
    /** Retire the retained request before obtaining a fresh authoritative listing. */
    invalidate(): void;
}

/** Compare the host observation count and identity-policy values which permit request reuse. */
export function matchesSnapshot(request: FileNameIndexSnapshot, snapshot: FileNameIndexSnapshot): boolean {
    return (
        request.storageEventCount === snapshot.storageEventCount &&
        request.policy.pathNormalizationVersion === snapshot.policy.pathNormalizationVersion &&
        request.policy.handleFilenameCaseSensitive === snapshot.policy.handleFilenameCaseSensitive
    );
}

/** Build an index from the host listing without retaining or publishing it. */
export async function createFilePathIndex(
    dependencies: Pick<FileNameLookupDependencies, "getFileNames">
): Promise<FilePathIndex> {
    const paths = await dependencies.getFileNames();
    const index = new FilePathIndex();
    index.replaceAll(paths);
    return index;
}

/** Retire reuse immediately; existing callers can still finish their own request. */
export function invalidateFileNameLookup(state: FallbackFileNameLookupState): void {
    state.retained = undefined;
}

/** An older rejected request must not evict a newer active listing. */
export function discardRejectedRequest(state: FallbackFileNameLookupState, request: FileNameIndexRequest): void {
    if (state.retained === request) {
        invalidateFileNameLookup(state);
    }
}

/**
 * Reuse or start the request matching this snapshot, preserving its promise identity.
 *
 * Publish a pending request before starting host code: that code can invalidate
 * or re-enter this lookup synchronously. Completion belongs to the captured
 * request and cannot replace whichever request is active by then.
 */
export function getIndex(
    dependencies: Pick<FileNameLookupDependencies, "getFileNames">,
    state: FallbackFileNameLookupState,
    snapshot: FileNameIndexSnapshot
): Promise<FilePathIndex> {
    if (state.retained && matchesSnapshot(state.retained, snapshot)) {
        return state.retained.index;
    }

    const pending = promiseWithResolvers<FilePathIndex>();
    const request: FileNameIndexRequest = { ...snapshot, index: pending.promise };
    state.retained = request;
    void request.index.catch(() => discardRejectedRequest(state, request));
    void createFilePathIndex(dependencies).then(pending.resolve, pending.reject);
    return request.index;
}

/** Capture the host observation and policy before awaiting the matching original-name candidates. */
export async function findPathIdentityCandidates(
    dependencies: FileNameLookupDependencies,
    state: FallbackFileNameLookupState,
    path: FilePath,
    policy: PathComparisonSettings
): Promise<readonly FilePath[]> {
    const snapshot: FileNameIndexSnapshot = {
        storageEventCount: dependencies.getStorageFileEventCount(),
        policy: {
            pathNormalizationVersion: policy.pathNormalizationVersion,
            handleFilenameCaseSensitive: policy.handleFilenameCaseSensitive,
        },
    };
    const index = await getIndex(dependencies, state, snapshot);
    return index.findPathIdentityCandidates(path, snapshot.policy);
}

/**
 * Retain and share the active host listing until its event count or policy changes.
 *
 * @param dependencies - Narrow host callbacks, resolved when a query runs.
 * @returns A per-service fallback lookup with explicit fresh-read invalidation.
 * @remarks
 * The factory owns only the retained request state and delegates to standalone
 * operations. Retiring a request fences older work: it can finish for existing
 * callers without publishing over a newer request. Failed reads can be retried.
 */
export function createFallbackFileNameLookup(dependencies: FileNameLookupDependencies): FallbackFileNameLookup {
    const state: FallbackFileNameLookupState = { retained: undefined };
    return {
        invalidate: () => invalidateFileNameLookup(state),
        findPathIdentityCandidates: (path, policy) => findPathIdentityCandidates(dependencies, state, path, policy),
    };
}
