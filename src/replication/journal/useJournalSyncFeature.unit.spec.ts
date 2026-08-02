import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "@lib/common/types.ts";
import { useJournalSyncFeature } from "./useJournalSyncFeature.ts";

describe("useJournalSyncFeature", () => {
    it("registers one family handler which selects every Journal provider", async () => {
        let createReplicator: ((override?: Record<string, unknown>) => Promise<unknown>) | undefined;
        const replicator = { kind: "journal" };
        const factory = vi.fn(() => replicator as never);
        const settings = { ...DEFAULT_SETTINGS, remoteType: REMOTE_COUCHDB };
        const host = {
            services: {
                setting: { currentSettings: vi.fn(() => settings) },
                replicator: {
                    getNewReplicator: {
                        addHandler: vi.fn((handler) => {
                            createReplicator = handler;
                        }),
                    },
                },
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useJournalSyncFeature>[0];

        useJournalSyncFeature(host, { createReplicator: factory });

        await expect(createReplicator?.()).resolves.toBeUndefined();
        await expect(createReplicator?.({ remoteType: REMOTE_P2P })).resolves.toBeUndefined();
        await expect(createReplicator?.({ remoteType: REMOTE_MINIO })).resolves.toBe(replicator);
        expect(factory).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledWith(host);
    });
});
