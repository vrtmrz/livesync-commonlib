import { LOG_LEVEL_VERBOSE, Logger } from "../common/logger.ts";
import { FallbackWeakRef } from "octagonal-wheels/common/polyfill";

/**
 * Options for configuring the ChangeManager.
 */
export interface ChangeManagerOptions {
    /**
     * The PouchDB database instance to monitor for changes.
     */
    database: PouchDB.Database;
}

export type ChangeManagerCallback = (change: PouchDB.Core.ChangesResponseChange<any>) => void | Promise<void>;

/**
 * Manages and dispatches changes from a PouchDB database to registered callbacks.
 *
 * @template T The type of documents stored in the PouchDB database.
 */
export class ChangeManager<T extends object = object> {
    /**
     * The PouchDB database instance being monitored.
     */
    _database: PouchDB.Database<T>;

    /**
     * Creates a new instance of the ChangeManager.
     *
     * @param options - Configuration options for the ChangeManager.
     */
    constructor(options: ChangeManagerOptions) {
        this._database = options.database as PouchDB.Database<T>;
        this.setupListener();
    }

    /**
     * A list of registered callbacks wrapped in WeakRefs to avoid memory leaks.
     */
    _callbacks: FallbackWeakRef<ChangeManagerCallback>[] = [];

    /**
     * Registers a new callback to be invoked when a change occurs.
     *
     * @param callback - The callback function to register.
     */
    addCallback(callback: ChangeManagerCallback): () => void {
        const callbackHandler = new FallbackWeakRef(callback);
        this._callbacks.push(callbackHandler);
        return () => {
            this._callbacks = this._callbacks.filter((cb) => cb !== callbackHandler);
        };
    }
    removeCallback(callback: ChangeManagerCallback): void {
        this._callbacks = this._callbacks.filter((cb) => cb.deref() !== callback);
    }

    /**
     * The PouchDB changes feed instance, if active.
     */
    _changes?: PouchDB.Core.Changes<T>;

    /**
     * Handles a change event from the PouchDB changes feed.
     *
     * @param changeResponse - The change response object from the PouchDB changes feed.
     */
    async _onChange(changeResponse: PouchDB.Core.ChangesResponseChange<T>): Promise<void> {
        if (!this._callbacks.length) {
            return;
        }
        // Cleanup dead WeakRefs
        this._callbacks = this._callbacks.filter((callback) => callback.deref() !== undefined);
        for (const callback of this._callbacks) {
            try {
                const cb = callback.deref();
                if (!cb) {
                    continue;
                }
                await Promise.resolve(cb(changeResponse));
            } catch (err) {
                this._changes?.emit("error", err);
            }
        }
    }

    /**
     * Sets up the PouchDB changes feed listener to monitor for database changes.
     */
    setupListener(): void {
        if (this._changes) {
            const changes = this._changes;
            this._changes = undefined;
            void changes.removeAllListeners();
            changes.cancel();
        }

        const changes = this._database.changes({
            since: "now",
            live: true,
            include_docs: true,
        });
        void changes.on("change", (change) => {
            void this._onChange(change);
        });
        void changes.on("error", (err) => {
            Logger("ChangeManager Error watching changes");
            Logger(err, LOG_LEVEL_VERBOSE);
            // void this.restartWatch();
        });
        this._changes = changes;
    }

    /**
     * Tears down the PouchDB changes feed listener and cleans up resources.
     */
    teardown(): void {
        void this._changes?.removeAllListeners();
        this._changes?.cancel();
        this._changes = undefined;
    }

    /**
     * Restarts the PouchDB changes feed listener.
     */
    restartWatch(): void {
        void this.teardown();
        void this.setupListener();
    }
}
