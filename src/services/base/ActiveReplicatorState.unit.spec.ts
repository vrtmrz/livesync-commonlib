import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { ReplicatorProviderDefinition } from "@lib/replication/ReplicatorProvider.ts";
import { ActiveReplicatorState } from "./ActiveReplicatorState.ts";

function createReplicator(): LiveSyncAbstractReplicator {
    return { closeReplication: vi.fn() } as unknown as LiveSyncAbstractReplicator;
}

const provider = {
    kind: REMOTE_COUCHDB,
    diagnosticName: "CouchDB",
} as ReplicatorProviderDefinition<typeof REMOTE_COUCHDB>;

describe("ActiveReplicatorState", () => {
    it("publishes a typed Replicator and its ownership metadata atomically", () => {
        const state = new ActiveReplicatorState();
        const replicator = createReplicator();

        state.publish(provider, replicator, REMOTE_COUCHDB, "profile-a");

        expect(state.current).toEqual({
            replicator,
            replicatorType: REMOTE_COUCHDB,
            context: { provider, replicator },
            configurationIdentity: "profile-a",
        });
    });

    it("represents a legacy publication without typed provider metadata", () => {
        const state = new ActiveReplicatorState();
        const replicator = createReplicator();

        state.publish(undefined, replicator, REMOTE_COUCHDB, "must-not-leak");

        expect(state.current).toEqual({
            replicator,
            replicatorType: REMOTE_COUCHDB,
            context: undefined,
            configurationIdentity: undefined,
        });
    });

    it("takes the complete publication without mutating an earlier context snapshot", () => {
        const state = new ActiveReplicatorState();
        const replicator = createReplicator();
        state.publish(provider, replicator, REMOTE_COUCHDB, "profile-a");
        const context = state.current?.context;

        expect(state.take()).toBe(replicator);

        expect(state.current).toBeUndefined();
        expect(context).toEqual({ provider, replicator });
    });

    it("discards only the publication which owns the supplied instance", () => {
        const state = new ActiveReplicatorState();
        const active = createReplicator();
        const unrelated = createReplicator();
        state.publish(provider, active, REMOTE_COUCHDB, "profile-a");

        expect(state.discardIfCurrent(unrelated)).toBe(false);
        expect(state.current?.replicator).toBe(active);
        expect(state.discardIfCurrent(active)).toBe(true);
        expect(state.current).toBeUndefined();
    });
});
