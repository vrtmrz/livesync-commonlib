import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "./LiveSyncAbstractReplicator.ts";
import {
    REMOTE_ADMINISTRATION_ACTIONS,
    REMOTE_ADMINISTRATION_FAILURE_REASONS,
    REMOTE_ADMINISTRATION_OBSERVATION_KINDS,
    REMOTE_ADMINISTRATION_RESULT_STATUSES,
    applyRemoteAdministrationMutation,
    milestoneSatisfiesRemoteAdministration,
    remoteAdministrationVerified,
} from "./RemoteAdministration.ts";
import { runRemoteAdministrationWithContext } from "@lib/services/base/RemoteAdministrationCoordinator.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    REPLACE_SAME_KIND_REPLICATOR,
    supportedCapability,
    type ReplicatorProviderDefinition,
} from "./ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "./RemoteResource.ts";

function createReplicator() {
    return {
        markRemoteResolved: vi.fn(async () => undefined),
        markRemoteLocked: vi.fn(async () => undefined),
    } as unknown as LiveSyncAbstractReplicator & {
        markRemoteResolved: ReturnType<typeof vi.fn>;
        markRemoteLocked: ReturnType<typeof vi.fn>;
    };
}

describe("remote administration contract", () => {
    it("maps typed actions to the legacy mutation without interpreting interaction authority", async () => {
        const replicator = createReplicator();
        const setting = { remoteType: REMOTE_COUCHDB } as never;

        await applyRemoteAdministrationMutation(replicator, setting, REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED);
        await applyRemoteAdministrationMutation(replicator, setting, REMOTE_ADMINISTRATION_ACTIONS.LOCK);
        await applyRemoteAdministrationMutation(replicator, setting, REMOTE_ADMINISTRATION_ACTIONS.UNLOCK);

        expect(replicator.markRemoteResolved).toHaveBeenCalledWith(setting);
        expect(replicator.markRemoteLocked).toHaveBeenNthCalledWith(1, setting, true, false);
        expect(replicator.markRemoteLocked).toHaveBeenNthCalledWith(2, setting, false, false);
    });

    it("checks the action-specific milestone postcondition", () => {
        const unlockedAndAccepted = {
            kind: REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
            locked: false,
            accepted: true,
            nodeId: "node-1",
        } as const;

        expect(
            milestoneSatisfiesRemoteAdministration(REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED, unlockedAndAccepted)
        ).toBe(true);
        expect(milestoneSatisfiesRemoteAdministration(REMOTE_ADMINISTRATION_ACTIONS.UNLOCK, unlockedAndAccepted)).toBe(
            true
        );
        expect(milestoneSatisfiesRemoteAdministration(REMOTE_ADMINISTRATION_ACTIONS.LOCK, unlockedAndAccepted)).toBe(
            false
        );
    });

    it("returns a typed failure when no active provider context exists", async () => {
        await expect(
            runRemoteAdministrationWithContext(undefined, { remoteType: REMOTE_COUCHDB } as never, {
                action: REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
            })
        ).resolves.toEqual({
            status: REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED,
            reason: REMOTE_ADMINISTRATION_FAILURE_REASONS.NO_ACTIVE_REPLICATOR,
        });
    });

    it("does not convert a provider mutation exception into a compatibility-maskable result", async () => {
        const failure = new Error("mutation failed");
        const replicator = createReplicator();
        const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: () => "test",
            sameKindReconciliation: REPLACE_SAME_KIND_REPLICATOR,
            create: async () => replicator,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            remoteAdministration: supportedCapability(async () => {
                throw failure;
            }),
            userInitiatedOneShot: CAPABILITY_NOT_APPLICABLE,
            unattendedOneShot: CAPABILITY_NOT_APPLICABLE,
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: CAPABILITY_NOT_APPLICABLE,
        };

        await expect(
            runRemoteAdministrationWithContext({ provider, replicator }, { remoteType: REMOTE_COUCHDB } as never, {
                action: REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
            })
        ).rejects.toBe(failure);
    });

    it("keeps machine results independent of display strings", () => {
        const result = remoteAdministrationVerified({
            kind: REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
            locked: false,
            accepted: true,
            nodeId: "node-1",
        });

        expect(result).toEqual({
            status: REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED,
            observation: {
                kind: REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
                locked: false,
                accepted: true,
                nodeId: "node-1",
            },
        });
    });
});
