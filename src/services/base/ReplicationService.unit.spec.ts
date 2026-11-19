import { UnsupportedEncryptedDocumentFormatError } from "@lib/replication/UnsupportedEncryptedDocumentFormatError.ts";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import { ReplicationService, type ReplicationServiceDependencies } from "./ReplicationService.ts";
import { bailFirstFailureFunction } from "@lib/services/lib/HandlerUtils.ts";
import { ServiceContext } from "./ServiceBase.ts";
import { RemoteService, type RemoteServiceDependencies } from "./RemoteService.ts";
import { LiveSyncCouchDBReplicator } from "@lib/replication/couchdb/LiveSyncReplicator.ts";
import {
    captureRemoteTransportFailure,
    getReplicationNetworkFailure,
} from "@lib/replication/remoteTransportFailure.ts";
import {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_SUPPORT_KINDS,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    observedOfflineReplicationFailure,
    NO_INTERACTION,
    PEER_REPLICATION_READINESS,
    REPLICATION_COMPLETED,
    REPLICATION_PROGRESS_PRESENTATIONS,
    USER_INITIATED_REPLICATION_AUTHORITY,
    supportedCapability,
    supportedOpenReplicationContinuous,
    supportedOpenReplicationOneShot,
    supportedOpenReplicationUnattended,
    supportedStopActiveTransfer,
    type ActiveReplicatorContext,
    type ReplicatorProviderDefinition,
} from "@lib/replication/ReplicatorProvider.ts";
import { NO_REMOTE_RESOURCE_CAPABILITIES } from "@lib/replication/RemoteResource.ts";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P, type RemoteDBSettings, type RemoteType } from "@lib/common/types.ts";

class TestReplicationService extends ReplicationService<ServiceContext> {}

const testConfigurationIdentity = (setting: { activeConfigurationId?: string; remoteType: string }) =>
    setting.activeConfigurationId || setting.remoteType;

function createDirectionalReplicationContext(replicator: {
    replicateAllToServer: (setting: RemoteDBSettings, showingNotice?: boolean) => Promise<boolean>;
    replicateAllFromServer: (setting: RemoteDBSettings, showingNotice?: boolean) => Promise<boolean>;
}): ActiveReplicatorContext {
    const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
        kind: REMOTE_COUCHDB,
        diagnosticName: "CouchDB",
        readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
        isConfigured: () => true,
        configurationIdentity: () => "test",
        create: async () => replicator as never,
        remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
        userInitiatedOneShot: CAPABILITY_NOT_APPLICABLE,
        unattendedOneShot: CAPABILITY_NOT_APPLICABLE,
        continuous: CAPABILITY_NOT_APPLICABLE,
        stopActiveTransfer: supportedCapability(async () => REPLICATION_COMPLETED),
    };
    return { provider, replicator: replicator as never, configurationIdentity: "test" };
}

function createTypedDependencies(result: boolean | void = true) {
    const openReplication = vi.fn().mockResolvedValue(result);
    const terminateSync = vi.fn();
    const markRemoteLocked = vi.fn(async () => undefined);
    const markRemoteResolved = vi.fn(async () => undefined);
    const replicator = { markRemoteLocked, markRemoteResolved, openReplication, terminateSync };
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const provider: ReplicatorProviderDefinition<typeof REMOTE_COUCHDB> = {
        kind: REMOTE_COUCHDB,
        diagnosticName: "CouchDB",
        readiness: CENTRAL_REMOTE_REPLICATION_READINESS,
        isConfigured: () => true,
        configurationIdentity: testConfigurationIdentity,
        create: async () => replicator as never,
        remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
        userInitiatedOneShot: supportedOpenReplicationOneShot(),
        unattendedOneShot: supportedOpenReplicationUnattended(),
        continuous: supportedOpenReplicationContinuous(),
        stopActiveTransfer: supportedStopActiveTransfer(),
    };
    const activeContext: ActiveReplicatorContext = {
        provider,
        replicator: replicator as never,
        configurationIdentity: REMOTE_COUCHDB,
    };
    const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), {
        addHandler: vi.fn(),
    });
    const acquireActiveReplicatorContext = vi.fn(async () => activeContext);
    const getActiveReplicator = vi.fn(() => replicator);
    const runWithActiveReplicatorContext = vi.fn(
        async (task: (context: ActiveReplicatorContext) => unknown) => await task(activeContext)
    );
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
            acquireActiveReplicatorContext,
            getActiveReplicator,
            hasActiveReplicator: vi.fn(() => getActiveReplicator() !== undefined),
            runWithActiveReplicatorContext,
            runFiniteReplicationActivity,
        },
        settingService: {
            currentSettings: vi.fn(() => ({
                remoteType: REMOTE_COUCHDB,
                versionUpFlash: "",
                syncMinimumInterval: 0,
            })),
        },
    } as unknown as ReplicationServiceDependencies;
    return {
        activeContext,
        dependencies,
        getActiveReplicator,
        acquireActiveReplicatorContext,
        openReplication,
        markRemoteLocked,
        markRemoteResolved,
        replicator,
        runWithActiveReplicatorContext,
        runFiniteReplicationActivity,
        terminateSync,
    };
}

