import type { EntryDoc, NewEntry, PlainEntry } from "@lib/common/types.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { LEVEL_INFO, LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { bindContext } from "octagonal-wheels/context";
import { withScope, type Scope } from "octagonal-wheels/resource/scope";
import type { MetaEntry, ReadyEntry } from "./DirectFileManipulatorV2.ts";

export interface DirectFileWatchState {
    watching: boolean;
    changes: PouchDB.Core.Changes<EntryDoc> | undefined;
    since: string;
}

export interface DirectFileWatchHost {
    readonly state: DirectFileWatchState;
    openChanges(since: string): PouchDB.Core.Changes<EntryDoc>;
    readDocument(doc: MetaEntry): Promise<ReadyEntry>;
}

type FileCallback = (doc: ReadyEntry, seq?: string | number) => Promise<unknown> | void;
type SelectionCallback = (doc: MetaEntry) => boolean;
type CheckpointCallback = (seq: string | number) => Promise<void> | void;
type Position = { order: number; seq: string | number };
type Timer = number | ReturnType<typeof setTimeout>;
type Pending = {
    id: string;
    doc: EntryDoc | undefined;
    seq: string | number;
    before: Position;
    running: boolean;
    failures: number;
    due: number;
};

/** Work already started by a retired watch remains owned until it settles. */
interface OwnerContext {
    readonly host: DirectFileWatchHost;
    session?: WatchContext;
    inFlight: number;
    readonly delivering: Set<string>;
    checkpointPending?: Promise<void>;
}

/** Admission, retries, and feed positions belong to one watch session. */
interface WatchContext {
    readonly owner: OwnerContext;
    readonly callback: FileCallback;
    readonly checkIsInterested?: SelectionCallback;
    readonly onCheckpoint?: CheckpointCallback;
    readonly pending: Map<string, Pending>;
    latest: Position;
    durableOrder: number;
    connection: number;
    connected: boolean;
    retryTimer?: Timer;
    reconnectTimer?: Timer;
    checkpointTask?: Promise<void>;
    checkpointFailures: number;
    checkpointDue: number;
}

interface ConnectionContext {
    readonly session: WatchContext;
    readonly epoch: number;
}
interface FileContext extends ConnectionContext {
    readonly item: Pending;
}
interface DeliveryContext extends FileContext {
    readonly ready: ReadyEntry;
}
interface CheckpointContext extends ConnectionContext {
    readonly position: Position;
    readonly previous?: Promise<void>;
    task?: Promise<void>;
}
interface WatchChange {
    readonly id?: string;
    readonly seq: string | number;
    readonly doc?: EntryDoc;
}

export function isNoteEntry(doc: EntryDoc | false | undefined): doc is NewEntry | PlainEntry {
    return !!doc && (doc.type == "newnote" || doc.type == "plain");
}

function isActive(session: WatchContext): boolean {
    return session.owner.session === session;
}

function isCurrent({ session, item, epoch }: FileContext): boolean {
    return (
        isActive(session) && session.connected && session.connection === epoch && session.pending.get(item.id) === item
    );
}

function retryDelay(failures: number): number {
    return Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
}

function documentPath(doc: EntryDoc | undefined) {
    return doc && "path" in doc ? doc.path : undefined;
}

function safePosition(session: WatchContext): Position {
    // Map insertion order retains each document's first unresolved obligation.
    // Completed rows need only the latest position, even behind a long-lived gap.
    return session.pending.values().next().value?.before ?? session.latest;
}

function cancelRetry(session: WatchContext): void {
    if (session.retryTimer !== undefined) clearTimeout(session.retryTimer);
    session.retryTimer = undefined;
}

function cancelFeed(session: WatchContext): void {
    const state = session.owner.host.state;
    const changes = state.changes;
    state.changes = undefined;
    changes?.cancel();
}

function stop(session: WatchContext): void {
    session.owner.host.state.watching = false;
    session.connected = false;
    session.connection++;
    cancelRetry(session);
    if (session.reconnectTimer !== undefined) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
    session.pending.clear();
    session.owner.session = undefined;
    cancelFeed(session);
}

