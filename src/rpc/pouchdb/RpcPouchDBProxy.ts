// This module defines RpcPouchDBProxy, a PouchDB-compatible proxy.
// Now this implementation is a sample and for Node.js environment. Hence,
// eslint rules are disabled for CIs. I will refactor this module or move to a
// separate file.
// eslint-disable-next-line import/no-nodejs-modules
import EventEmitter from "events";
import { RpcError } from "@lib/rpc/errors";
import type { RpcSession } from "@lib/rpc/RpcSession";

/** No-op ActiveTasks stub required by pouchdb-replication for progress tracking. */
const noopActiveTasks = {
    add: (_task: object): any => null,
    get: (_id: any): any => null,
    update: (_id: any, _update: object): void => {},
    remove: (_id: any, _err?: Error): void => {},
    list: (): any[] => [],
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
    private async callDB<T>(method: string, args: unknown[] = []): Promise<T> {
        try {
            return await this.session.call<T>(`${this.ns}.${method}`, args as any);
        } catch (err: any) {
            if (err instanceof RpcError && err.code === "REMOTE_ERROR") {
                const d = err.details as any;
                if (d?.name || d?.status) {
                    const pouchErr = new Error(err.message) as any;
                    if (d.name) pouchErr.name = d.name;
                    if (d.status) pouchErr.status = d.status;
                    if (d.reason) pouchErr.reason = d.reason;
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
        const emitter = new EventEmitter() as any;
        let cancelled = false;

        const promise = this.callDB<any>("changes", [{ ...opts, live: false }]).then((info) => {
            if (cancelled) return info as PouchDB.Core.ChangesResponse<object>;
            for (const change of info.results ?? []) {
                if (cancelled) break;
                emitter.emit("change", change);
            }
            if (!cancelled) emitter.emit("complete", info);
            return info as PouchDB.Core.ChangesResponse<object>;
        });

        promise.catch((err: unknown) => {
            if (!cancelled) emitter.emit("error", err);
        });

        emitter.cancel = () => {
            cancelled = true;
            emitter.removeAllListeners();
        };

        // Make the emitter thenable so it can be used with `await`.
        emitter.then = <R>(
            onfulfilled?: (v: PouchDB.Core.ChangesResponse<object>) => R | PromiseLike<R>,
            onrejected?: (e: any) => R | PromiseLike<R>
        ) => promise.then(onfulfilled, onrejected);

        emitter.catch = <R>(onrejected?: (e: any) => R | PromiseLike<R>) => promise.catch(onrejected);

        return emitter as PouchDB.Core.Changes<object>;
    }

    get<T extends object>(
        id: string,
        opts?: PouchDB.Core.GetOptions
    ): Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
        return this.callDB("get", [id, opts ?? {}]);
    }

    put<T extends object>(
        doc: PouchDB.Core.PutDocument<T>,
        opts?: PouchDB.Core.PutOptions
    ): Promise<PouchDB.Core.Response> {
        return this.callDB("put", [doc, opts ?? {}]);
    }

    bulkGet<T extends object>(opts: PouchDB.Core.BulkGetOptions): Promise<PouchDB.Core.BulkGetResponse<T>> {
        return this.callDB("bulkGet", [opts]);
    }

    bulkDocs<T extends object>(
        docs: PouchDB.Core.PostDocument<T>[] | { docs: PouchDB.Core.PostDocument<T>[]; new_edits?: boolean },
        opts?: PouchDB.Core.BulkDocsOptions
    ): Promise<(PouchDB.Core.Response | PouchDB.Core.Error)[]> {
        return this.callDB("bulkDocs", [docs, opts ?? {}]);
    }

    revsDiff(diff: PouchDB.Core.RevisionDiffOptions): Promise<PouchDB.Core.RevisionDiffResponse> {
        return this.callDB("revsDiff", [diff]);
    }

    allDocs<T extends object>(opts?: PouchDB.Core.AllDocsOptions): Promise<PouchDB.Core.AllDocsResponse<T>> {
        return this.callDB("allDocs", [opts ?? {}]);
    }
}