function createReadinessDependencies(kind: RemoteType, typed = true) {
    const events: string[] = [];
    const openReplication = vi.fn(async () => {
        events.push("open");
        return true;
    });
    const replicator = { openReplication };
    const activeContext: ActiveReplicatorContext = {
        provider: {
            kind,
            diagnosticName: kind || "CouchDB",
            readiness: kind === REMOTE_P2P ? PEER_REPLICATION_READINESS : CENTRAL_REMOTE_REPLICATION_READINESS,
            isConfigured: () => true,
            configurationIdentity: testConfigurationIdentity,
            create: async () => replicator as never,
            remoteResources: NO_REMOTE_RESOURCE_CAPABILITIES,
            userInitiatedOneShot: supportedOpenReplicationOneShot(),
            unattendedOneShot: supportedOpenReplicationUnattended(),
            continuous: CAPABILITY_NOT_APPLICABLE,
            stopActiveTransfer: CAPABILITY_NOT_APPLICABLE,
        },
        replicator: replicator as never,
        configurationIdentity: kind,
    };
    const appReady = vi.fn(() => {
        events.push("app-ready");
        return true;
    });
    const commitPendingFileEvents = vi.fn(async () => {
        events.push("pending-file-events");
        return true;
    });
    const settings = { remoteType: kind, versionUpFlash: "", syncMinimumInterval: 0 };
    const getUnresolvedMessages = Object.assign(vi.fn().mockResolvedValue([]), {
        addHandler: vi.fn(),
    });
    const dependencies = {
        APIService: { isOnline: true, addLog: vi.fn() },
        appLifecycleService: { isReady: appReady, getUnresolvedMessages },
        databaseService: {},
        fileProcessingService: { commitPendingFileEvents },
        replicatorService: {
            acquireActiveReplicatorContext: vi.fn(async () => (typed ? activeContext : undefined)),
            getActiveReplicator: vi.fn(() => replicator),
            runWithActiveReplicatorContext: vi.fn(
                async (task: (context: ActiveReplicatorContext) => unknown) => await task(activeContext)
            ),
            runFiniteReplicationActivity: vi.fn(async (task: () => unknown) => await task()),
        },
        settingService: { currentSettings: vi.fn(() => settings) },
    } as unknown as ReplicationServiceDependencies;
    return { activeContext, appReady, dependencies, events, openReplication, settings };
}

