import { describe, expect, it, vi } from "vitest";
import { REMOTE_P2P } from "@lib/common/types";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_ADVERTISEMENT_RECEIVED } from "./TrysteroReplicatorP2PServer";
import { useP2PReplicatorFeature } from "./useP2PReplicatorFeature";
import { NO_INTERACTION, type ReplicatorProviderDefinitionMap } from "@lib/replication";

describe("useP2PReplicatorFeature", () => {
    it("routes P2P events to the current replicator after replacement", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: { onDatabaseInitialisation: handler },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const result = useP2PReplicatorFeature(host);
        const first = result.replicator;
        const firstOnNewPeer = vi.spyOn(first, "onNewPeer");
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition).toBeDefined();
        expect(definition?.kind).toBe(REMOTE_P2P);
        expect(definition?.isConfigured({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never)).toBe(true);
        expect(definition?.isConfigured({ remoteType: REMOTE_P2P, P2P_Enabled: false } as never)).toBe(false);
        expect(definition?.userInitiatedOneShot.kind).toBe("supported");
        expect(definition?.unattendedOneShot.kind).toBe("not-implemented");
        expect(definition?.continuous.kind).toBe("not-applicable");
        const second = (await definition?.create({
            remoteType: REMOTE_P2P,
            P2P_Enabled: true,
        } as never)) as typeof first;
        const secondOnNewPeer = vi.spyOn(second, "onNewPeer");

        events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, {
            peerId: "peer-a",
            name: "Device A",
            platform: "test",
        });

        expect(result.replicator).toBe(second);
        expect(firstOnNewPeer).not.toHaveBeenCalled();
        expect(secondOnNewPeer).toHaveBeenCalledOnce();
    });

    it("requires peer-selection authority for the user P2P role", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: { onDatabaseInitialisation: handler },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        useP2PReplicatorFeature(host);
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition?.userInitiatedOneShot.kind).toBe("supported");
        if (definition?.userInitiatedOneShot.kind !== "supported") throw new Error("P2P role is not supported");
        const openReplication = vi.fn();
        const result = await definition.userInitiatedOneShot.run({ openReplication } as never, {} as never, {
            trigger: "manual",
            interaction: NO_INTERACTION,
        });

        expect(result).toEqual({ status: "blocked", reason: "interaction-required" });
        expect(openReplication).not.toHaveBeenCalled();
    });

    it("shares one replacement across concurrent replicator requests", async () => {
        const events = createLiveSyncEventHub();
        let definitions: ReplicatorProviderDefinitionMap | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P, P2P_Enabled: true })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    registerReplicatorProviderDefinitions: vi.fn((value) => {
                        definitions = value;
                    }),
                },
                appLifecycle: {
                    onUnload: handler,
                    onSuspending: handler,
                    onResumed: handler,
                },
                databaseEvents: { onDatabaseInitialisation: handler },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorFeature>[0];

        const result = useP2PReplicatorFeature(host);
        const original = result.replicator;
        const definition = definitions?.get(REMOTE_P2P);
        expect(definition).toBeDefined();
        let resolveClose!: () => void;
        const closeGate = new Promise<void>((resolve) => {
            resolveClose = resolve;
        });
        const close = vi.spyOn(original, "close").mockReturnValue(closeGate);

        const firstRequest = definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);
        const secondRequest = definition!.create({ remoteType: REMOTE_P2P, P2P_Enabled: true } as never);
        resolveClose();
        const [firstReplacement, secondReplacement] = await Promise.all([firstRequest, secondRequest]);

        expect(close).toHaveBeenCalledOnce();
        expect(firstReplacement).toBe(secondReplacement);
        expect(result.replicator).toBe(firstReplacement);
    });
});
