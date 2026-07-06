import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_WEBDAV } from "@lib/common/types.ts";
import { ReplicatorService } from "./ReplicatorService.ts";
import type { ServiceContext } from "./ServiceBase.ts";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator.ts";

class TestReplicatorService extends ReplicatorService<ServiceContext> {
    async initialiseForTest(): Promise<boolean> {
        return await (this as unknown as { _initialiseReplicator: () => Promise<boolean> })._initialiseReplicator();
    }
}

function makeDependencies(settings: Record<string, unknown>) {
    const addHandler = vi.fn();
    return {
        settingService: {
            currentSettings: vi.fn(() => settings),
            onRealiseSetting: { addHandler },
        },
        appLifecycleService: {
            onSuspending: { addHandler },
            getUnresolvedMessages: { addHandler },
        },
        databaseEventService: {
            onResetDatabase: { addHandler },
            onDatabaseInitialisation: { addHandler },
            onDatabaseInitialised: { addHandler },
            onDatabaseHasReady: { addHandler },
        },
    } as never;
}

describe("ReplicatorService WebDAV configuration", () => {
    it("should initialise a replicator when WebDAV has an active connection URI", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
        };
        const service = new TestReplicatorService({} as ServiceContext, makeDependencies(settings));
        const closeReplication = vi.fn();
        const getNewReplicator = vi.fn(
            async () =>
                ({
                    closeReplication,
                }) as unknown as LiveSyncAbstractReplicator
        );
        service.getNewReplicator.addHandler(getNewReplicator);

        await expect(service.initialiseForTest()).resolves.toBe(true);

        expect(getNewReplicator).toHaveBeenCalledTimes(1);
        expect(service.getActiveReplicator()).toBeTruthy();
    });

    it("should skip replicator initialisation when WebDAV URI is empty", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "",
        };
        const service = new TestReplicatorService({} as ServiceContext, makeDependencies(settings));
        const getNewReplicator = vi.fn(
            async () =>
                ({
                    closeReplication: vi.fn(),
                }) as unknown as LiveSyncAbstractReplicator
        );
        service.getNewReplicator.addHandler(getNewReplicator);

        await expect(service.initialiseForTest()).resolves.toBe(true);

        expect(getNewReplicator).not.toHaveBeenCalled();
    });
});