describe("ReplicationService typed provider roles", () => {
    it("invokes finite-completion and content-read failure observers", async () => {
        const { dependencies } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const onFiniteReplicationCompleted = vi.fn().mockResolvedValue(true);
        const onFileReflectionFailed = vi.fn().mockResolvedValue(true);
        service.onFiniteReplicationCompleted.addHandler(onFiniteReplicationCompleted);
        service.onFileReflectionFailed.addHandler(onFileReflectionFailed);
        const failure = {
            documentId: "file.md" as never,
            revision: "4-revision",
            resources: ["remote"],
            cause: new Error("request failed"),
        };

        await expect(service.onFiniteReplicationCompleted()).resolves.toBe(true);
        await expect(
            service.onFileReflectionFailed({ documentId: failure.documentId, revision: failure.revision! }, failure)
        ).resolves.toBe(true);

        expect(onFiniteReplicationCompleted).toHaveBeenCalledOnce();
        expect(onFileReflectionFailed).toHaveBeenCalledWith(
            { documentId: failure.documentId, revision: failure.revision },
            failure
        );
    });

    it("dispatches unattended one-shot work without interaction authority", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "completed",
        });
        expect(openReplication).toHaveBeenCalledWith(expect.anything(), false, false, false);
    });

    it("propagates unattended failures with forbidden interaction", async () => {
        const { activeContext, dependencies } = createTypedDependencies(false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const failure = vi.fn().mockResolvedValue(false);
        service.onReplicationFailed.addHandler(failure);

        await expect(
            service.replicateUnattended({ trigger: "daemon", interaction: NO_INTERACTION })
        ).resolves.toMatchObject({ status: "failed" });
        expect(failure).toHaveBeenCalledWith({
            context: activeContext,
            setting: expect.objectContaining({ versionUpFlash: "" }),
            outcome: expect.objectContaining({ status: "failed" }),
            progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
            interaction: NO_INTERACTION,
        });
    });

    it("honours a narrowed user authority in the provider adapter", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const interaction = {
            kind: "permitted" as const,
            permissions: { ...USER_INITIATED_REPLICATION_AUTHORITY.permissions, failureRecovery: false },
        };

        await expect(
            service.replicateUserInitiated({
                trigger: "manual",
                progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
                interaction,
            })
        ).resolves.toEqual({ status: "completed" });
        expect(openReplication).toHaveBeenCalledWith(expect.anything(), false, false, false);
    });

    it("allows a manual request to veto interaction without blocking the replication", async () => {
        const { dependencies, openReplication } = createTypedDependencies(true);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(
            service.replicateUserInitiated({
                trigger: "manual",
                progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.QUIET,
                interaction: NO_INTERACTION,
            })
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
                unattendedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: firstRun },
            },
        };
        const secondContext: ActiveReplicatorContext = {
            ...activeContext,
            provider: {
                ...activeContext.provider,
                unattendedOneShot: { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run: secondRun },
            },
        };
        const getContext = vi
            .fn<() => Promise<ActiveReplicatorContext | undefined>>()
            .mockResolvedValueOnce(firstContext)
            .mockResolvedValueOnce(secondContext);
        (
            dependencies.replicatorService as unknown as {
                acquireActiveReplicatorContext: typeof getContext;
            }
        ).acquireActiveReplicatorContext = getContext;
        (
            dependencies.replicatorService as unknown as {
                runWithActiveReplicatorContext: (
                    task: (context: ActiveReplicatorContext) => unknown
                ) => Promise<unknown>;
            }
        ).runWithActiveReplicatorContext = async (task) => await task(firstContext);
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
        const { dependencies, getActiveReplicator } = createTypedDependencies(true);
        (
            dependencies.replicatorService as unknown as {
                acquireActiveReplicatorContext: () => Promise<undefined>;
            }
        ).acquireActiveReplicatorContext = async () => undefined;
        getActiveReplicator.mockReturnValue(undefined);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "no-active-replicator",
        });
    });

    it("keeps ordinary readiness gates for typed P2P unattended work without preparing a central-remote Security Seed", async () => {
        const { appReady, dependencies, events, openReplication } = createReadinessDependencies(REMOTE_P2P);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const lightweightCheck = vi.fn(async () => {
            events.push("lightweight-check");
            return true;
        });
        const ensureSecuritySeed = vi.fn();
        const prepareSecuritySeed = vi.fn(async () => {
            events.push("central-remote-security-seed");
            ensureSecuritySeed();
            return true;
        });
        const generalBeforeReplicate = vi.fn(async () => {
            events.push("general-before-replicate");
            return true;
        });
        service.onCheckReplicationReady.addHandler(lightweightCheck);
        service.onPrepareCentralRemoteReplication.addHandler(prepareSecuritySeed);
        service.onBeforeReplicate.addHandler(generalBeforeReplicate);

        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "completed",
        });

        expect(appReady).toHaveBeenCalledOnce();
        expect(lightweightCheck).toHaveBeenCalledWith(false);
        expect(dependencies.fileProcessingService.commitPendingFileEvents).toHaveBeenCalledOnce();
        expect(generalBeforeReplicate).toHaveBeenCalledOnce();
        expect(openReplication).toHaveBeenCalledOnce();
        expect(ensureSecuritySeed).not.toHaveBeenCalled();
        expect(events).toEqual([
            "app-ready",
            "lightweight-check",
            "pending-file-events",
            "general-before-replicate",
            "open",
        ]);
    });

    it.each([REMOTE_COUCHDB, REMOTE_MINIO] as const)(
        "retains central-remote Security Seed preparation for typed %s unattended work",
        async (kind) => {
            const { dependencies, events } = createReadinessDependencies(kind);
            const service = new TestReplicationService(new ServiceContext(), dependencies);
            const ensureSecuritySeed = vi.fn();
            const prepareSecuritySeed = vi.fn(async () => {
                events.push("central-remote-security-seed");
                ensureSecuritySeed();
                return true;
            });
            const generalBeforeReplicate = vi.fn(async () => {
                events.push("general-before-replicate");
                return true;
            });
            service.onPrepareCentralRemoteReplication.addHandler(prepareSecuritySeed);
            service.onBeforeReplicate.addHandler(generalBeforeReplicate);

            await expect(
                service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })
            ).resolves.toEqual({ status: "completed" });

            expect(ensureSecuritySeed).toHaveBeenCalledOnce();
            expect(events).toEqual([
                "app-ready",
                "pending-file-events",
                "central-remote-security-seed",
                "general-before-replicate",
                "open",
            ]);
        }
    );

    it("retains central-remote Security Seed preparation for legacy readiness", async () => {
        const { dependencies } = createReadinessDependencies(REMOTE_COUCHDB, false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const ensureSecuritySeed = vi.fn();
        const prepareSecuritySeed = vi.fn(async () => {
            ensureSecuritySeed();
            return true;
        });
        service.onPrepareCentralRemoteReplication.addHandler(prepareSecuritySeed);

        await expect(service.replicate(true)).resolves.toBe(true);

        expect(ensureSecuritySeed).toHaveBeenCalledOnce();
    });

    it("does not invoke a not-applicable continuous role", async () => {
        const { activeContext, dependencies } = createTypedDependencies(true);
        Object.assign(activeContext.provider, { continuous: CAPABILITY_NOT_APPLICABLE });
        (dependencies.appLifecycleService as unknown as { isReady: () => boolean }).isReady = () => false;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "blocked",
            reason: "capability-not-applicable",
        });
    });

    it("honours a host readiness veto for manual, unattended, and continuous requests", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createTypedDependencies();
        const readiness = vi.fn(async (_showMessage?: boolean) => false);
        const service = new (class extends TestReplicationService {
            override async isReplicationReady(showMessage?: boolean): Promise<boolean> {
                return await readiness(showMessage);
            }
        })(new ServiceContext(), dependencies);
        const onStartSettled = vi.fn();

        const blocked = { status: "blocked", reason: "not-ready" };
        await expect(service.replicateUserInitiated()).resolves.toEqual(blocked);
        await expect(service.replicateUnattended({ trigger: "resume", interaction: NO_INTERACTION })).resolves.toEqual(
            blocked
        );
        await expect(
            service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION, onStartSettled })
        ).resolves.toEqual(blocked);

        expect(readiness.mock.calls).toEqual([[true], [false], [false]]);
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
        expect(openReplication).not.toHaveBeenCalled();
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
    });

    it.each(["onBeforeReplicate", "onPrepareCentralRemoteReplication"] as const)(
        "honours a host replacement of %s in readiness",
        async (hook) => {
            const { dependencies, openReplication } = createTypedDependencies();
            const veto = vi.fn(async () => false);
            const replacement = bailFirstFailureFunction<(showMessage: boolean) => Promise<boolean>>(hook);
            replacement.addHandler(veto);
            class HostReplicationService extends TestReplicationService {
                declare readonly onBeforeReplicate: typeof replacement;
                declare readonly onPrepareCentralRemoteReplication: typeof replacement;

                constructor() {
                    super(new ServiceContext(), dependencies);
                    this[hook] = replacement;
                }
            }
            const service = new HostReplicationService();
            const onStartSettled = vi.fn();

            await expect(
                service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION, onStartSettled })
            ).resolves.toEqual({ status: "blocked", reason: "not-ready" });

            expect(veto).toHaveBeenCalledExactlyOnceWith(false);
            expect(openReplication).not.toHaveBeenCalled();
            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
        }
    );

    it("settles an offline continuous start for that request without dispatching the provider", async () => {
        const { dependencies, openReplication } = createTypedDependencies();
        dependencies.APIService.isOnline = false;
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const onStartSettled = vi.fn();
        const request = { trigger: "resume", interaction: NO_INTERACTION, onStartSettled } as const;

        await expect(service.startContinuous(request)).resolves.toEqual({ status: "blocked", reason: "not-ready" });

        expect(openReplication).not.toHaveBeenCalled();
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({
            status: "failed",
            networkFailure: { reason: "offline", hostOnlineAtFailure: false, failedAt: expect.any(Number) },
        });
    });

    it.each([false, true])(
        "keeps overlapping delegated readiness results paired (reverse order: %s)",
        async (reverse) => {
            const { dependencies, openReplication } = createTypedDependencies();
            dependencies.APIService.isOnline = false;
            const gates = [promiseWithResolvers<void>(), promiseWithResolvers<void>()];
            let entered = 0;
            const service = new (class extends TestReplicationService {
                override async isReplicationReady(showMessage?: boolean): Promise<boolean> {
                    await gates[entered++].promise;
                    return await super.isReplicationReady(showMessage);
                }
            })(new ServiceContext(), dependencies);
            const callbacks = [vi.fn(), vi.fn()];
            const requests = callbacks.map((onStartSettled) =>
                service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION, onStartSettled })
            );
            await vi.waitFor(() => expect(entered).toBe(2));
            for (const index of reverse ? [1, 0] : [0, 1]) {
                gates[index].resolve();
                await expect(requests[index]).resolves.toEqual({ status: "blocked", reason: "not-ready" });
            }

            expect(openReplication).not.toHaveBeenCalled();
            for (const onStartSettled of callbacks) {
                expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({
                    status: "failed",
                    networkFailure: { reason: "offline", hostOnlineAtFailure: false, failedAt: expect.any(Number) },
                });
            }
        }
    );

    it.each([true, false])("attributes only a confirmed Security Seed transport failure (%s)", async (confirmed) => {
        const { dependencies, openReplication } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const error = confirmed
            ? captureRemoteTransportFailure(
                  Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
                  new AbortController().signal,
                  () => true
              )
            : new TypeError("Load failed");
        service.onPrepareCentralRemoteReplication.addHandler(async () => {
            return getReplicationNetworkFailure(error) ?? false;
        });
        const onStartSettled = vi.fn();

        await expect(
            service.startContinuous({ trigger: "online", interaction: NO_INTERACTION, onStartSettled })
        ).resolves.toEqual({ status: "blocked", reason: "not-ready" });

        expect(openReplication).not.toHaveBeenCalled();
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith(
            confirmed
                ? {
                      status: "failed",
                      networkFailure: {
                          reason: "remote-transport",
                          hostOnlineAtFailure: true,
                          failedAt: expect.any(Number),
                      },
                  }
                : { status: "failed" }
        );
    });

    it.each([
        ["offline at the owned connection gate", "https://couchdb.test", true, "Network is offline"],
        ["invalid URI", "ftp://couchdb.test", false, "Remote URI is not valid"],
    ] as const)("settles Security Seed preparation for %s", async (_case, uri, wentOffline, message) => {
        const { dependencies, openReplication } = createTypedDependencies();
        const context = new ServiceContext();
        const service = new TestReplicationService(context, dependencies);
        const pouchDB = vi.fn();
        const remote = new (class extends RemoteService {})(context, {
            APIService: dependencies.APIService,
            appLifecycle: dependencies.appLifecycleService,
            setting: dependencies.settingService,
            pouchDB,
        } as unknown as RemoteServiceDependencies);
        const seedReader = new LiveSyncCouchDBReplicator({
            services: { API: { isMobile: () => false, addLog: vi.fn() }, context, remote },
        } as unknown as LiveSyncCouchDBReplicator["env"]);
        const settings = {
            couchDB_URI: uri,
            couchDB_DBNAME: "seed-gate",
            couchDB_CustomHeaders: "",
        } as RemoteDBSettings;
        const onStartSettled = vi.fn();
        let seedFailure: unknown;
        service.onPrepareCentralRemoteReplication.addHandler(async () => {
            expect(dependencies.APIService.isOnline).toBe(true);
            if (wentOffline) dependencies.APIService.isOnline = false;
            try {
                await seedReader.getReplicationPBKDF2Salt(settings, true);
                return true;
            } catch (error) {
                seedFailure = error;
                return getReplicationNetworkFailure(error) ?? false;
            }
        });

        await expect(
            service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION, onStartSettled })
        ).resolves.toEqual({ status: "blocked", reason: "not-ready" });

        expect(pouchDB).not.toHaveBeenCalled();
        expect(openReplication).not.toHaveBeenCalled();
        expect(seedFailure).toMatchObject({ cause: { cause: { message: expect.stringContaining(message) } } });
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith(
            wentOffline
                ? {
                      status: "failed",
                      networkFailure: { reason: "offline", hostOnlineAtFailure: false, failedAt: expect.any(Number) },
                  }
                : { status: "failed" }
        );
    });

    it.each([true, false])("attributes a late offline preflight refusal only when reported (%s)", async (reported) => {
        const { dependencies, openReplication } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        service.onPrepareCentralRemoteReplication.addHandler(async () => {
            expect(dependencies.APIService.isOnline).toBe(true);
            await Promise.resolve();
            dependencies.APIService.isOnline = false;
            return true;
        });
        service.onBeforeReplicate.addHandler(async () => {
            expect(dependencies.APIService.isOnline).toBe(false);
            return reported ? observedOfflineReplicationFailure() : false;
        });
        const onStartSettled = vi.fn();

        await expect(
            service.startContinuous({ trigger: "resume", interaction: NO_INTERACTION, onStartSettled })
        ).resolves.toEqual({ status: "blocked", reason: "not-ready" });

        expect(openReplication).not.toHaveBeenCalled();
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith(
            reported
                ? {
                      status: "failed",
                      networkFailure: { reason: "offline", hostOnlineAtFailure: false, failedAt: expect.any(Number) },
                  }
                : { status: "failed" }
        );
    });

    it("treats a continuous void result as an accepted start", async () => {
        const { dependencies, acquireActiveReplicatorContext } = createTypedDependencies(undefined);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const beforeReplicate = vi.fn(async () => true);
        service.onBeforeReplicate.addHandler(beforeReplicate);

        await expect(service.startContinuous({ trigger: "daemon", interaction: NO_INTERACTION })).resolves.toEqual({
            status: "completed",
        });
        expect(acquireActiveReplicatorContext).toHaveBeenCalledOnce();
        expect(beforeReplicate).toHaveBeenCalledExactlyOnceWith(false);
    });

    it("preserves a boolean veto for direct preparation callers and only runs handlers up to the refusal", async () => {
        const { dependencies } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const later = vi.fn(async () => true);
        service.onBeforeReplicate.addHandler(() => observedOfflineReplicationFailure());
        service.onBeforeReplicate.addHandler(later);

        await expect(service.onBeforeReplicate(false)).resolves.toBe(false);
        expect(later).not.toHaveBeenCalled();
    });

    it("announces an operator stop when the service receives it, even without an active transfer", async () => {
        const { dependencies, getActiveReplicator, acquireActiveReplicatorContext } = createTypedDependencies();
        const context = new ServiceContext();
        const requested = vi.fn();
        context.events.onEvent("replication-abort-requested", requested);
        const service = new TestReplicationService(context, dependencies);
        acquireActiveReplicatorContext.mockResolvedValue(undefined);
        getActiveReplicator.mockReturnValue(undefined);

        const result = service.stopActiveTransfer();
        expect(requested).toHaveBeenCalledOnce();
        await expect(result).resolves.toEqual({ status: "blocked", reason: "no-active-replicator" });
        expect(requested).toHaveBeenCalledOnce();
    });

    it("stops the captured active transfer without readiness or finite activity checks", async () => {
        const { dependencies, runFiniteReplicationActivity, terminateSync } = createTypedDependencies();
        const isReady = vi.fn(() => false);
        (dependencies.appLifecycleService as unknown as { isReady: typeof isReady }).isReady = isReady;
        const failureRecovery = vi.fn(async () => false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        service.onReplicationFailed.addHandler(failureRecovery);

        await expect(service.stopActiveTransfer()).resolves.toBe(REPLICATION_COMPLETED);

        expect(terminateSync).toHaveBeenCalledOnce();
        expect(isReady).not.toHaveBeenCalled();
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(failureRecovery).not.toHaveBeenCalled();
    });

    it("returns a blocked result for a provider without the stop capability", async () => {
        const { activeContext, dependencies, terminateSync } = createTypedDependencies();
        Object.assign(activeContext.provider, { stopActiveTransfer: CAPABILITY_NOT_APPLICABLE });
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.stopActiveTransfer()).resolves.toEqual({
            status: "blocked",
            reason: "capability-not-applicable",
        });

        expect(terminateSync).not.toHaveBeenCalled();
    });

    it("distinguishes an uncomposed legacy replicator from no active replicator", async () => {
        const { dependencies, terminateSync, acquireActiveReplicatorContext } = createTypedDependencies();
        acquireActiveReplicatorContext.mockResolvedValue(undefined);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.stopActiveTransfer()).resolves.toEqual({
            status: "blocked",
            reason: "provider-not-composed",
        });

        expect(terminateSync).not.toHaveBeenCalled();
    });

    it("returns a blocked result when there is no active replicator", async () => {
        const { dependencies, getActiveReplicator, acquireActiveReplicatorContext, terminateSync } =
            createTypedDependencies();
        acquireActiveReplicatorContext.mockResolvedValue(undefined);
        getActiveReplicator.mockReturnValue(undefined);
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.stopActiveTransfer()).resolves.toEqual({
            status: "blocked",
            reason: "no-active-replicator",
        });

        expect(terminateSync).not.toHaveBeenCalled();
    });
});