function schedule(session: WatchContext): void {
    cancelRetry(session);
    if (!isActive(session) || !session.connected) return;
    let next = Infinity;
    if (session.owner.inFlight < 4) {
        for (const item of session.pending.values()) {
            if (!item.running && !session.owner.delivering.has(item.id)) next = Math.min(next, item.due);
        }
    }
    if (!session.checkpointTask && safePosition(session).order > session.durableOrder) {
        next = Math.min(next, session.checkpointDue);
    }
    if (next !== Infinity) {
        session.retryTimer = compatGlobal.setTimeout(bindContext(session, retry), Math.max(0, next - Date.now()));
    }
}

function retry(session: WatchContext): void {
    session.retryTimer = undefined;
    void pump(session);
}

async function persistCheckpoint({ session, position, epoch, previous }: CheckpointContext): Promise<void> {
    // A retired watch's host persistence must finish before a replacement submits its checkpoint.
    if (previous) await previous;
    if (!isActive(session) || session.connection !== epoch) return;
    try {
        await session.onCheckpoint?.(position.seq);
        if (!isActive(session)) return;
        session.owner.host.state.since = String(position.seq);
        if (session.connection === epoch) session.durableOrder = position.order;
        session.checkpointFailures = 0;
        session.checkpointDue = 0;
    } catch (ex) {
        Logger(`WATCH: CHECKPOINT FAILED`, LEVEL_INFO, "watch");
        Logger(ex, LEVEL_VERBOSE, "watch");
        if (isActive(session) && session.connection === epoch) {
            session.checkpointDue = Date.now() + retryDelay(++session.checkpointFailures);
        }
    }
}

function finishCheckpoint({ session, task }: CheckpointContext): void {
    session.checkpointTask = undefined;
    if (session.owner.checkpointPending === task) session.owner.checkpointPending = undefined;
    if (isActive(session)) {
        void flushCheckpoint(session);
        schedule(session);
    }
}

function flushCheckpoint(session: WatchContext): Promise<void> {
    if (session.checkpointTask) return session.checkpointTask;
    if (!isActive(session) || !session.connected || Date.now() < session.checkpointDue) return Promise.resolve();
    const position = safePosition(session);
    if (position.order <= session.durableOrder) return Promise.resolve();
    const context: CheckpointContext = {
        session,
        position,
        epoch: session.connection,
        previous: session.owner.checkpointPending,
    };
    const task = persistCheckpoint(context).finally(bindContext(context, finishCheckpoint));
    context.task = task;
    session.checkpointTask = task;
    session.owner.checkpointPending = task;
    return task;
}

function releaseDelivery({ session, item }: DeliveryContext): void {
    session.owner.delivering.delete(item.id);
}

async function deliver(scope: Scope<DeliveryContext>): Promise<void> {
    const { session, item, ready } = scope.value;
    session.owner.delivering.add(item.id);
    scope.defer(bindContext(scope.value, releaseDelivery));
    await session.callback(ready, item.seq);
}

