import generateReplicationId from "pouchdb-generate-replication-id";
import Checkpointer from "pouchdb-checkpointer";
import { uuid } from "pouchdb-utils";
import type { EntryDoc } from "@lib/common/types.ts";

type Sequence = string | number;
type CheckpointDatabase = PouchDB.Database<EntryDoc> & { id(): Promise<string>; adapter: string };
type CheckpointDocument = PouchDB.Core.ExistingDocument<{
    last_seq: Sequence;
    session_id: string;
}>;

/** Evidence retained only for the currently running, fresh Fast Fetch. */
export interface InitialFetchFastForward {
    recordStoredRevisions(revisions: readonly { id: string; rev: string }[]): void;
    recordCheckpoint(sequence: Sequence): void;
    fastForward(): Promise<boolean>;
}

const MAX_TRACKED_REVISIONS = 100_000;

/**
 * Prepare ordinary checkpoint pairs before a fresh import into an empty database.
 * The importer must remain the sole writer until fastForward settles.
 * The remote database must remain in place throughout the import and handoff:
 * PouchDB's HTTP ID identifies a server and database name, not its incarnation.
 */
export async function prepareInitialFetchFastForward(
    localDatabase: PouchDB.Database<EntryDoc>,
    remoteDatabase: PouchDB.Database<EntryDoc>,
    options: PouchDB.Replication.SyncOptions,
    isCurrent: () => boolean
): Promise<InitialFetchFastForward | undefined> {
    const local = localDatabase as CheckpointDatabase;
    const remote = remoteDatabase as CheckpointDatabase;
    if ((await local.info()).doc_count !== 0 || !isCurrent()) return undefined;
    const localId = await local.id();
    const remoteId = await remote.id();
    const pairs = [
        { source: local, target: remote, options: { ...options, ...options.push } },
        { source: remote, target: local, options: { ...options, ...options.pull } },
    ];
    const checkpoints: Array<{
        id: string; session: string; localRevision: string; remoteRevision: string;
    }> = [];
    for (const pair of pairs) {
        const id = await generateReplicationId(pair.source, pair.target, pair.options);
        // Existing progress belongs to its own replication, even in an empty Vault.
        for (const database of [local, remote]) {
            try {
                await database.get(id);
                return undefined;
            } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
            }
        }
        const session = uuid();
        await new Checkpointer(pair.source, pair.target, id, { cancelled: false }).writeCheckpoint(0, session);
        checkpoints.push({
            id,
            session,
            localRevision: (await local.get(id))._rev,
            remoteRevision: (await remote.get(id))._rev,
        });
    }
    const imported = new Set<string>();
    let withinBudget = true;
    let lastSequence: Sequence | undefined;
    let consumed = false;
    const key = (id: string, rev: string) => JSON.stringify([id, rev]);
    return {
        recordStoredRevisions(revisions) {
            if (!withinBudget) return;
            for (const revision of revisions) {
                imported.add(key(revision.id, revision.rev));
                if (imported.size > MAX_TRACKED_REVISIONS) {
                    imported.clear();
                    withinBudget = false;
                    return;
                }
            }
        },
        recordCheckpoint(sequence) {
            lastSequence = sequence;
        },
        async fastForward() {
            if (consumed) return false;
            consumed = true;
            if (!withinBudget || lastSequence === undefined || !isCurrent()) return false;
            if ((await local.id()) !== localId || (await remote.id()) !== remoteId) return false;
            const localSequence = (await local.info()).update_seq;
            let since: Sequence = 0;
            // Verify provenance locally; a concurrent unsent write must never be skipped.
            while (true) {
                const changes: PouchDB.Core.ChangesResponse<EntryDoc> = await local.changes({
                    since, limit: 1000, style: "all_docs", return_docs: true,
                });
                for (const change of changes.results) {
                    for (const revision of change.changes) {
                        if (!imported.has(key(change.id, revision.rev))) return false;
                    }
                }
                if (changes.results.length < 1000) break;
                since = changes.last_seq;
            }
            if (!isCurrent() || (await local.info()).update_seq !== localSequence) return false;
            const guard = (database: CheckpointDatabase, id: string, expectedRevision: string, session: string) => ({
                adapter: database.adapter,
                async get(requestedId: string) {
                    let document: CheckpointDocument;
                    try {
                        document = (await database.get(requestedId)) as unknown as CheckpointDocument;
                    } catch (cause) {
                        // A lost guard must not be interpreted as a new checkpoint.
                        throw new Error("The initial-fetch checkpoint is no longer available.", { cause });
                    }
                    if (requestedId !== id || document._rev !== expectedRevision || document.session_id !== session) {
                        throw new Error("The initial-fetch checkpoint changed before fast-forwarding.");
                    }
                    return document;
                },
                async put(document: CheckpointDocument) {
                    if (document._id !== id || document._rev !== expectedRevision) {
                        throw new Error("The initial-fetch checkpoint no longer matches its import.");
                    }
                    const response = await (database as unknown as PouchDB.Database<{}>).put(document);
                    expectedRevision = response.rev;
                    return response;
                },
            });
            for (const [index, checkpoint] of checkpoints.entries()) {
                if (!isCurrent() || (await local.info()).update_seq !== localSequence) return false;
                const guardedLocal = guard(local, checkpoint.id, checkpoint.localRevision, checkpoint.session);
                const guardedRemote = guard(remote, checkpoint.id, checkpoint.remoteRevision, checkpoint.session);
                const source = index === 0 ? guardedLocal : guardedRemote;
                const target = index === 0 ? guardedRemote : guardedLocal;
                await new Checkpointer(source, target, checkpoint.id, { cancelled: false }).writeCheckpoint(
                    index === 0 ? localSequence : lastSequence,
                    checkpoint.session
                );
            }
            imported.clear();
            return true;
        },
    };
}