describe("ReplicationService legacy remote administration bridge", () => {
    it("preserves the clean-lock input for the active compatibility facade", async () => {
        const { dependencies, markRemoteLocked } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.markLocked(true)).resolves.toBeUndefined();

        expect(markRemoteLocked).toHaveBeenCalledWith(expect.anything(), true, true);
    });

    it("keeps unlock and resolution on the established facade without widening the provider catalogue", async () => {
        const { dependencies, markRemoteLocked, markRemoteResolved } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.markUnlocked()).resolves.toBeUndefined();
        await expect(service.markResolved()).resolves.toBeUndefined();

        expect(markRemoteLocked).toHaveBeenCalledWith(expect.anything(), false, false);
        expect(markRemoteResolved).toHaveBeenCalledWith(expect.anything());
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
                acquireActiveReplicatorContext: async (): Promise<undefined> => undefined,
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
        const { dependencies } = createTypedDependencies(false);
        const calls: string[] = [];
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

    it("does not invent an exact recovery context for an uncomposed legacy caller", async () => {
        const { dependencies, openReplication, runFiniteReplicationActivity } = createDependencies();
        openReplication.mockResolvedValue(false);
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const handleFailure = vi.fn(async () => false);
        service.onReplicationFailed.addHandler(handleFailure);

        await expect(service.performReplication(true)).resolves.toBe(false);

        expect(handleFailure).not.toHaveBeenCalled();
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
    });
});

