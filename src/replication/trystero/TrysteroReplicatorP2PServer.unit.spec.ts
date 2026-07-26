import { describe, expect, it, vi } from "vitest";

import { createLiveSyncEventHub } from "@lib/hub/hub";
import { P2PHost } from "./TrysteroReplicatorP2PServer";

describe("P2PHost transport ownership", () => {
    it("leaves the room without closing Trystero-owned peer connections directly", async () => {
        const closePeerConnection = vi.fn();
        const leave = vi.fn(async () => undefined);
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        (host as any)._room = {
            getPeers: () => ({
                "peer-a": { close: closePeerConnection },
            }),
            leave,
        };

        await host.close();

        expect(leave).toHaveBeenCalledOnce();
        expect(closePeerConnection).not.toHaveBeenCalled();
        expect(host.room).toBeUndefined();
        expect(host.rpcRoom).toBeUndefined();
    });
});
