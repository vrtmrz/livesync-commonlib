import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance.ts";
import type { ReplicatorProviderDefinition } from "@lib/replication/ReplicatorProvider.ts";
import { ActiveReplicatorState } from "./ActiveReplicatorState.ts";

function createReplicator(): ReplicatorInstance {
    return {
        initializeDatabaseForReplication: vi.fn().mockResolvedValue(true),
        openReplication: vi.fn().mockResolvedValue(true),
        terminateSync: vi.fn(),
        closeReplication: vi.fn(),
    };
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

    it("fences new reservations and drains an admitted reservation before retirement completes", async () => {
        const state = new ActiveReplicatorState();
        const replicator = createReplicator();
        state.publish(provider, replicator, REMOTE_COUCHDB, "profile-a");
        const context = state.current?.context;
        const reservation = state.reserve();

        const retirement = state.beginRetirement();

        expect(state.current).toBeUndefined();
        expect(context).toEqual({ provider, replicator });
        expect(reservation?.context).toBe(context);
        expect(state.reserve()).toBeUndefined();
        expect(retirement?.publication.replicator).toBe(replicator);

        let settlementObserved = false;
        const settlement = retirement?.waitForDemandSettlement().then(() => {
            settlementObserved = true;
        });
        await Promise.resolve();
        expect(settlementObserved).toBe(false);

        reservation?.release();
        reservation?.release();
        await settlement;
        expect(settlementObserved).toBe(true);

        retirement?.complete();
        retirement?.complete();
    });

    it("does not publish a replacement before the quiescing retirement completes", async () => {
        const state = new ActiveReplicatorState();
        const oldReplicator = createReplicator();
        const newReplicator = createReplicator();
        state.publish(provider, oldReplicator, REMOTE_COUCHDB, "profile-a");

        const retirement = state.beginRetirement();

        expect(() => state.publish(provider, newReplicator, REMOTE_COUCHDB, "profile-b")).toThrow(
            "retirement has completed"
        );
        expect(state.beginRetirement()).toBe(retirement);

        await retirement?.waitForDemandSettlement();
        retirement?.complete();
        state.publish(provider, newReplicator, REMOTE_COUCHDB, "profile-b");

        expect(state.current?.replicator).toBe(newReplicator);
    });
});
