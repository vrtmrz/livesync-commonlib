import { describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";

const useP2PReplicatorFeature = vi.hoisted(() => vi.fn());

vi.mock("./useP2PReplicatorFeature", () => ({ useP2PReplicatorFeature }));

import { useP2PReplicator } from "./P2PReplicatorCore";

describe("useP2PReplicator compatibility wrapper", () => {
    it("delegates replicator ownership and lifecycle to the current service feature", () => {
        const replicator = { id: "current-replicator" };
        useP2PReplicatorFeature.mockReturnValue({ replicator });
        const handler = { addHandler: vi.fn() };
        const host = {
            services: {
                context: { events: createLiveSyncEventHub() },
                appLifecycle: {
                    onResumed: handler,
                    onUnload: handler,
                    onSuspending: handler,
                },
                databaseEvents: { onDatabaseInitialisation: handler },
                setting: {
                    currentSettings: vi.fn(() => ({ remoteType: "", P2P_Enabled: false })),
                    suspendExtraSync: handler,
                },
                replicator: { getNewReplicator: handler },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicator>[0];

        const result = useP2PReplicator(host);

        expect(useP2PReplicatorFeature).toHaveBeenCalledOnce();
        expect(useP2PReplicatorFeature).toHaveBeenCalledWith(host);
        expect(result.replicator).toBe(replicator);
    });
});
