import { describe, expect, it, vi } from "vitest";
import { ReplicationService, type ReplicationServiceDependencies } from "./ReplicationService.ts";
import { ServiceContext } from "./ServiceBase.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    NO_INTERACTION,
    REPLICATION_COMPLETED,
    USER_INITIATED_REPLICATION_AUTHORITY,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    type ActiveReplicatorContext,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import { REMOTE_COUCHDB } from "@lib/common/types.ts";

class TestReplicationService extends ReplicationService<ServiceContext> {}

function createTypedDependencies(result: boolean | void = true) {
    const openReplication = vi.fn().mockResolvedValue(result);
    const replicator = { openReplication };
    const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
        kind: REMOTE_COUCHDB,
        diagnosticName: "CouchDB",
        isConfigured: () => true,
        create: async () => replicator as never,
        userInitiatedOneShot: supportedOpenReplicationOneShot(),
        unattendedOneShot: supportedOpenReplicationUnattended(),
        continuous: supportedOpenReplicationContinuous(),
    };
    const activeContext: ActiveReplicatorContext = {
        provider,
        replicator: replicator as never,
    };
    const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), {
        addHandler: vi.fn(),
    });
    const getActiveReplicatorContext = vi.fn(() => activeContext);
    const dependencies = {
        APIService: { isOnline: true, addLog: vi.fn() },
        appLifecycleService: {
            isReady: () => true,
            getUnresolvedMessages,
        },
        databaseService: {},
        fileProcessingService: {
            commitPendingFileEvents: vi.fn().mockResolvedValue(true),
        },
        replicatorService: {
            getActiveReplicatorContext,
            getActiveReplicator: vi.fn(() => replicator),
            runFiniteReplicationActivity: vi.fn(async (task: () => unknown) => await task()),
        },
        settingService: {
            currentSettings: vi.fn(() => ({ versionUpFlash: "", syncMinimumInterval: 0 })),
        },
    } as unknown as ReplicationServiceDependencies;
    return { activeContext, dependencies, getActiveReplicatorContext, openReplication, replicator };
}

