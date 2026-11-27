const LEGACY_KEY = "replicationResultProcessorSnapshot";
const QUEUE_PREFIX = "replication-result-queue:";
const ROW_PREFIX = `${QUEUE_PREFIX}v1:`;
const ROW_KINDS = ["processing", "queued", "pendingReflection", "recoveryAttempt"] as const;

type RowKind = (typeof ROW_KINDS)[number];
type Row<Kind extends RowKind, Payload> = {
    readonly kind: Kind;
    /** An occurrence ID shared across phase changes. Reserve the 'legacy:' prefix for migration. */
    readonly id: string;
    /** Non-negative safe integer used to order rows within this kind. */
    readonly order: number;
    readonly payload: Payload;
};

export type ReplicationResultQueueRow<D, P, A> =
    | Row<"queued", D>
    | Row<"processing", D>
    | Row<"pendingReflection", P>
    | Row<"recoveryAttempt", A>;

export type ReplicationResultQueueDelta<D, P, A> =
    | { readonly kind: "upsert"; readonly row: ReplicationResultQueueRow<D, P, A> }
    | { readonly kind: "delete"; readonly id: string };

type StoredRow = ReplicationResultQueueRow<unknown, unknown, unknown>;

export type ReplicationResultQueueWrite =
    | { readonly kind: "upsert"; readonly key: string; readonly value: StoredRow }
    | { readonly kind: "delete"; readonly key: string };

/** Storage for one database and vault scope. The host supplies value encoding and decoding. */
export interface ReplicationResultQueueBacking {
    /** Return undefined for an absent key and reject on any read or decoding failure. */
    read(key: string): Promise<unknown>;
    /** List every key with the literal prefix exactly once, in any order. */
    listKeys(prefix: string): Promise<readonly string[]>;
    /** Apply the entire ordered batch atomically and resolve after it commits. Deleting absent keys succeeds. */
    writeBatch(operations: readonly ReplicationResultQueueWrite[]): Promise<void>;
}

/**
 * The host serialises all calls and excludes other writers to the queue keys.
 * The host owns payload validation, replay policy, and occurrence IDs. Keep an ID
 * for the lifetime of the same occurrence and issue fresh IDs even across resets.
 */
export interface ReplicationResultQueueStore<D, P, A> {
    /**
     * Migrate a legacy snapshot if present, then return rows by kind in replay
     * order and by ascending order within each kind. Ties use ascending ID.
     * Payloads require host validation before use.
     */
    load(): Promise<readonly StoredRow[]>;
    /** Apply only these changes, in order, after a successful load or discard. Keep payloads stable until the call settles. */
    commit(delta: readonly ReplicationResultQueueDelta<D, P, A>[]): Promise<void>;
    /** Atomically delete queue rows and the legacy snapshot. May be called before load to skip replay. */
    discard(): Promise<void>;
}

const LEGACY_FIELDS = {
    processing: "processing",
    queued: "queued",
    pendingReflection: "pendingReflections",
    recoveryAttempt: "recoveryAttempts",
} as const satisfies Record<RowKind, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredRow(value: unknown): value is StoredRow {
    return (
        isRecord(value) &&
        ROW_KINDS.some((kind) => kind === value.kind) &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
        typeof value.order === "number" &&
        Number.isSafeInteger(value.order) &&
        value.order >= 0 &&
        Object.hasOwn(value, "payload") &&
        value.payload !== undefined
    );
}

function rowKey(id: string): string {
    if (typeof id !== "string" || id.length === 0) {
        throw new TypeError("A replication result queue row requires a non-empty ID.");
    }
    return `${ROW_PREFIX}${id}`;
}

function upsertRow(value: StoredRow): ReplicationResultQueueWrite {
    return { kind: "upsert", key: rowKey(value.id), value };
}

/**
 * Convert a legacy snapshot to rows in replay order. Each array index determines
 * the row's order and forms part of its migrated occurrence ID.
 *
 * @param snapshot - The decoded value of the legacy snapshot key.
 * @returns Rows carrying their original payloads for the host to validate.
 * @throws If the snapshot, a queue array, or an entry has an invalid storage format.
 */
export function rowsFromLegacyReplicationResultSnapshot(snapshot: unknown): StoredRow[] {
    if (!isRecord(snapshot)) {
        throw new Error("Invalid legacy replication result queue snapshot.");
    }

    const rows: StoredRow[] = [];
    // Older snapshots also carried control metadata. Only queue fields take part in migration.
    for (const kind of ROW_KINDS) {
        const field = LEGACY_FIELDS[kind];
        const records = snapshot[field];
        const optional = kind === "pendingReflection" || kind === "recoveryAttempt";
        if (optional && (records === undefined || records === null)) {
            continue;
        }
        if (!Array.isArray(records)) {
            throw new Error(`Invalid '${field}' array in the legacy replication result queue snapshot.`);
        }
        for (const [order, payload] of records.entries()) {
            // LiveSync validates pending headers and reads attempt identities from non-null values.
            const validPayload = optional
                ? payload !== undefined && (kind === "pendingReflection" || payload !== null)
                : isRecord(payload);
            if (!validPayload) {
                throw new Error(`Invalid '${field}' entry in the legacy replication result queue snapshot.`);
            }
            rows.push({ kind, id: `legacy:${kind}:${order}`, order, payload });
        }
    }
    return rows;
}

