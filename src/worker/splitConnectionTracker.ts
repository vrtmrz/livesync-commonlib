interface SplitConnection {
    readonly signal: {
        readonly aborted: boolean;
        addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
    };
}

interface SplitConnectionLease<TConnection, TClient> {
    connection: TConnection;
    client: TClient;
    release: () => void;
}

export interface SplitConnectionTrackerState<TConnection extends SplitConnection, TClient> {
    readonly readySlots: Map<TConnection, TClient>;
    readonly activeSplitCounts: Map<TConnection, number>;
    closed: boolean;
}

export function createSplitConnectionTrackerState<
    TConnection extends SplitConnection,
    TClient,
>(): SplitConnectionTrackerState<TConnection, TClient> {
    return { readySlots: new Map(), activeSplitCounts: new Map(), closed: false };
}

export function trackConnection<TConnection extends SplitConnection, TClient>(
    state: SplitConnectionTrackerState<TConnection, TClient>,
    connection: TConnection,
    ready: Promise<TClient>
): void {
    connection.signal.addEventListener(
        "abort",
        () => {
            state.readySlots.delete(connection);
            state.activeSplitCounts.delete(connection);
        },
        { once: true }
    );
    void ready.then(
        (client) => {
            if (!state.closed && !connection.signal.aborted) {
                state.readySlots.set(connection, client);
            }
        },
        (): void => undefined
    );
}

/** Count each overlapping split on the same connection, including restart fallbacks. */
export function reserveSplitConnection<TConnection extends SplitConnection, TClient>(
    state: SplitConnectionTrackerState<TConnection, TClient>,
    connection: TConnection,
    client: TClient,
    releaseCandidate?: () => void
): SplitConnectionLease<TConnection, TClient> {
    const counts = state.activeSplitCounts;
    const counted = !state.closed && !connection.signal.aborted;
    if (counted) {
        counts.set(connection, (counts.get(connection) ?? 0) + 1);
    }
    let released = false;
    return {
        connection,
        client,
        release() {
            if (released) {
                return;
            }
            released = true;
            if (counted) {
                const remaining = (counts.get(connection) ?? 0) - 1;
                if (remaining > 0) {
                    counts.set(connection, remaining);
                } else {
                    counts.delete(connection);
                }
            }
            releaseCandidate?.();
        },
    };
}

export async function acquireTrackedSplitConnection<TConnection extends SplitConnection, TClient>(
    state: SplitConnectionTrackerState<TConnection, TClient>,
    acquireCandidate: () => Promise<SplitConnectionLease<TConnection, TClient>>
): Promise<SplitConnectionLease<TConnection, TClient>> {
    const candidate = await acquireCandidate();
    if (!state.activeSplitCounts.has(candidate.connection)) {
        return reserveSplitConnection(state, candidate.connection, candidate.client, candidate.release);
    }

    // A Worker without an active split can take one even when it has more encryption leases.
    for (const [connection, client] of state.readySlots) {
        if (!connection.signal.aborted && !state.activeSplitCounts.has(connection)) {
            candidate.release();
            return reserveSplitConnection(state, connection, client);
        }
    }

    // All other connections may still be starting or restarting.
    return reserveSplitConnection(state, candidate.connection, candidate.client, candidate.release);
}

export function closeSplitConnectionTracker<TConnection extends SplitConnection, TClient>(
    state: SplitConnectionTrackerState<TConnection, TClient>
): void {
    state.closed = true;
    state.readySlots.clear();
    state.activeSplitCounts.clear();
}