describe("ReplicationService typed provider roles", () => {
    it("dispatches unattended one-shot work without interaction authority", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "completed",
        });
        expect(openReplication).toHaveBeenCalledWith(expect.anything(), false, false, false);
    });

    it("propagates unattended failures with forbidden interaction", async () => {
        const { dependencies } = createTypedDependencies(false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const failure = vi.fn().mockResolvedValue(false);
        service.onReplicationFailed.addHandler(failure);

        await expect(
            service.replicateUnattended({ trigger: "daemon", interaction: NO_INTERACTION })
        ).resolves.toMatchObject({ status: "failed" });
        expect(failure).toHaveBeenCalledWith(false, NO_INTERACTION);
    });

    it("honours a narrowed user authority in the provider adapter", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const interaction = {
            kind: "permitted" as const,
            permissions: { ...USER_INITIATED_REPLICATION_AUTHORITY.permissions, failureRecovery: false },
        };

        await expect(service.replicateUserInitiated({ trigger: "manual", interaction })).resolves.toEqual({
            status: "completed",
        });
        expect(openReplication).toHaveBeenCalledWith(expect.anything(), false, false, false);
    });

    it("allows a manual request to veto interaction without blocking the replication", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(
            service.replicateUserInitiated({ trigger: "manual", interaction: NO_INTERACTION })
        ).resolves.toEqual({ status: "completed" });
        expect(openReplication).toHaveBeenCalledWith(expect.anything(), false, false, false);
    });

    it("keeps the provider and replicator from one context snapshot", async () => {
        const { activeContext, dependencies } = createTypedDependencies(true);
        const firstRun = vi.fn(async () => REPLICATION_COMPLETED);
        const secondRun = vi.fn(async () => REPLICATION_COMPLETED);
        const firstContext: ActiveReplicatorContext = {
            ...activeContext,
            provider: {
                ...activeContext.provider,
                unattendedOneShot: { kind: "supported", run: firstRun },
            },
        };
        const secondContext: ActiveReplicatorContext = {
            ...activeContext,
            provider: {
                ...activeContext.provider,
                unattendedOneShot: { kind: "supported", run: secondRun },
            },
        };
        const getContext = vi
            .fn<() => ActiveReplicatorContext | undefined>()
            .mockReturnValueOnce(firstContext)
            .mockReturnValueOnce(secondContext);
        (
            dependencies.replicatorService as unknown as {
                getActiveReplicatorContext: typeof getContext;
            }
        ).getActiveReplicatorContext = getContext;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toBe(
            REPLICATION_COMPLETED
        );

        expect(getContext).toHaveBeenCalledOnce();
        expect(firstRun).toHaveBeenCalledWith(
            firstContext.replicator,
            expect.anything(),
            expect.objectContaining({ trigger: "resume", interaction: NO_INTERACTION })
        );
        expect(secondRun).not.toHaveBeenCalled();
    });

    it("returns an explicit blocked result when no active replicator exists", async () => {
        const { dependencies } = createTypedDependencies(true);
        (
            dependencies.replicatorService as unknown as { getActiveReplicatorContext: () => undefined }
        ).getActiveReplicatorContext = () => undefined;
        (dependencies.replicatorService as unknown as { getActiveReplicator: () => undefined }).getActiveReplicator =
            () => undefined;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "no-active-replicator",
        });
    });

    it("does not invoke a not-applicable continuous role", async () => {
        const { activeContext, dependencies } = createTypedDependencies(true);
        activeContext.provider.continuous = CAPABILITY_NOT_APPLICABLE;
        (dependencies.appLifecycleService as unknown as { isReady: () => boolean }).isReady = () => false;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "capability-not-applicable",
        });
    });

    it("treats a continuous void result as an accepted start", async () => {
        const { dependencies, getActiveReplicatorContext } = createTypedDependencies(undefined);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.startContinuous({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "completed",
        });
        expect(getActiveReplicatorContext).toHaveBeenCalledOnce();
    });
});

describe("ReplicationService activity boundary", () => {
    const createDependencies = () => {
        const openReplication = vi.fn().mockResolvedValue(true);
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), {
            addHandler: vi.fn(),
        });
        const dependencies = {
            APIService: { isOnline: true, addLog: vi.fn() },
            appLifecycleService: {
                isReady: () => true,
                getUnresolvedMessages,
            },
            databaseService: {},
            fileProcessingService: {
                commitPendingFileEvents: vi.fn().mockResolvedValue(true),
            },
            replicatorService: {
                getActiveReplicator: () => ({ openReplication }),
                runFiniteReplicationActivity,
            },
            settingService: {
                currentSettings: () => ({ versionUpFlash: "" }),
            },
        } as unknown as ReplicationServiceDependencies;

        return { dependencies, openReplication, runFiniteReplicationActivity };
    };

    it("runs a ready one-shot replication through the bounded remote activity boundary", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicate(true)).resolves.toBe(true);

        expect(runFiniteReplicationActivity).toHaveBeenCalledOnce();
        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(openReplication).toHaveBeenCalledOnce();
    });

    it("does not start an activity while replication readiness checks fail", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createDependencies();
        Object.assign(dependencies.APIService, { isOnline: false });
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicate(true)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(openReplication).not.toHaveBeenCalled();
    });

    it("honours reusable replication policy checks before starting standard replication", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const policyCheck = vi.fn(async () => false);
        service.onCheckReplicationReady.addHandler(policyCheck);

        await expect(service.replicate(true)).resolves.toBe(false);

        expect(policyCheck).toHaveBeenCalledWith(true);
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(openReplication).not.toHaveBeenCalled();
    });

    it("ends the bounded activity before handling a failed replication", async () => {
        const { dependencies, openReplication } = createDependencies();
        const calls: string[] = [];
        openReplication.mockResolvedValue(false);
        (dependencies.replicatorService as any).runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => {
            calls.push("activity-started");
            try {
                return await task();
            } finally {
                calls.push("activity-ended");
            }
        });
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        service.onReplicationFailed.addHandler(async () => {
            calls.push("failure-handled");
            return false;
        });

        await expect(service.replicate(true)).resolves.toBe(false);

        expect(calls).toEqual(["activity-started", "activity-ended", "failure-handled"]);
    });

    it("preserves failure handling for direct performReplication callers", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createDependencies();
        openReplication.mockResolvedValue(false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const handleFailure = vi.fn(async () => false);
        service.onReplicationFailed.addHandler(handleFailure);

        await expect(service.performReplication(true)).resolves.toBe(false);

        expect(handleFailure).toHaveBeenCalledWith(true, USER_INITIATED_REPLICATION_AUTHORITY);
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
    });
});