describe("ReplicationService full upload", () => {
    it("stops the admitted publication's active transfer before a directional full transfer", async () => {
        const events: string[] = [];
        let settleStop!: () => void;
        const stopGate = new Promise<void>((resolve) => {
            settleStop = resolve;
        });
        const terminateSync = vi.fn(async () => {
            events.push("active-transfer-stop-requested");
            await stopGate;
            events.push("active-transfer-stopped");
        });
        const replicateAllToServer = vi.fn(async () => {
            events.push("directional-transfer-started");
            return true;
        });
        const replicateAllFromServer = vi.fn(async () => true);
        const replicator = { replicateAllToServer, replicateAllFromServer, terminateSync };
        const context = createDirectionalReplicationContext(replicator);
        Object.assign(context.provider, { stopActiveTransfer: supportedStopActiveTransfer() });
        const runWithActiveReplicatorContext = vi.fn(
            async (task: (activeContext: ActiveReplicatorContext) => unknown) => await task(context)
        );
        const dependencies = {
            APIService: { addLog: vi.fn() },
            appLifecycleService: {
                isReady: () => true,
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), {
                    addHandler: vi.fn(),
                }),
            },
            databaseService: {},
            fileProcessingService: {},
            replicatorService: {
                acquireActiveReplicatorContext: vi.fn(async () => context),
                runWithActiveReplicatorContext,
                getActiveReplicator: () => replicator,
            },
            settingService: { currentSettings: () => ({ remoteType: REMOTE_COUCHDB }) },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        const operation = service.replicateAllToRemote();
        try {
            await vi.waitFor(() => expect(terminateSync).toHaveBeenCalledOnce());
            expect(replicateAllToServer).not.toHaveBeenCalled();

            settleStop();
            await expect(operation).resolves.toBe(true);
            expect(runWithActiveReplicatorContext).toHaveBeenCalledOnce();
            expect(events).toEqual([
                "active-transfer-stop-requested",
                "active-transfer-stopped",
                "directional-transfer-started",
            ]);
        } finally {
            settleStop();
            await Promise.allSettled([operation]);
        }
    });

    it("uses standard replication without offering the obsolete bulk chunk pre-send", async () => {
        const askYesNoDialog = vi.fn().mockResolvedValue("yes");
        const sendChunks = vi.fn().mockResolvedValue(true);
        const replicateAllToServer = vi.fn().mockResolvedValue(true);
        const replicateAllFromServer = vi.fn().mockResolvedValue(true);
        const context = createDirectionalReplicationContext({ replicateAllToServer, replicateAllFromServer });
        const runWithActiveReplicatorContext = vi.fn(async (task: (context: ActiveReplicatorContext) => unknown) =>
            task(context)
        );
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
                acquireActiveReplicatorContext: async () => context,
                runWithActiveReplicatorContext,
                getActiveReplicator: () => ({
                    isChunkSendingSupported: true,
                    sendChunks,
                    replicateAllToServer,
                }),
            },
            settingService: {
                currentSettings: () => ({ remoteType: REMOTE_COUCHDB }),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateAllToRemote(true)).resolves.toBe(true);

        expect(askYesNoDialog).not.toHaveBeenCalled();
        expect(sendChunks).not.toHaveBeenCalled();
        expect(runWithActiveReplicatorContext).toHaveBeenCalledOnce();
        expect(replicateAllToServer).toHaveBeenCalledOnce();
    });

    it("does not run a directional transfer with settings which have not yet been rebound", async () => {
        const replicateAllToServer = vi.fn(async () => true);
        const replicateAllFromServer = vi.fn(async () => true);
        const context = Object.assign(
            createDirectionalReplicationContext({ replicateAllToServer, replicateAllFromServer }),
            { configurationIdentity: "profile-a" }
        );
        const stopActiveTransfer = vi.fn(async () => REPLICATION_COMPLETED);
        Object.assign(context.provider, {
            configurationIdentity: testConfigurationIdentity,
            stopActiveTransfer: supportedCapability(stopActiveTransfer),
        });
        const runWithActiveReplicatorContext = vi.fn(
            async (task: (activeContext: ActiveReplicatorContext) => unknown) => await task(context)
        );
        const dependencies = {
            APIService: { addLog: vi.fn() },
            appLifecycleService: {
                isReady: () => true,
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), {
                    addHandler: vi.fn(),
                }),
            },
            databaseService: {},
            fileProcessingService: {},
            replicatorService: {
                acquireActiveReplicatorContext: vi.fn(async () => context),
                runWithActiveReplicatorContext,
                getActiveReplicator: () => context.replicator,
            },
            settingService: {
                currentSettings: () => ({
                    remoteType: REMOTE_COUCHDB,
                    activeConfigurationId: "profile-b",
                }),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateAllToRemote()).resolves.toBe(false);

        expect(stopActiveTransfer).not.toHaveBeenCalled();
        expect(replicateAllToServer).not.toHaveBeenCalled();
    });
});