async function processDocument(context: FileContext): Promise<void> {
    const { session, item } = context;
    let loading = true;
    try {
        const doc = item.doc;
        if (isNoteEntry(doc) && (!session.checkIsInterested || session.checkIsInterested(doc))) {
            Logger(`WATCH: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
            const ready: ReadyEntry =
                doc.deleted || doc._deleted ? { ...doc, data: [] } : await session.owner.host.readDocument(doc);
            if (!isCurrent(context)) return;
            loading = false;
            await withScope({ ...context, ready }, deliver);
            if (!isCurrent(context)) return;
            Logger(`WATCH: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
        }
        if (!isCurrent(context)) return;
        session.pending.delete(item.id);
        void flushCheckpoint(session);
    } catch (ex) {
        if (!isCurrent(context)) return;
        Logger(
            loading ? `WATCH: DOCUMENT LOAD FAILED: ${documentPath(item.doc)}` : `WATCH: PROCESS FAILED`,
            LEVEL_INFO,
            "watch"
        );
        Logger(ex, LEVEL_VERBOSE, "watch");
        item.due = Date.now() + retryDelay(++item.failures);
    }
}

function releaseFileOperation({ session, item }: FileContext): void {
    item.running = false;
    session.owner.inFlight--;
    // Releasing an uncancellable read also wakes a replacement watch.
    if (session.owner.session) void pump(session.owner.session);
}

async function processFileOperation(scope: Scope<FileContext>): Promise<void> {
    scope.defer(bindContext(scope.value, releaseFileOperation));
    await processDocument(scope.value);
}

function pump(session: WatchContext): Promise<void> {
    if (!isActive(session) || !session.connected) return Promise.resolve();
    const tasks: Promise<void>[] = [];
    for (const item of session.pending.values()) {
        if (session.owner.inFlight >= 4) break;
        if (item.running || item.due > Date.now() || session.owner.delivering.has(item.id)) continue;
        item.running = true;
        session.owner.inFlight++;
        tasks.push(withScope({ session, item, epoch: session.connection }, processFileOperation));
    }
    void flushCheckpoint(session);
    schedule(session);
    return Promise.all(tasks).then((): void => {});
}

async function reconnectAfterCheckpoint(session: WatchContext): Promise<void> {
    session.reconnectTimer = undefined;
    if (session.checkpointTask) await session.checkpointTask;
    if (isActive(session)) connect(session);
}

function reconnect({ session, epoch }: ConnectionContext): void {
    if (!isActive(session) || !session.connected || session.connection !== epoch) return;
    session.owner.host.state.watching = false;
    session.connected = false;
    session.connection++;
    cancelRetry(session);
    session.pending.clear();
    cancelFeed(session);
    Logger(`WATCH: CONNECTION HAS BEEN CLOSED, RECONNECTING...`, LEVEL_INFO, "watch");
    session.reconnectTimer = compatGlobal.setTimeout(bindContext(session, reconnectAfterCheckpoint), 10_000);
}

async function receiveChange({ session, epoch }: ConnectionContext, change: WatchChange): Promise<void> {
    if (!isActive(session) || !session.connected || session.connection !== epoch) return;
    const before = session.latest;
    session.latest = { order: before.order + 1, seq: change.seq };
    const id = change.id ?? change.doc?._id ?? documentPath(change.doc) ?? `row:${session.latest.order}`;
    const previous = session.pending.get(id);
    // Bare tombstones can reuse only metadata already pending in this session.
    const doc = change.doc?._deleted && previous?.doc ? { ...previous.doc, ...change.doc } : change.doc;
    session.pending.set(id, {
        id,
        doc,
        seq: change.seq,
        before: previous?.before ?? before,
        running: false,
        failures: 0,
        due: 0,
    });
    await pump(session);
}

function receiveError(context: ConnectionContext, error: unknown): void {
    if (!isActive(context.session) || context.session.connection !== context.epoch) return;
    Logger(`WATCH: ERROR: `, LEVEL_INFO, "watch");
    Logger(error, LEVEL_VERBOSE, "watch");
    reconnect(context);
}

function connect(session: WatchContext): void {
    if (!isActive(session)) return;
    const context: ConnectionContext = { session, epoch: ++session.connection };
    const { state } = session.owner.host;
    state.watching = true;
    session.connected = true;
    session.latest = { order: 0, seq: state.since };
    session.durableOrder = 0;
    session.checkpointFailures = 0;
    session.checkpointDue = 0;
    try {
        state.changes = session.owner.host
            .openChanges(state.since)
            .on("change", bindContext(context, receiveChange))
            .on("complete", bindContext(context, reconnect))
            .on("error", bindContext(context, receiveError));
    } catch (ex) {
        Logger(`WATCH: ERROR: `, LEVEL_INFO, "watch");
        Logger(ex, LEVEL_VERBOSE, "watch");
        reconnect(context);
    }
}

/** Own watch sessions and work which remains in flight across stop and restart. */
export class DirectFileWatchOwner {
    private readonly context: OwnerContext;

    constructor(host: DirectFileWatchHost) {
        this.context = { host, inFlight: 0, delivering: new Set<string>() };
    }

    beginWatch(callback: FileCallback, checkIsInterested?: SelectionCallback, onCheckpoint?: CheckpointCallback) {
        if (this.context.session || this.context.host.state.watching) return false;
        const session: WatchContext = {
            owner: this.context,
            callback,
            checkIsInterested,
            onCheckpoint,
            pending: new Map(),
            latest: { order: 0, seq: this.context.host.state.since },
            durableOrder: 0,
            connection: 0,
            connected: false,
            checkpointFailures: 0,
            checkpointDue: 0,
        };
        this.context.session = session;
        connect(session);
    }

    endWatch(): void {
        if (this.context.session) stop(this.context.session);
    }
}