describe("ReplicationService full upload", () => {
    it("uses standard replication without offering the obsolete bulk chunk pre-send", async () => {
        const askYesNoDialog = vi.fn().mockResolvedValue("yes");
        const sendChunks = vi.fn().mockResolvedValue(true);
        const replicateAllToServer = vi.fn().mockResolvedValue(true);
        const dependencies = {
            APIService: {
                addLog: vi.fn(),
                confirm: { askYesNoDialog },
            },
            appLifecycleService: {
                isReady: () => true,
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), {
                    addHandler: vi.fn(),
                }),
            },
            databaseService: {},
            fileProcessingService: {},
            replicatorService: {
                getActiveReplicator: () => ({
                    isChunkSendingSupported: true,
                    sendChunks,
                    replicateAllToServer,
                }),
            },
            settingService: {
                currentSettings: () => ({}),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateAllToRemote(true)).resolves.toBe(true);

        expect(askYesNoDialog).not.toHaveBeenCalled();
        expect(sendChunks).not.toHaveBeenCalled();
        expect(replicateAllToServer).toHaveBeenCalledOnce();
    });
});

describe("ReplicationService rebuild maintenance", () => {
    function createMaintenanceService({ applicationReady = false, databaseReady = true } = {}) {
        const replicateAllToServer = vi.fn(async () => true);
        const replicateAllFromServer = vi.fn(async () => true);
        const dependencies = {
            APIService: { addLog: vi.fn() },
            appLifecycleService: {
                isReady: vi.fn(() => applicationReady),
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), {
                    addHandler: vi.fn(),
                }),
            },
            databaseService: {
                isDatabaseReady: vi.fn(() => databaseReady),
            },
            fileProcessingService: {},
            replicatorService: {
                getActiveReplicator: vi.fn(() => ({ replicateAllToServer, replicateAllFromServer })),
            },
            settingService: {
                currentSettings: vi.fn(() => ({})),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        return { replicateAllFromServer, replicateAllToServer, service };
    }

    it("keeps ordinary full replication behind application readiness", async () => {
        const { replicateAllFromServer, replicateAllToServer, service } = createMaintenanceService();

        await expect(service.replicateAllFromRemote()).resolves.toBe(false);
        await expect(service.replicateAllToRemote()).resolves.toBe(false);

        expect(replicateAllFromServer).not.toHaveBeenCalled();
        expect(replicateAllToServer).not.toHaveBeenCalled();
    });

    it("allows explicit rebuild transfers when only the selected physical database is ready", async () => {
        const { replicateAllFromServer, replicateAllToServer, service } = createMaintenanceService();

        await expect(service.replicateAllFromRemoteForRebuild()).resolves.toBe(true);
        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(true);

        expect(replicateAllFromServer).toHaveBeenCalledOnce();
        expect(replicateAllToServer).toHaveBeenCalledOnce();
    });

    it("rejects rebuild transfers when the selected physical database is not ready", async () => {
        const { replicateAllFromServer, replicateAllToServer, service } = createMaintenanceService({
            databaseReady: false,
        });

        await expect(service.replicateAllFromRemoteForRebuild()).resolves.toBe(false);
        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(false);

        expect(replicateAllFromServer).not.toHaveBeenCalled();
        expect(replicateAllToServer).not.toHaveBeenCalled();
    });
});
