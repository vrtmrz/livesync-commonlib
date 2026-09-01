import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";
import {
    CENTRAL_REMOTE_ADMINISTRATION_ACTIONS,
    CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS,
    CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS,
    CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES,
    applyCentralRemoteAdministrationMutation,
    milestoneSatisfiesCentralRemoteAdministration,
    centralRemoteAdministrationVerified,
} from "./CentralRemoteAdministration.ts";
import { runCentralRemoteAdministrationWithContext } from "@lib/services/base/ReplicatorService.centralRemoteAdministration.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    supportedCapability,
    supportedStopActiveTransfer,
    type ReplicatorProviderDefinition,
} from "./ReplicatorProvider.ts";
import type { CentralRemoteAdministrationReplicator } from "./CentralRemoteAdministration.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "./RemoteResource.ts";

function createReplicator() {
    return {
        nodeid: "node-1",
        terminateSync: vi.fn(),
        markRemoteResolved: vi.fn(async () => undefined),
        markRemoteLocked: vi.fn(async () => undefined),
    } as unknown as CentralRemoteAdministrationReplicator & {
        markRemoteResolved: ReturnType<typeof vi.fn>;
        markRemoteLocked: ReturnType<typeof vi.fn>;
    };
}

describe("remote administration contract", () => {
    it("maps typed actions to the legacy mutation without interpreting interaction authority", async () => {
        const replicator = createReplicator();
        const setting = { remoteType: REMOTE_COUCHDB } as never;

        await applyCentralRemoteAdministrationMutation(
            replicator,
            setting,
            CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED
        );
        await applyCentralRemoteAdministrationMutation(replicator, setting, CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK);
        await applyCentralRemoteAdministrationMutation(
            replicator,
            setting,
            CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.UNLOCK
        );

        expect(replicator.markRemoteResolved).toHaveBeenCalledWith(setting);
        expect(replicator.markRemoteLocked).toHaveBeenNthCalledWith(1, setting, true, false);
        expect(replicator.markRemoteLocked).toHaveBeenNthCalledWith(2, setting, false, false);
    });

    it("checks the action-specific milestone postcondition", () => {
        const unlockedAndAccepted = {
            kind: CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
            locked: false,
            accepted: true,
            nodeId: "node-1",
        } as const;

        expect(
            milestoneSatisfiesCentralRemoteAdministration(
                CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
                unlockedAndAccepted
            )
        ).toBe(true);
        expect(
            milestoneSatisfiesCentralRemoteAdministration(
                CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.UNLOCK,
                unlockedAndAccepted
            )
        ).toBe(true);
        expect(
            milestoneSatisfiesCentralRemoteAdministration(
                CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK,
                unlockedAndAccepted
            )
        ).toBe(false);
    });

    it("returns a typed failure when no active provider context exists", async () => {
        await expect(
            runCentralRemoteAdministrationWithContext(undefined, { remoteType: REMOTE_COUCHDB } as never, {
                action: CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
            })
        ).resolves.toEqual({
            status: CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED,
            reason: CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS.NO_ACTIVE_REPLICATOR,
        });
    });

    it("stops the captured publication's active transfer before central administration", async () => {
        const events: string[] = [];
        let settleStop!: () => void;
        const stopGate = new Promise<void>((resolve) => {
            settleStop = resolve;
        });
        const replicator = Object.assign(createReplicator(), {
            terminateSync: vi.fn(async () => {
                events.push("active-transfer-stop-requested");
                await stopGate;
                events.push("active-transfer-stopped");
            }),
        });
        const administration = vi.fn(async () => {
            events.push("administration-started");
            return centralRemoteAdministrationVerified({
                kind: CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
                locked: true,
                accepted: true,
                nodeId: "node-1",
            });
        });
        const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
            kind: REMOTE_COUCHDB,
            diagnosticName: "CouchDB",
            readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: () => "test",
            create: async () => replicator,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            centralRemoteAdministration: supportedCapability(administration),
            userInitiatedOneShot: CAPABILITY_NOT_APPLICABLE,
            unattendedOneShot: CAPABILITY_NOT_APPLICABLE,
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };

        const operation = runCentralRemoteAdministrationWithContext(
            { provider, replicator, configurationIdentity: "test" },
            { remoteType: REMOTE_COUCHDB } as never,
            { action: CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK }
        );

        try {
            await vi.waitFor(() => expect(replicator.terminateSync).toHaveBeenCalledOnce());
            expect(administration).not.toHaveBeenCalled();

            settleStop();
            await expect(operation).resolves.toMatchObject({
                status: CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED,
            });
            expect(events).toEqual([
                "active-transfer-stop-requested",
                "active-transfer-stopped",
                "administration-started",
            ]);
        } finally {
            settleStop();
            await Promise.allSettled([operation]);
        }
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
            create: async () => replicator,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            centralRemoteAdministration: supportedCapability(async () => {
                throw failure;
            }),
            userInitiatedOneShot: CAPABILITY_NOT_APPLICABLE,
            unattendedOneShot: CAPABILITY_NOT_APPLICABLE,
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: supportedStopActiveTransfer(),
        };

        await expect(
            runCentralRemoteAdministrationWithContext(
                { provider, replicator, configurationIdentity: "test" },
                { remoteType: REMOTE_COUCHDB } as never,
                {
                    action: CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED,
                }
            )
        ).rejects.toBe(failure);
    });

    it("keeps machine results independent of display strings", () => {
        const result = centralRemoteAdministrationVerified({
            kind: CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
            locked: false,
            accepted: true,
            nodeId: "node-1",
        });

        expect(result).toEqual({
            status: CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED,
            observation: {
                kind: CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE,
                locked: false,
                accepted: true,
                nodeId: "node-1",
            },
        });
    });
});
