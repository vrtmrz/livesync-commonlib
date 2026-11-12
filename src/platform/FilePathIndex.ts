import { getStoragePathComparisonKey } from "./pathComparison.ts";
import type { FilePath, PathComparisonKey, PathComparisonSettings } from "./pathTypes.ts";

/**
 * Original file paths removed and added by one synchronous membership change.
 *
 * @remarks
 * Repeated additions and absent removals are harmless. A path present in both
 * lists remains present, including when it was absent before the change.
 * Hosts expand folder renames into file-path deltas before applying them.
 */
export interface FilePathDelta {
    readonly removed: readonly FilePath[];
    readonly added: readonly FilePath[];
}

/** Controls whether a name read can reuse the host's maintained inventory. */
export interface FileNameReadOptions {
    /**
     * Ask the host's listing authority again instead of reusing the name index.
     *
     * @remarks
     * Freshness follows that host's existing listing contract. For example,
     * Obsidian supplies its Vault listing rather than an independent disk walk.
     */
    readonly fresh?: boolean;
}

/** Host-owned name reads and candidate selection for one storage root. */
export interface FileNameLookup {
    /**
     * Read the host's supported original file paths.
     *
     * @param options - Whether to ask the listing authority for a fresh view.
     * @returns A copy of the complete supported inventory, preserving spelling.
     * @throws Rejects unavailable or failed inventory reads rather than reporting
     * a successful empty inventory. Host-specific listing exclusions still apply.
     */
    getFileNames(options?: FileNameReadOptions): Promise<FilePath[]>;

    /**
     * Find original paths which match the requested path-identity comparison key.
     *
     * @param path - Original file path to compare within this storage root.
     * @param policy - Explicit Unicode normalisation and case comparison rules.
     * @returns Every matching original path in diagnostic order, including the
     * requested spelling when present. An empty result means no supported match.
     * @throws Rejects unavailable coverage and host validation or read failures.
     * @remarks
     * The host establishes read readiness and physical-path safety. The caller
     * decides whether multiple candidates constitute a collision; this operation
     * neither chooses a preferred spelling nor compares file contents.
     */
    findPathIdentityCandidates(path: FilePath, policy: PathComparisonSettings): Promise<readonly FilePath[]>;
}

/** Cache slot for the four supported Unicode/case policies, rather than a file identity. */
type IdentityPolicyKey = `${PathComparisonSettings["pathNormalizationVersion"]}:${"sensitive" | "insensitive"}`;

type IdentityBuckets = Map<PathComparisonKey<"storage">, Set<FilePath>>;

interface CachedIdentityBuckets {
    readonly policy: PathComparisonSettings;
    readonly buckets: IdentityBuckets;
}

function validatePath(path: FilePath): FilePath {
    if (typeof path !== "string") {
        throw new TypeError("File paths must be strings");
    }
    return path;
}

function snapshotPolicy(policy: PathComparisonSettings): PathComparisonSettings {
    const { pathNormalizationVersion, handleFilenameCaseSensitive } = policy;
    if (pathNormalizationVersion !== 0 && pathNormalizationVersion !== 1) {
        throw new Error(`Unsupported path normalisation version: ${pathNormalizationVersion}`);
    }
    if (typeof handleFilenameCaseSensitive !== "boolean") {
        throw new TypeError("Filename case handling must be explicit");
    }
    return { pathNormalizationVersion, handleFilenameCaseSensitive };
}

/** Select a bounded cache slot after validating and copying the comparison policy. */
function getPolicyKey(policy: PathComparisonSettings): IdentityPolicyKey {
    return `${policy.pathNormalizationVersion}:${policy.handleFilenameCaseSensitive ? "sensitive" : "insensitive"}`;
}

/** Group retained spellings by the shared storage comparison key for one policy. */
function createIdentityBuckets(paths: Iterable<FilePath>, policy: PathComparisonSettings): IdentityBuckets {
    const buckets: IdentityBuckets = new Map();
    for (const path of paths) {
        const key = getStoragePathComparisonKey(path, policy);
        const bucket = buckets.get(key) ?? new Set<FilePath>();
        bucket.add(path);
        buckets.set(key, bucket);
    }
    return buckets;
}

/**
 * Maintains original file-path membership and lazily materialised identity buckets.
 *
 * @remarks
 * The host owns supported-path validation, observation, and query readiness.
 * This class stores original spellings and performs no I/O. Membership changes
 * update every materialised policy map; at most four policy maps are retained.
 * Queries return copies and leave file contents and physical names untouched.
 *
 * A first query for a policy derives its buckets in one pass over the retained
 * paths. Subsequent queries select and sort only the matching candidates.
 */
