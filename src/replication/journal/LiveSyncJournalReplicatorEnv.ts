import type { LiveSyncReplicatorEnv } from "@lib/replication/LiveSyncAbstractReplicator";

/**
 * Compatibility name for the Journal Replicator constructor environment.
 *
 * Journal currently adds no requirements to {@link LiveSyncReplicatorEnv}.
 * The distinct exported interface preserves the existing constructor contract
 * and an extension point; shared host composition should depend on the base
 * environment unless it specifically constructs a Journal Replicator.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Retain the public compatibility name and extension point.
export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
}
