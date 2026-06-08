import { RpcError } from "../errors";
import type { RpcRoom } from "../RpcRoom";

/**
 * Wraps a PouchDB operation so that PouchDB-specific error properties
 * (`status`, `name`, `reason`) survive the RPC serialisation boundary and
 * can be reconstructed by {@link RpcPouchDBProxy}.
 */
async function runDB<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (err?.status || err?.name) {
            const details: Record<string, string | number> = {};
            if (err.status) details.status = err.status;
            if (err.name) details.name = err.name;
            if (err.reason) details.reason = err.reason;
            throw new RpcError("REMOTE_ERROR", err.message ?? String(err), details);
        }
        throw err;
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
    room.register(`${ns}.info`, () => runDB(() => db.info() as Promise<any>));

    room.register(`${ns}.id`, () => runDB(() => (db as any).id() as unknown as Promise<string> as Promise<any>));

    // The changes feed is always served as a one-shot snapshot.  Live feeds
    // would require a push channel and are not supported over RPC.
    room.register(`${ns}.changes`, (_peerId, opts) =>
        runDB(
            () =>
                new Promise<any>((resolve, reject) => {
                    const feed = db.changes({ ...(opts as any), live: false });
                    void feed.on("complete", resolve);
                    void feed.on("error", reject);
                })
        )
    );

    room.register(`${ns}.get`, (_peerId, id, opts) =>
        runDB(() => db.get<unknown>(id as string, (opts ?? {}) as any) as Promise<any>)
    );

    room.register(`${ns}.put`, (_peerId, doc, opts) =>
        runDB(() => db.put(doc as any, (opts ?? {}) as any) as Promise<any>)
    );

    room.register(`${ns}.bulkGet`, (_peerId, opts) => runDB(() => db.bulkGet(opts as any) as Promise<any>));

    // `req` may be either a document array or `{docs, new_edits}` object —
    // both forms are accepted by PouchDB's public `bulkDocs` method.
    room.register(`${ns}.bulkDocs`, (_peerId, req, opts) =>
        runDB(() => db.bulkDocs(req as any, (opts ?? {}) as any) as Promise<any>)
    );

    room.register(`${ns}.revsDiff`, (_peerId, diff) => runDB(() => db.revsDiff(diff as any) as Promise<any>));

    room.register(`${ns}.allDocs`, (_peerId, opts) => runDB(() => db.allDocs((opts ?? {}) as any) as Promise<any>));
}