export class FilePathIndex {
    private paths = new Set<FilePath>();
    private indexes = new Map<IdentityPolicyKey, CachedIdentityBuckets>();

    /**
     * Replace the complete inventory and all materialised policy maps together.
     *
     * @param paths - Host-enumerated original file paths. Duplicate paths collapse
     * into one membership without normalising their spelling.
     * @throws Propagates invalid runtime members or iterable failures before
     * replacing the current inventory or any existing policy map.
     * @remarks
     * Validation checks string members; filesystem admission remains the host's
     * responsibility. Callers use this after a successful initial or fresh read.
     */
    replaceAll(paths: Iterable<FilePath>): void {
        const nextPaths = new Set<FilePath>();
        for (const path of paths) {
            nextPaths.add(validatePath(path));
        }

        const nextIndexes = new Map<IdentityPolicyKey, CachedIdentityBuckets>();
        for (const [key, { policy }] of this.indexes) {
            nextIndexes.set(key, { policy, buckets: createIdentityBuckets(nextPaths, policy) });
        }

        this.paths = nextPaths;
        this.indexes = nextIndexes;
    }

    /**
     * Apply one membership delta to the inventory and every cached policy map.
     *
     * @param delta - Original paths removed and added by the same change.
     * @throws Propagates invalid runtime members before changing retained state.
     * @remarks
     * Inputs and comparison keys are prepared before mutation. The synchronous
     * update publishes no intermediate rename state. Repeated notifications do
     * not create duplicate memberships, and content-only edits need no delta.
     */
    apply(delta: FilePathDelta): void {
        const removed = new Set(delta.removed.map(validatePath));
        const added = new Set(delta.added.map(validatePath));

        // A same-path remove/add is a no-op only when that membership already exists.
        for (const path of added) {
            if (removed.has(path)) {
                removed.delete(path);
                if (this.paths.has(path)) {
                    added.delete(path);
                }
            }
        }

        const actualRemoved = [...removed].filter((path) => this.paths.has(path));
        const actualAdded = [...added].filter((path) => !this.paths.has(path));
        if (actualRemoved.length === 0 && actualAdded.length === 0) {
            return;
        }

        // Compute every key before mutating membership or any cached policy map.
        const indexUpdates = [...this.indexes.values()].map(({ buckets, policy }) => ({
            buckets,
            removed: actualRemoved.map((path) => [getStoragePathComparisonKey(path, policy), path] as const),
            added: actualAdded.map((path) => [getStoragePathComparisonKey(path, policy), path] as const),
        }));

        for (const path of actualRemoved) {
            this.paths.delete(path);
        }
        for (const path of actualAdded) {
            this.paths.add(path);
        }
        for (const { buckets, removed: removedKeys, added: addedKeys } of indexUpdates) {
            for (const [key, path] of removedKeys) {
                const bucket = buckets.get(key);
                bucket?.delete(path);
                if (bucket?.size === 0) {
                    buckets.delete(key);
                }
            }
            for (const [key, path] of addedKeys) {
                const bucket = buckets.get(key) ?? new Set<FilePath>();
                bucket.add(path);
                buckets.set(key, bucket);
            }
        }
    }

    /**
     * Copy the current in-memory membership without refreshing the host listing.
     *
     * @returns Original spellings in an independent array. Full-list ordering is
     * unspecified; changing the returned array cannot change this index.
     */
    getFileNames(): FilePath[] {
        return [...this.paths];
    }

    /**
     * Select every indexed path with the requested storage comparison key.
     *
     * @param path - Path whose identity selects a candidate bucket.
     * @param policy - Explicit Unicode normalisation and case comparison rules.
     * @returns A sorted copy of all matching original paths, or an empty array
     * when no indexed path matches. Multiple paths remain separate candidates.
     * @throws Rejects a non-string path or unsupported comparison settings.
     * @remarks
     * The first query for each policy materialises its buckets. Later membership
     * deltas maintain those buckets incrementally. Host readiness, existence,
     * physical alias checks, and the final collision decision are external.
     */
    findPathIdentityCandidates(path: FilePath, policy: PathComparisonSettings): readonly FilePath[] {
        const validatedPath = validatePath(path);
        const policySnapshot = snapshotPolicy(policy);
        const policyKey = getPolicyKey(policySnapshot);
        let index = this.indexes.get(policyKey);
        if (!index) {
            index = { policy: policySnapshot, buckets: createIdentityBuckets(this.paths, policySnapshot) };
            this.indexes.set(policyKey, index);
        }

        const key = getStoragePathComparisonKey(validatedPath, policySnapshot);
        return [...(index.buckets.get(key) ?? [])].sort();
    }
}
