import type PouchDB from "pouchdb-core";

/**
 * Options which bind requests made through a remote CouchDB connection to the
 * operation which owns it.
 */
export interface RemoteConnectionOpenOptions {
    /**
     * Cancels abort-capable requests made through the connection when the
     * owning operation is cancelled.
     */
    readonly signal?: AbortSignal;
    /**
     * Allows the diagnostic fallback to a host-native request API after a
     * web-compatible request reports a network `TypeError`.
     *
     * Set this to `false` when the owner must retain an abortable request path.
     * A host-native adapter is not assumed to honour `AbortSignal`.
     */
    readonly allowNativeFallback?: boolean;
}

/**
 * A remote PouchDB handle together with the lifecycle of requests created
 * through that handle.
 *
 * @remarks
 * The caller owns this connection and must call
 * {@link OwnedCouchDBConnection.close} when ownership is not transferred.
 * `close()` is idempotent: it first cancels abort-capable requests within this
 * connection, then closes the PouchDB handle. Closing the PouchDB handle retains
 * its normal `closed` event behaviour. This contract does not imply exclusive
 * ownership of a physical HTTP socket.
 *
 * @typeParam T - The document type stored in the remote database.
 */
export interface OwnedCouchDBConnection<T extends object> {
    /** The remote PouchDB database handle. */
    readonly db: PouchDB.Database<T>;

    /**
     * The database information read while opening the connection. When the
     * caller skips that read, compatibility placeholders are returned.
     */
    readonly info: PouchDB.Core.DatabaseInfo;

    /** Cancels scoped requests and closes the PouchDB handle exactly once. */
    close(): Promise<void>;
}
