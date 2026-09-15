import { expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";

const { createP2PService } = vi.hoisted(() => ({
    createP2PService: vi.fn(() => ({
        compatibilityReplicator: { env: {} },
        views: {
            transportLifecycle: {},
            connectionProbe: {},
            peerDirectory: {},
            peerAdmission: {},
            targetedTransfer: {},
            changeRelay: {},
            configurationExchange: {},
            diagnostics: {},
        },
        lifecycle: {
            requestStatus: vi.fn(),
            openAfterDatabaseRebuild: vi.fn(),
            closeForLifecycle: vi.fn(),
            reconcileAutoStart: vi.fn(),
            scheduleAutoStart: vi.fn(),
        },
        createActiveReplicator: vi.fn(),
    })),
}));

vi.mock("@lib/p2p/P2PService", () => ({ createP2PService }));

import { useP2PReplicatorFeature } from "./useP2PReplicatorFeature";

it("passes the optional fourth argument into the private P2P service composition", () => {
    const events = createLiveSyncEventHub();
    const handler = { addHandler: vi.fn() };
    const services = {
        context: { events },
        setting: {
            currentSettings: vi.fn(() => ({ remoteType: "P2P", P2P_Enabled: true })),
            suspendExtraSync: handler,
        },
        replicator: { registerReplicatorProviderDefinitions: vi.fn() },
        appLifecycle: {
            onUnload: handler,
            onSuspending: handler,
            onResumed: handler,
        },
        databaseEvents: {
            onResetDatabase: handler,
            onCloseDatabase: handler,
            onDatabaseInitialisation: handler,
        },
    };
    const iceServerSources = { managed: vi.fn() };

    useP2PReplicatorFeature({ services, serviceModules: {} } as any, undefined, undefined, { iceServerSources });

    expect(createP2PService).toHaveBeenCalledWith({ services }, { iceServerSources });
});