describe("ReplicationService rebuild maintenance", () => {
    function createMaintenanceService({ applicationReady = false, databaseReady = true, versionUpFlash = "" } = {}) {
        const transferEvents: string[] = [];
        const replicateAllToServer = vi.fn(async (_setting: RemoteDBSettings) => true);
        const replicateAllFromServer = vi.fn(async (_setting: RemoteDBSettings) => true);
        const context = createDirectionalReplicationContext({ replicateAllToServer, replicateAllFromServer });
        const runWithActiveReplicatorContext = vi.fn(async (task: (context: ActiveReplicatorContext) => unknown) => {
            transferEvents.push("publication-admitted");
            try {
                return await task(context);
            } finally {
                transferEvents.push("publication-released");
            }
        });
        const settings = { remoteType: REMOTE_COUCHDB, versionUpFlash };
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
                acquireActiveReplicatorContext: async () => context,
                runWithActiveReplicatorContext,
                getActiveReplicator: vi.fn(() => ({ replicateAllToServer, replicateAllFromServer })),
            },
            settingService: {
                currentSettings: vi.fn(() => settings),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        return {
            context,
            replicateAllFromServer,
            replicateAllToServer,
            runWithActiveReplicatorContext,
            service,
            settings,
            transferEvents,
        };
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

    it("keeps a compatibility pause persisted while authorising only explicit rebuild transfer snapshots", async () => {
        const compatibilityPause = "Review database compatibility before ordinary synchronisation.";
        const { replicateAllFromServer, replicateAllToServer, service, settings } = createMaintenanceService({
            applicationReady: true,
            versionUpFlash: compatibilityPause,
        });
        replicateAllToServer.mockImplementation(async (setting) => setting.versionUpFlash === "");
        replicateAllFromServer.mockImplementation(async (setting) => setting.versionUpFlash === "");

        await expect(service.replicateAllToRemote()).resolves.toBe(false);
        await expect(service.replicateAllFromRemote()).resolves.toBe(false);
        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(true);
        await expect(service.replicateAllFromRemoteForRebuild()).resolves.toBe(true);

        expect(replicateAllToServer).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ versionUpFlash: compatibilityPause }),
            false
        );
        expect(replicateAllToServer).toHaveBeenNthCalledWith(2, expect.objectContaining({ versionUpFlash: "" }), false);
        expect(replicateAllFromServer).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ versionUpFlash: compatibilityPause }),
            false
        );
        expect(replicateAllFromServer).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ versionUpFlash: "" }),
            false
        );
        expect(settings.versionUpFlash).toBe(compatibilityPause);
    });

    it("keeps a failed rebuild upload failed when no connection-failure handler claims it", async () => {
        const { replicateAllToServer, service } = createMaintenanceService();
        replicateAllToServer.mockResolvedValue(false);

        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(false);

        expect(replicateAllToServer).toHaveBeenCalledOnce();
    });

    it("retries a failed full transfer only when the compatibility handler requests it", async () => {
        const { replicateAllToServer, runWithActiveReplicatorContext, service, transferEvents } =
            createMaintenanceService();
        replicateAllToServer
            .mockImplementationOnce(async () => {
                transferEvents.push("upload-attempt");
                return false;
            })
            .mockImplementationOnce(async () => {
                transferEvents.push("upload-attempt");
                return true;
            });
        service.checkConnectionFailure.addHandler(async () => {
            transferEvents.push("compatibility-check");
            return "CHECKAGAIN";
        });

        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(true);

        expect(runWithActiveReplicatorContext).toHaveBeenCalledTimes(2);
        expect(replicateAllToServer).toHaveBeenCalledTimes(2);
        expect(transferEvents).toEqual([
            "publication-admitted",
            "upload-attempt",
            "publication-released",
            "compatibility-check",
            "publication-admitted",
            "upload-attempt",
            "publication-released",
        ]);
    });

    it("captures a fresh settings snapshot for a compatibility retry", async () => {
        const { replicateAllToServer, service, settings } = createMaintenanceService();
        replicateAllToServer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        service.checkConnectionFailure.addHandler(async () => {
            Object.assign(settings, { customChunkSize: 60 });
            return "CHECKAGAIN";
        });

        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(true);

        const firstSetting = replicateAllToServer.mock.calls[0][0];
        const retrySetting = replicateAllToServer.mock.calls[1][0];
        expect(firstSetting).not.toBe(retrySetting);
        expect(firstSetting.customChunkSize).toBeUndefined();
        expect(retrySetting.customChunkSize).toBe(60);
        expect(Object.isFrozen(firstSetting)).toBe(true);
        expect(Object.isFrozen(retrySetting)).toBe(true);
    });

    it("does not retry a full transfer against a replacement publication", async () => {
        const { context, replicateAllToServer, runWithActiveReplicatorContext, service } = createMaintenanceService();
        const replacementUpload = vi.fn(async () => true);
        const replacementContext = createDirectionalReplicationContext({
            replicateAllToServer: replacementUpload,
            replicateAllFromServer: vi.fn(async () => true),
        });
        replicateAllToServer.mockResolvedValue(false);
        runWithActiveReplicatorContext
            .mockImplementationOnce(async (task) => await task(context))
            .mockImplementationOnce(async (task) => await task(replacementContext));
        service.checkConnectionFailure.addHandler(async () => "CHECKAGAIN");

        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(false);

        expect(runWithActiveReplicatorContext).toHaveBeenCalledTimes(2);
        expect(replicateAllToServer).toHaveBeenCalledOnce();
        expect(replacementUpload).not.toHaveBeenCalled();
    });

    it("passes the exact failed directional attempt to compatibility recovery after replacement", async () => {
        const { context, replicateAllToServer, runWithActiveReplicatorContext, service } = createMaintenanceService();
        const replacementUpload = vi.fn(async () => true);
        const replacementContext = createDirectionalReplicationContext({
            replicateAllToServer: replacementUpload,
            replicateAllFromServer: vi.fn(async () => true),
        });
        type RecoveryMarker = { recoveryTouched?: boolean };
        type DirectionalRecoveryRequest = {
            readonly context: ActiveReplicatorContext;
            readonly setting: RemoteDBSettings;
            readonly outcome: { readonly status: string };
        };
        const failedReplicator = context.replicator as RecoveryMarker;
        const replacementReplicator = replacementContext.replicator as RecoveryMarker;
        let activeReplicator = failedReplicator;
        let recoveryRequest: DirectionalRecoveryRequest | undefined;
        replicateAllToServer.mockImplementation(async () => {
            activeReplicator = replacementReplicator;
            return false;
        });
        runWithActiveReplicatorContext
            .mockImplementationOnce(async (task) => await task(context))
            .mockImplementation(async (task) => await task(replacementContext));
        service.checkConnectionFailure.addHandler(async (request?: DirectionalRecoveryRequest) => {
            recoveryRequest = request;
            const target = (request?.context.replicator as RecoveryMarker | undefined) ?? activeReplicator;
            target.recoveryTouched = true;
            return "CHECKAGAIN";
        });

        await expect(service.replicateAllToRemoteForRebuild()).resolves.toBe(false);

        expect(recoveryRequest).toMatchObject({
            context,
            setting: expect.objectContaining({ versionUpFlash: "" }),
            outcome: expect.objectContaining({ status: "failed" }),
        });
        expect(failedReplicator.recoveryTouched).toBe(true);
        expect(replacementReplicator.recoveryTouched).toBeUndefined();
        expect(replacementUpload).not.toHaveBeenCalled();
    });

    it("keeps a failed rebuild download failed when no connection-failure handler claims it", async () => {
        const { replicateAllFromServer, service } = createMaintenanceService();
        replicateAllFromServer.mockResolvedValue(false);

        await expect(service.replicateAllFromRemoteForRebuild()).resolves.toBe(false);

        expect(replicateAllFromServer).toHaveBeenCalledOnce();
    });

    it.each([false, true])("passes the unsupported format to Standard Fetch (after retry: %s)", async (retry) => {
        const { replicateAllFromServer, service } = createMaintenanceService();
        const failure = new UnsupportedEncryptedDocumentFormatError();
        const recoverConnection = vi.fn(async () => "CHECKAGAIN" as const);
        service.checkConnectionFailure.addHandler(recoverConnection);
        if (retry) {
            replicateAllFromServer.mockResolvedValueOnce(false);
        }
        replicateAllFromServer.mockRejectedValueOnce(failure);

        await expect(service.replicateAllFromRemoteForRebuild()).rejects.toBe(failure);
        expect(recoverConnection).toHaveBeenCalledTimes(retry ? 1 : 0);
        expect(replicateAllFromServer).toHaveBeenCalledTimes(retry ? 2 : 1);
    });

    it("admits a P2P-style rebuild download without requiring an upload operation", async () => {
        const replicateAllFromServer = vi.fn(async () => true);
        const context = createDirectionalReplicationContext({ replicateAllFromServer } as never);
        const dependencies = {
            APIService: { addLog: vi.fn() },
            appLifecycleService: {
                isReady: vi.fn(() => false),
                getUnresolvedMessages: Object.assign(vi.fn().mockResolvedValue([]), {
                    addHandler: vi.fn(),
                }),
            },
            databaseService: {
                isDatabaseReady: vi.fn(() => true),
            },
            fileProcessingService: {},
            replicatorService: {
                acquireActiveReplicatorContext: vi.fn(async () => context),
                runWithActiveReplicatorContext: vi.fn(
                    async (task: (activeContext: ActiveReplicatorContext) => unknown) => await task(context)
                ),
                getActiveReplicator: vi.fn(() => context.replicator),
            },
            settingService: {
                currentSettings: vi.fn(() => ({ remoteType: REMOTE_COUCHDB })),
            },
        } as unknown as ReplicationServiceDependencies;
        const service = new TestReplicationService(new ServiceContext(), dependencies);

        await expect(service.replicateAllFromRemoteForRebuild()).resolves.toBe(true);

        expect(replicateAllFromServer).toHaveBeenCalledOnce();
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

describe("strict reflection dispatch", () => {
    it("propagates the reflection error unchanged to its owning caller", async () => {
        const { dependencies } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const error = { diagnostic: "read failed" };
        service.processSynchroniseResult.addHandler(async () => {
            throw error;
        });
        await expect(service.processSynchroniseResult({ _id: "note.md", _rev: "2-target" } as never)).rejects.toBe(
            error
        );
    });

    it("propagates the snapshot save error unchanged after a reflection failure", async () => {
        const { dependencies } = createTypedDependencies();
        const service = new TestReplicationService(new ServiceContext(), dependencies);
        const error = new Error("snapshot save failed");
        service.onFileReflectionFailed.addHandler(async () => {
            throw error;
        });
        await expect(
            service.onFileReflectionFailed(
                { documentId: "note.md" as never, revision: "2-target" },
                new Error("read failed")
            )
        ).rejects.toBe(error);
    });
});
