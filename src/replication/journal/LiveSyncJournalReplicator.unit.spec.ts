import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@lib/common/types.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";

describe("LiveSyncJournalReplicator", () => {
    it("propagates a Journal core synchronisation failure", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        replicator.checkReplicationConnectivity = vi.fn(async () => true);
        const sync = vi.fn(async () => false);
        replicator.setupJournalSyncClient = vi.fn(() => ({ sync }) as unknown as JournalSyncCore);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, true, false)).resolves.toBe(false);
        expect(sync).toHaveBeenCalledWith(true);
    });
});
