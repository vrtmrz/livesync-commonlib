import type { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises.js";

type Waiter = ReturnType<typeof promiseWithResolvers<void>>;

export interface SplitGateState {
    readonly capacity: number;
    readonly waiters: Set<Waiter>;
    active: number;
    closed?: RpcError;
}

export function createSplitGateState(capacity: number): SplitGateState {
    return { capacity, active: 0, waiters: new Set() };
}

/** Hand off the existing permit in FIFO order, or free it if nobody is waiting. */
export function releaseSplitSlot(state: SplitGateState): void {
    const next = state.waiters.values().next().value;
    if (next === undefined) {
        state.active--;
        return;
    }
    state.waiters.delete(next);
    next.resolve();
}

function releasePermit(state: SplitGateState, permit: { released: boolean }): void {
    if (!permit.released) {
        permit.released = true;
        releaseSplitSlot(state);
    }
}

function abortWaiter(state: SplitGateState, waiter: Waiter, signal: AbortSignal): void {
    if (state.waiters.delete(waiter)) {
        waiter.reject(signal.reason);
    }
}

export async function acquireSplitSlot(state: SplitGateState, signal: AbortSignal): Promise<() => void> {
    if (state.closed !== undefined) {
        throw state.closed;
    }
    if (signal.aborted) {
        throw signal.reason;
    }
    if (state.active < state.capacity) {
        state.active++;
    } else {
        const waiter = promiseWithResolvers<void>();
        const onAbort = abortWaiter.bind(undefined, state, waiter, signal);
        state.waiters.add(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            await waiter.promise;
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
        if (state.closed !== undefined) {
            releaseSplitSlot(state);
            throw state.closed;
        }
    }
    return releasePermit.bind(undefined, state, { released: false });
}

export function closeSplitGate(state: SplitGateState, error: RpcError): void {
    state.closed = error;
    for (const waiter of state.waiters) {
        waiter.reject(error);
    }
    state.waiters.clear();
}

export function createSplitGate(capacity: number) {
    const state = createSplitGateState(capacity);
    return {
        acquire: acquireSplitSlot.bind(undefined, state),
        close: closeSplitGate.bind(undefined, state),
    };
}