/**
 * Compare rows by kind in replay order, then by ascending order within that
 * kind and ascending occurrence ID using string comparison.
 *
 * @returns A negative number when `left` comes first, zero when the sort keys
 * match, and a positive number when `right` comes first.
 */
export function compareReplicationResultQueueRows(left: StoredRow, right: StoredRow): number {
    const order = ROW_KINDS.indexOf(left.kind) - ROW_KINDS.indexOf(right.kind) || left.order - right.order;
    if (order !== 0 || left.id === right.id) {
        return order;
    }
    return left.id < right.id ? -1 : 1;
}

async function listQueueKeys(backing: Pick<ReplicationResultQueueBacking, "listKeys">): Promise<readonly string[]> {
    const keys = await backing.listKeys(QUEUE_PREFIX);
    if (keys.some((key) => !key.startsWith(QUEUE_PREFIX))) {
        throw new Error("The replication result queue backing returned keys outside the queue namespace.");
    }
    return keys;
}

/**
 * Read stored rows in replay order. When a legacy snapshot is present, write
 * its rows and delete the legacy key in the same atomic batch before returning.
 *
 * @param backing - Storage for one queue scope. Exclude other writers to its
 * queue keys while this operation runs.
 * @returns Rows with payloads that require host validation before use.
 * @throws If stored data is invalid, both formats exist, or a backing operation fails.
 */
export async function loadReplicationResultQueueRows(backing: ReplicationResultQueueBacking): Promise<StoredRow[]> {
    const keys = await listQueueKeys(backing);
    const legacySnapshot = await backing.read(LEGACY_KEY);
    if (legacySnapshot !== undefined) {
        if (keys.length > 0) {
            throw new Error("The replication result queue contains both a legacy snapshot and queue rows.");
        }
        const rows = rowsFromLegacyReplicationResultSnapshot(legacySnapshot);
        await backing.writeBatch([...rows.map(upsertRow), { kind: "delete", key: LEGACY_KEY }]);
        return rows;
    }

    const rows: StoredRow[] = [];
    for (const key of keys) {
        if (!key.startsWith(ROW_PREFIX)) {
            throw new Error("Unsupported replication result queue row version.");
        }
        const value = await backing.read(key);
        if (!isStoredRow(value) || key !== rowKey(value.id)) {
            throw new Error("Invalid replication result queue row or missing listed value.");
        }
        rows.push(value);
    }
    return rows.sort(compareReplicationResultQueueRows);
}

/**
 * Validate row storage fields and translate queue changes to versioned key
 * operations. Payloads pass through for the backing to encode.
 *
 * @param delta - Changes to translate in the order supplied by the host.
 * @returns The corresponding writes in input order, ready for one atomic batch.
 * @throws {@link TypeError} If a change has an invalid row, occurrence ID, or kind.
 */
export function toReplicationResultQueueWrites(
    delta: readonly ReplicationResultQueueDelta<unknown, unknown, unknown>[]
): ReplicationResultQueueWrite[] {
    return delta.map<ReplicationResultQueueWrite>((change) => {
        switch (change.kind) {
            case "upsert":
                if (!isStoredRow(change.row)) {
                    throw new TypeError("Invalid replication result queue row.");
                }
                return upsertRow(change.row);
            case "delete":
                return { kind: "delete", key: rowKey(change.id) };
            default:
                throw new TypeError("Invalid replication result queue change.");
        }
    });
}

/**
 * Create a store for a single replication result queue. Construction performs
 * no I/O. Call `load()` or `discard()` successfully before calling `commit()`.
 *
 * @typeParam D - Document payload written for queued and processing items.
 * @typeParam P - Payload written for retained reflection failures.
 * @typeParam A - Payload written for recovery attempts.
 * @param backing - Host-owned storage that can commit an ordered batch atomically.
 * @returns A queue store whose operations the host must serialise.
 */
export function createReplicationResultQueueStore<D, P, A>(
    backing: ReplicationResultQueueBacking
): ReplicationResultQueueStore<D, P, A> {
    let ready = false;

    return {
        async load() {
            ready = false;
            const rows = await loadReplicationResultQueueRows(backing);
            ready = true;
            return rows;
        },
        async commit(delta) {
            if (!ready) {
                throw new Error("Load or discard the replication result queue before committing changes.");
            }
            if (delta.length === 0) {
                return;
            }
            await backing.writeBatch(toReplicationResultQueueWrites(delta));
        },
        async discard() {
            ready = false;
            const keys = await listQueueKeys(backing);
            const operations = [...keys, LEGACY_KEY].map<ReplicationResultQueueWrite>((key) => ({
                kind: "delete",
                key,
            }));
            await backing.writeBatch(operations);
            ready = true;
        },
    };
}
