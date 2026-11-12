import { getRelaySockets, pauseRelayReconnection, resumeRelayReconnection } from "@trystero-p2p/nostr";

/** The facade borrows relay controls; it does not own another socket registry. */
export interface RelayControl {
    getSockets(): Record<string, { close(): void }>;
    pauseReconnection(): void;
    resumeReconnection(): void;
}

/** Read the current Trystero registry only when disconnection starts. */
function readRelaySockets(): ReturnType<RelayControl["getSockets"]> {
    // Trystero exposes this operation without a declared return type.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return getRelaySockets() as ReturnType<RelayControl["getSockets"]>;
}

/** Default operations retain Trystero's existing shared relay ownership. */
export const defaultRelayControl: RelayControl = {
    getSockets: readRelaySockets,
    pauseReconnection: () => {
        pauseRelayReconnection();
    },
    resumeReconnection: () => {
        resumeRelayReconnection();
    },
};

export type RelayDisconnectionContext = {
    relay: Pick<RelayControl, "getSockets" | "pauseReconnection">;
    pauseServe(): Promise<void>;
};

/**
 * Capture sockets before pausing reconnection, close that snapshot, and start
 * the host's existing asynchronous stop operation without awaiting it. A read,
 * pause, or close failure retains its original synchronous propagation order.
 */
export function disconnectRelay({ relay, pauseServe }: RelayDisconnectionContext): void {
    const sockets = Object.entries(relay.getSockets());
    relay.pauseReconnection();
    for (const [, socket] of sockets) {
        socket.close();
    }
    void pauseServe();
}
