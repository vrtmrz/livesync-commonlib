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
    } catch (err: unknown) {
        if (err && typeof err === "object" && ("status" in err || "name" in err)) {
            const details: Record<string, string | number> = {};
            const e = err as { status?: number; name?: string; reason?: string; message?: string };
            if (e.status) details.status = e.status;
            if (e.name) details.name = e.name;
            if (e.reason) details.reason = e.reason;
            // eslint-disable-next-line @typescript-eslint/no-base-to-string
            throw new RpcError("REMOTE_ERROR", e.message ?? String(err), details);
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
    room.register(`${ns}.info`, () => runDB(() => db.info() as Promise<unknown>));

    room.register(`${ns}.id`, () =>
        runDB(() => (db as unknown as { id: () => Promise<string> }).id() as Promise<unknown>)
    );

    // The changes feed is always served as a one-shot snapshot.  Live feeds
    // would require a push channel and are not supported over RPC.
    room.register(`${ns}.changes`, (_peerId, opts) =>
        runDB(
            () =>
                new Promise<unknown>((resolve, reject) => {
                    const feed = db.changes({ ...(opts as unknown as PouchDB.Core.ChangesOptions), live: false });
                    void feed.on("complete", resolve);
                    void feed.on("error", reject);
                })
        )
    );

    room.register(`${ns}.get`, (_peerId, id, opts) =>
        runDB(
            () => db.get<unknown>(id as string, (opts ?? {}) as unknown as PouchDB.Core.GetOptions) as Promise<unknown>
        )
    );

    room.register(`${ns}.put`, (_peerId, doc, opts) =>
        runDB(
            () =>
                db.put(
                    doc as unknown as PouchDB.Core.PutDocument<object>,
                    (opts ?? {}) as unknown as PouchDB.Core.PutOptions
                ) as Promise<unknown>
        )
    );

    room.register(`${ns}.bulkGet`, (_peerId, opts) =>
        runDB(() => db.bulkGet(opts as unknown as PouchDB.Core.BulkGetOptions) as Promise<unknown>)
    );

    // `req` may be either a document array or `{docs, new_edits}` object —
    // both forms are accepted by PouchDB's public `bulkDocs` method.
    room.register(`${ns}.bulkDocs`, (_peerId, req, opts) =>
        runDB(
            () =>
                db.bulkDocs(
                    req as unknown as PouchDB.Core.PostDocument<object>[],
                    (opts ?? {}) as unknown as PouchDB.Core.BulkDocsOptions
                ) as Promise<unknown>
        )
    );

    room.register(`${ns}.revsDiff`, (_peerId, diff) =>
        runDB(() => db.revsDiff(diff as unknown as PouchDB.Core.RevisionDiffOptions) as Promise<unknown>)
    );

    room.register(`${ns}.allDocs`, (_peerId, opts) =>
        runDB(() => db.allDocs((opts ?? {}) as unknown as PouchDB.Core.AllDocsOptions) as Promise<unknown>)
    );
}
