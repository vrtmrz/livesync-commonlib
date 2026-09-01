import type { ReplicatorHostEnv } from "./types";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { P2PHost } from "./TrysteroReplicatorP2PServer";

type ActiveFiniteOperation = {
    readonly controller: AbortController;
    settlement?: Promise<unknown>;
    detachSignals: () => void;
};

/**
 * Narrow operation boundary owned by one P2P room session.
 *
 * A manual stop aborts only current finite operations. Retiring the session
 * aborts the session lifetime, waits for cooperative operations to settle,
 * and then releases the room transport.
 */
export interface P2PFiniteOperationOwner {
    runFiniteOperation<T>(task: (signal: AbortSignal) => T | PromiseLike<T>, callerSignal?: AbortSignal): Promise<T>;
}

/** Owns one P2P room membership and every finite operation bound to it. */
export class P2PRoomSession implements P2PFiniteOperationOwner {
    readonly host: P2PHost;
    readonly replicator: TrysteroReplicator;

    private readonly sessionController = new AbortController();
    private readonly activeFiniteOperations = new Set<ActiveFiniteOperation>();
    private readonly detachPeerHandlers: () => void;
    private acceptingOperations = true;
    private retirement?: Promise<void>;

    constructor(env: ReplicatorHostEnv) {
        this.host = new P2PHost(env);
        this.replicator = new TrysteroReplicator(env, this.host, this);
        this.detachPeerHandlers = this.host.setSessionPeerHandlers({
            onAdvertisement: async (peer) => {
                if (!this.acceptingOperations) return;
                await this.replicator.onNewPeer(peer);
            },
            onPeerLeft: (peerId) => {
                if (!this.acceptingOperations) return;
                this.replicator.onPeerLeaved(peerId);
            },
        });
    }

    /** Open the room owned by this session. */
    async open(): Promise<void> {
        if (!this.acceptingOperations) {
            throw new Error("The P2P room session is retiring.");
        }
        await this.replicator.open();
    }

    async runFiniteOperation<T>(
        task: (signal: AbortSignal) => T | PromiseLike<T>,
        callerSignal?: AbortSignal
    ): Promise<T> {
        if (!this.acceptingOperations) {
            throw new Error("The P2P room session is retiring.");
        }

        const controller = new AbortController();
        const detachSignals = this.linkOperationController(controller, callerSignal);
        const operation: ActiveFiniteOperation = { controller, detachSignals };
        this.activeFiniteOperations.add(operation);

        const settlement = Promise.resolve()
            .then(() => task(controller.signal))
            .finally(() => {
                detachSignals();
                this.activeFiniteOperations.delete(operation);
            });
        operation.settlement = settlement;
        return await settlement;
    }

    /** Request cooperative cancellation of current transfers without leaving the room. */
    cancelActiveTransfers(reason: unknown = new Error("P2P transfer cancelled.")): void {
        for (const operation of this.activeFiniteOperations) {
            if (!operation.controller.signal.aborted) {
                operation.controller.abort(reason);
            }
        }
    }

    /** Fence this session, settle its current operations, and release its room. */
    retire(reason: unknown = new Error("P2P room session retired.")): Promise<void> {
        this.retirement ??= (async () => {
            this.acceptingOperations = false;
            this.detachPeerHandlers();
            if (!this.sessionController.signal.aborted) {
                this.sessionController.abort(reason);
            }
            this.cancelActiveTransfers(reason);
            await Promise.allSettled(
                [...this.activeFiniteOperations]
                    .map((operation) => operation.settlement)
                    .filter((settlement): settlement is Promise<unknown> => settlement !== undefined)
            );
            this.replicator.disableBroadcastChanges();
            await this.replicator.dispose();
        })();
        return this.retirement;
    }

    private linkOperationController(controller: AbortController, callerSignal?: AbortSignal): () => void {
        const listeners = new Map<AbortSignal, () => void>();
        const detach = () => {
            for (const [signal, listener] of listeners) {
                signal.removeEventListener("abort", listener);
            }
            listeners.clear();
        };
        const abortFrom = (signal: AbortSignal) => {
            detach();
            if (!controller.signal.aborted) {
                controller.abort(signal.reason);
            }
        };

        for (const signal of [this.sessionController.signal, callerSignal]) {
            if (!signal) continue;
            if (signal.aborted) {
                abortFrom(signal);
                break;
            }
            const listener = () => abortFrom(signal);
            listeners.set(signal, listener);
            signal.addEventListener("abort", listener, { once: true });
        }
        return detach;
    }
}
