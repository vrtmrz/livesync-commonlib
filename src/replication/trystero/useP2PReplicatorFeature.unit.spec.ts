import { describe, expect, it, vi } from "vitest";
import { REMOTE_P2P } from "@lib/common/types";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_ADVERTISEMENT_RECEIVED } from "./TrysteroReplicatorP2PServer";
import { useP2PReplicatorFeature } from "./useP2PReplicatorFeature";

describe("useP2PReplicatorFeature", () => {
    it("routes P2P events to the current replicator after replacement", async () => {
        const events = createLiveSyncEventHub();
        let createReplicator: ((override?: Record<string, unknown>) => Promise<unknown>) | undefined;
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: REMOTE_P2P })),
                    suspendExtraSync: handler,
                },
                replicator: {
                    getNewReplicator: {
                        addHandler: vi.fn((callback) => {
                            createReplicator = callback;
                        }),
                    },
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
        const second = (await createReplicator?.()) as typeof first;
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
});
