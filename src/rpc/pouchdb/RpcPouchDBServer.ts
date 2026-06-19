import { LiveSyncError } from "@lib/common/LSError";
import { RpcError } from "@lib/rpc/errors";
import type { RpcRoom } from "@lib/rpc/RpcRoom";
type ErrorLike = { name?: string; message?: string; reason?: string; error?: Error; status?: number };
/**
 * Wraps a PouchDB operation so that PouchDB-specific error properties
 * (`status`, `name`, `reason`) survive the RPC serialisation boundary and
 * can be reconstructed by {@link RpcPouchDBProxy}.
 */
async function runDB<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        const err = e as ErrorLike;
        if (err?.status || err?.name) {
            const details: Record<string, string | number> = {};
            if (err.status) details.status = err.status;
            if (err.name) details.name = err.name;
            if (err.reason) details.reason = err.reason;
            throw new RpcError("REMOTE_ERROR", err.message ?? String(LiveSyncError.fromError(err)), details);
        }
        throw e;
    }
}

/**
 * Exposes a PouchDB database as a set of RPC methods registered on an
 * {@link RpcRoom}.  The remote peer can access the database via
 * {@link RpcPouchDBProxy}.
 *
 * All methods are registered under the given namespace prefix `ns` (default:
 * `'pdb'`).  For example, with the default namespace the method names are
 * `pdb.info`, `pdb.id`, `pdb.changes`, `pdb.get`, `pdb.put`, `pdb.bulkGet`,
 * `pdb.bulkDocs`, `pdb.revsDiff`, and `pdb.allDocs`.
 *
 * @param room  The {@link RpcRoom} on which to register handlers.
 * @param db    The PouchDB database instance to expose.
 * @param ns    Method namespace prefix (default: `'pdb'`).
 */
export function exposeDB(room: RpcRoom, db: PouchDB.Database<object>, ns = "pdb"): void {
    room.register(`${ns}.info`, () => runDB(() => db.info() as Promise<unknown>));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PouchDB's `id()` is not typed
    room.register(`${ns}.id`, () => runDB(() => (db as any).id() as unknown as Promise<string> as Promise<unknown>));

    // The changes feed is always served as a one-shot snapshot.  Live feeds
    // would require a push channel and are not supported over RPC.
    room.register(`${ns}.changes`, (_peerId, opts) =>
        runDB(
            () =>
                new Promise<unknown>((resolve, reject) => {
                    const feed = db.changes({ ...(opts as object), live: false });
                    void feed.on("complete", resolve);
                    void feed.on("error", reject);
                })
        )
    );

    room.register(`${ns}.get`, (_peerId, id, opts) =>
        runDB(() => db.get<unknown>(id as string, (opts ?? {}) as object) as Promise<unknown>)
    );

    room.register(`${ns}.put`, (_peerId, doc, opts) =>
        runDB(() => db.put(doc as object, (opts ?? {}) as object) as Promise<unknown>)
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrongly typed in @types/pouchdb (incorrect overload signatures)
    room.register(`${ns}.bulkGet`, (_peerId, opts) => runDB(() => db.bulkGet(opts as any) as Promise<unknown>));

    // `req` may be either a document array or `{docs, new_edits}` object —
    // both forms are accepted by PouchDB's public `bulkDocs` method.
    room.register(`${ns}.bulkDocs`, (_peerId, req, opts) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrongly typed in @types/pouchdb (incorrect overload signatures)
        runDB(() => db.bulkDocs(req as any, (opts ?? {}) as object) as Promise<unknown>)
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrongly typed in @types/pouchdb (incorrect overload signatures)
    room.register(`${ns}.revsDiff`, (_peerId, diff) => runDB(() => db.revsDiff(diff as any) as Promise<unknown>));

    room.register(`${ns}.allDocs`, (_peerId, opts) =>
        runDB(() => db.allDocs((opts ?? {}) as object) as Promise<unknown>)
    );
}
