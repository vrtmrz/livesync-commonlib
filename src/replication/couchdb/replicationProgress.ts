import type PouchDB from "pouchdb-core";
import type { EntryDoc } from "@lib/common/types.ts";
import type {
    CouchDBReplicationPhase,
    CouchDBReplicationProgress,
    ReplicationCheckpointProgress,
} from "@lib/common/models/shared.definition.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";

// PouchDB 9 emits checkpoint events on Replication, including Sync.pull and Sync.push.
// Its published TypeScript declarations do not describe this event surface.
type ObservationEmitter = {
    on(event: string, listener: (event?: unknown) => void): unknown;
    removeListener(event: string, listener: (event?: unknown) => void): unknown;
};
type Direction = "pull" | "push";
type MutableProgress = { -readonly [K in keyof ReplicationCheckpointProgress]: ReplicationCheckpointProgress[K] };
const PROGRESS_PUBLICATION_INTERVAL_MS = 200;

function asEmitter(value: unknown): ObservationEmitter | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    if (!("on" in value) || typeof value.on !== "function") return undefined;
    if (!("removeListener" in value) || typeof value.removeListener !== "function") return undefined;
    return value as ObservationEmitter;
}
function isSequence(value: unknown): value is string | number {
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Observe one handler without adding its high-volume checkpoint events to the replication inbox. */
export function observeReplicationProgress(
    handler: PouchDB.Replication.Sync<EntryDoc> | PouchDB.Replication.Replication<EntryDoc>,
    mode: "sync" | "pullOnly" | "pushOnly",
    phase: Exclude<CouchDBReplicationPhase, "idle">,
    signal: AbortSignal,
    publish: (progress: CouchDBReplicationProgress) => void
): { dispose(): void } {
    const progress: Partial<Record<Direction, MutableProgress>> = {};
    const detach: (() => void)[] = [];
    let timer: number | undefined;
    let dirty = false;
    let disposed = false;
    let currentPhase: CouchDBReplicationPhase = phase;

    const cancelTimer = () => {
        if (timer === undefined) return;
        compatGlobal.clearTimeout(timer);
        timer = undefined;
    };
    const flush = () => {
        cancelTimer();
        if (!dirty) return;
        dirty = false;
        publish({
            phase: currentPhase,
            ...(progress.pull ? { pull: { ...progress.pull } } : {}),
            ...(progress.push ? { push: { ...progress.push } } : {}),
        });
    };
    const schedule = () => {
        dirty = true;
        timer ??= compatGlobal.setTimeout(flush, PROGRESS_PUBLICATION_INTERVAL_MS);
    };
    const listen = (emitter: ObservationEmitter, event: string, listener: (event?: unknown) => void) => {
        emitter.on(event, listener);
        detach.push(() => emitter.removeListener(event, listener));
    };
    const observeDirection = (direction: Direction, emitter: ObservationEmitter | undefined) => {
        if (!emitter) return;
        const value: MutableProgress = { checkedChanges: 0, completedBatches: 0, checking: false };
        progress[direction] = value;
        listen(emitter, "checkpoint", (event) => {
            if (disposed || signal.aborted || typeof event !== "object" || event === null) return;
            if (
                "revs_diff" in event &&
                typeof event.revs_diff === "object" &&
                event.revs_diff !== null &&
                "id" in event.revs_diff &&
                typeof event.revs_diff.id === "string"
            ) {
                value.checkedChanges++;
                value.checking = true;
            } else if ("start_next_batch" in event && isSequence(event.start_next_batch)) {
                value.checking = true;
            } else if ("checkpoint" in event && isSequence(event.checkpoint)) {
                value.completedBatches++;
                value.lastSeq = event.checkpoint;
            } else {
                return;
            }
            schedule();
        });
        const stopChecking = () => {
            if (disposed || signal.aborted) return;
            if (value.checking) {
                value.checking = false;
                dirty = true;
            }
            flush();
        };
        // Transfer and pause are boundaries; publish pending values without waiting for the timer.
        listen(emitter, "change", stopChecking);
        listen(emitter, "paused", stopChecking);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancelTimer();
        for (const remove of detach) remove();
        signal.removeEventListener("abort", dispose);
        currentPhase = "idle";
        if (progress.pull) progress.pull.checking = false;
        if (progress.push) progress.push.checking = false;
        dirty = true;
        flush();
    };

    if (mode === "sync") {
        const duplex = handler as unknown as { pull?: unknown; push?: unknown };
        observeDirection("pull", asEmitter(duplex.pull));
        observeDirection("push", asEmitter(duplex.push));
    } else {
        observeDirection(mode === "pullOnly" ? "pull" : "push", asEmitter(handler));
    }
    const outer = asEmitter(handler);
    if (outer) {
        listen(outer, "complete", dispose);
        listen(outer, "error", dispose);
        listen(outer, "denied", dispose);
    }
    signal.addEventListener("abort", dispose, { once: true });
    dirty = true;
    if (signal.aborted) dispose();
    else flush();
    return { dispose };
}
