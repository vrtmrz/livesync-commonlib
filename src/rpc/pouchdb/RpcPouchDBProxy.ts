// This module defines RpcPouchDBProxy, a PouchDB-compatible proxy.
// Now this implementation is a sample and for Node.js environment. Hence,
// eslint rules are disabled for CIs. I will refactor this module or move to a
// separate file.
// eslint-disable-next-line import/no-nodejs-modules
import EventEmitter from "events";
import { RpcError } from "../errors";
import type { RpcSession } from "../RpcSession";
import type { JsonLike } from "../types";

/** No-op ActiveTasks stub required by pouchdb-replication for progress tracking. */
const noopActiveTasks = {
    add: (_task: object): unknown => null,
    get: (_id: unknown): unknown => null,
    update: (_id: unknown, _update: object): void => {},
    remove: (_id: unknown, _err?: Error): void => {},
    list: (): unknown[] => [],
};

/**
 * A PouchDB-compatible proxy that forwards all database operations to a remote
 * peer via an {@link RpcSession}.
 *
 * The proxy exposes the same public interface as a PouchDB instance and can be
 * passed directly to `PouchDB.replicate()` or `PouchDB.sync()` as either the
 * source or the target database.  It can also be used with {@link replicateShim}
 * from `ReplicatorShim.ts`.
 *
 * The remote side must have called {@link exposeDB} to register the matching
 * RPC handlers.
 *
 * ### Changes feed
 * `changes()` returns an object that satisfies both the EventEmitter interface
 * required by `pouchdb-replication` and the Promise interface required by
 * `replicateShim` (i.e. it can be `await`ed directly).
 *
 * ### Error propagation
 * PouchDB-specific error properties (`status`, `name`, `reason`) are preserved
 * across the RPC transport and reconstructed on the proxy side so that callers
 * such as `pouchdb-checkpointer` can inspect `err.status === 404` correctly.
 */
export class RpcPouchDBProxy extends EventEmitter {
    /** The logical name of the remote database. */
    readonly name: string;

    /**
     * Stub ActiveTasks object required by `pouchdb-replication`.  All
     * operations are no-ops; task state is not tracked across the RPC boundary.
     */
    readonly activeTasks = noopActiveTasks;

    private readonly session: RpcSession;
    private readonly ns: string;

    constructor(session: RpcSession, name: string, ns = "pdb") {
        super();
        this.session = session;
        this.name = name;
        this.ns = ns;
    }

    /**
     * Invoke an RPC method and reconstruct PouchDB error shapes on the response.
     *
     * When the remote handler wraps a PouchDB error via {@link exposeDB}'s
     * `runDB` helper, the `RpcError.details` object carries `status`, `name`,
     * and `reason`.  This method rebuilds a plain `Error` with those properties
     * so that callers (e.g. pouchdb-checkpointer) can use `err.status` /
     * `err.name` as expected.
     */
    private async callDB<T>(method: string, args: JsonLike[] = []): Promise<T> {
        try {
            return await this.session.call<T>(`${this.ns}.${method}`, args);
        } catch (err: unknown) {
            if (err instanceof RpcError && err.code === "REMOTE_ERROR") {
                const d = err.details as Record<string, unknown> | undefined;
                if (d?.name || d?.status) {
                    const pouchErr = new Error(err.message) as Error & {
                        name?: string;
                        status?: number;
                        reason?: string;
                    };
                    if (d.name) pouchErr.name = typeof d.name === "string" ? d.name : String(d.name); // eslint-disable-line @typescript-eslint/no-base-to-string
                    if (d.status) pouchErr.status = Number(d.status);
                    if (d.reason) pouchErr.reason = typeof d.reason === "string" ? d.reason : String(d.reason); // eslint-disable-line @typescript-eslint/no-base-to-string
                    throw pouchErr;
                }
            }
            throw err;
        }
    }

    info(): Promise<PouchDB.Core.DatabaseInfo> {
        return this.callDB("info");
    }

    id(): Promise<string> {
        return this.callDB("id");
    }

