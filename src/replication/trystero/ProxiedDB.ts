import { type ReplicatorHostEnv } from "./types";

export function createHostingDB(env: ReplicatorHostEnv) {
    let db = env.db;
    const hostingDB = {
        info: () => db.info(),
        changes: (options: PouchDB.Core.ChangesOptions) => db.changes(options),
        revsDiff: (diff: PouchDB.Core.RevisionDiffOptions) => db.revsDiff(diff),
        bulkDocs: (docs: PouchDB.Core.PostDocument<any>[], options?: PouchDB.Core.BulkDocsOptions) =>
            db.bulkDocs(docs, options),
        bulkGet: (options: PouchDB.Core.BulkGetOptions) => db.bulkGet(options),
        put: (doc: PouchDB.Core.PutDocument<any>, options?: PouchDB.Core.PutOptions) => db.put(doc, options),
        get: (id: string, options?: PouchDB.Core.GetOptions) => db.get(id, options),
        _stopHosting: () => {
            // To make sure that the hosting DB is not used anymore
            db = undefined as any;
        },
    };
    return hostingDB;
}
export type HostingDB = ReturnType<typeof createHostingDB>;