    /**
     * Returns a `Changes`-compatible object that is simultaneously:
     * - An **EventEmitter** with `change`, `complete`, and `error` events, plus
     *   a `cancel()` method — satisfying the interface consumed by
     *   `PouchDB.replicate()` / `PouchDB.sync()`.
     * - A **thenable** (`then` / `catch`) — allowing `await db.changes(opts)`
     *   as used by `replicateShim`.
     *
     * The remote changes feed is always fetched as a one-shot snapshot
     * (`live: false`).
     */
    changes(opts: PouchDB.Core.ChangesOptions): PouchDB.Core.Changes<object> {
        const emitter = new EventEmitter();
        let cancelled = false;

        const promise = this.callDB<{ results?: unknown[] }>("changes", [
            { ...opts, live: false } as unknown as JsonLike,
        ]).then((info) => {
            if (cancelled) return info as unknown as PouchDB.Core.ChangesResponse<object>;
            for (const change of info.results ?? []) {
                if (cancelled) break;
                emitter.emit("change", change);
            }
            if (!cancelled) emitter.emit("complete", info);
            return info as unknown as PouchDB.Core.ChangesResponse<object>;
        });

        promise.catch((err: unknown) => {
            if (!cancelled) emitter.emit("error", err);
        });

        const changesEmitter = emitter as unknown as PouchDB.Core.Changes<object> & {
            cancel: () => void;
            then: <TResult1 = PouchDB.Core.ChangesResponse<object>, TResult2 = never>(
                onfulfilled?:
                    | ((value: PouchDB.Core.ChangesResponse<object>) => TResult1 | PromiseLike<TResult1>)
                    | null,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
            ) => Promise<TResult1 | TResult2>;
            catch: <TResult = never>(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
            ) => Promise<PouchDB.Core.ChangesResponse<object> | TResult>;
        };

        changesEmitter.cancel = () => {
            cancelled = true;
            emitter.removeAllListeners();
        };

        // Make the emitter thenable so it can be used with `await`.
        changesEmitter.then = <TResult1 = PouchDB.Core.ChangesResponse<object>, TResult2 = never>(
            onfulfilled?: ((value: PouchDB.Core.ChangesResponse<object>) => TResult1 | PromiseLike<TResult1>) | null,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
        ) => promise.then(onfulfilled, onrejected);

        changesEmitter.catch = <TResult = never>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
        ) => promise.catch(onrejected);

        return changesEmitter;
    }

    get<T extends object>(
        id: string,
        opts?: PouchDB.Core.GetOptions
    ): Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
        return this.callDB("get", [id, (opts ?? {}) as unknown as JsonLike]);
    }

    put<T extends object>(
        doc: PouchDB.Core.PutDocument<T>,
        opts?: PouchDB.Core.PutOptions
    ): Promise<PouchDB.Core.Response> {
        return this.callDB("put", [doc as unknown as JsonLike, (opts ?? {}) as unknown as JsonLike]);
    }

    bulkGet<T extends object>(opts: PouchDB.Core.BulkGetOptions): Promise<PouchDB.Core.BulkGetResponse<T>> {
        return this.callDB("bulkGet", [opts as unknown as JsonLike]);
    }

    bulkDocs<T extends object>(
        docs: PouchDB.Core.PostDocument<T>[] | { docs: PouchDB.Core.PostDocument<T>[]; new_edits?: boolean },
        opts?: PouchDB.Core.BulkDocsOptions
    ): Promise<(PouchDB.Core.Response | PouchDB.Core.Error)[]> {
        return this.callDB("bulkDocs", [docs as unknown as JsonLike, (opts ?? {}) as unknown as JsonLike]);
    }

    revsDiff(diff: PouchDB.Core.RevisionDiffOptions): Promise<PouchDB.Core.RevisionDiffResponse> {
        return this.callDB("revsDiff", [diff as unknown as JsonLike]);
    }

    allDocs<T extends object>(opts?: PouchDB.Core.AllDocsOptions): Promise<PouchDB.Core.AllDocsResponse<T>> {
        return this.callDB("allDocs", [(opts ?? {}) as unknown as JsonLike]);
    }
}
