import { Porter, ClerkGroup, Clerk } from "octagonal-wheels/bureau/Clerk.js";
import { Inbox, InboxWithEvent } from "octagonal-wheels/bureau/Inbox.js";
import { PaceMaker } from "octagonal-wheels/bureau/PaceMaker.js";
import { globalSlipBoard } from "../bureau/bureau.ts";
import { TIMED_OUT_SIGNAL } from "octagonal-wheels/promises.js";
import { LOG_LEVEL_NOTICE, type DocumentID, type EntryLeaf } from "../common/types.ts";
import type { ChunkRetrievalResult, LiveSyncLocalDB } from "./LiveSyncLocalDB.ts";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger.js";

declare global {
    interface Slips extends LSSlips {
        "retrieve-chunk": ChunkRetrievalResult;
        "read-chunk": ChunkRetrievalResult;
    }
}

export class BatchReader {
    _db: LiveSyncLocalDB;

    get localDatabase() {
        return this._db.localDatabase;
    }
    get hashCaches() {
        return this._db.hashCaches;
    }
    get settings() {
        return this._db.settings;
    }
    get env() {
        return this._db.env;
    }
    constructor(db: LiveSyncLocalDB) {
        this._db = db;
    }
    requestChunkInbox = new Inbox<DocumentID>(2000);
    collectChunkBatch = new InboxWithEvent<DocumentID[]>(100);
    _porter = new Porter({ from: this.requestChunkInbox, to: this.collectChunkBatch, timeout: 30, maxSize: 50 });
    _readers = new ClerkGroup({
        assigned: this.collectChunkBatch,
        initialMemberCount: 3,
        name: "localChunkReader",
        instantiate(params) {
            return new Clerk(params);
        },
        job: async (item) => {
            const chunk = await this.localDatabase.allDocs({ keys: item, include_docs: true });
            for (const row of chunk.rows) {
                const isError = "error" in row || row.value.deleted;
                if (isError) {
                    globalSlipBoard.submit("read-chunk", row.key as unknown as DocumentID, {
                        _id: row.key as unknown as DocumentID,
                        error: "NOT_FOUND",
                    });
                } else {
                    const doc = row.doc as EntryLeaf;
                    this.hashCaches.set(doc._id, doc.data);
                    globalSlipBoard.submit("read-chunk", doc._id, doc);
                }
            }
        },
    });
    async readChunk(id: DocumentID, timeout?: number): Promise<ChunkRetrievalResult> {
        const cached = this.hashCaches.get(id);
        if (typeof cached === "string") {
            return Promise.resolve({ _id: id, data: cached, type: "leaf" });
        }
        const p = await globalSlipBoard.awaitNext("read-chunk", `${id}`, {
            onNotAwaited: () => void this.requestChunkInbox.post(id),
        });
        if (!p || ("error" in p && p.error === "NOT_FOUND")) {
            if (timeout) {
                // Wait for the chunk to be fetched
                const r = await globalSlipBoard.awaitNext("read-chunk", `${id}`, { timeout });
                if (r === TIMED_OUT_SIGNAL) {
                    return { _id: id, error: "TIMED_OUT" };
                }
                if (!r || "error" in r) {
                    return { _id: id, error: r?.error ?? "UNKNOWN ERROR" };
                }
                return r;
            } else {
                return { _id: id, error: "NOT_FOUND" };
            }
        }
        return p;
    }
}

export class ChunkCollector {
    _db: LiveSyncLocalDB;

    get localDatabase() {
        return this._db.localDatabase;
    }
    get hashCaches() {
        return this._db.hashCaches;
    }
    get settings() {
        return this._db.settings;
    }
    get env() {
        return this._db.env;
    }

    constructor(db: LiveSyncLocalDB) {
        this._db = db;
    }
    requestChunkInbox = new Inbox<DocumentID>(2000);
    collectChunkBatch = new InboxWithEvent<DocumentID[]>(100);
    requestFetchChunkInbox = new Inbox<DocumentID>(2000);
    fetchChunkBatch = new Inbox<DocumentID[]>(2000);

    retrieveChunk(id: DocumentID, timeout?: number): Promise<ChunkRetrievalResult> {
        const cached = this.hashCaches.get(id);
        if (typeof cached === "string") {
            return Promise.resolve({ _id: id, data: cached, type: "leaf" });
        }
        const p = globalSlipBoard
            .awaitNext("retrieve-chunk", `${id}`, {
                timeout,
                onNotAwaited: () => void this.requestChunkInbox.post(id),
            })
            .then((e) => (e === TIMED_OUT_SIGNAL ? { _id: id, error: "TIMED_OUT" } : e));
        return p;
    }

    async collectChunks(ids: string[], showResult = false, _waitForReady?: boolean): Promise<ChunkRetrievalResult[]> {
        if (this._paceMaker._interval !== this.settings.minimumIntervalOfReadChunksOnline) {
            this._paceMaker.changeInterval(this.settings.minimumIntervalOfReadChunksOnline);
        }
        await this._porterFetch.changeParams({ maxSize: this.settings.concurrencyOfReadChunksOnline });
        const result = await Promise.all(ids.map((e) => this.retrieveChunk(e as DocumentID)));
        const failed = result.filter((e) => "error" in e);
        if (failed.length > 0) {
            Logger(
                `Could not fetch chunks from the server. `,
                showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_VERBOSE,
                "fetch"
            );
        }
        // return result.map(e => ("error" in e) ? false : e) as (ChunkRetrievalResultSuccess | false)[];
        return result;
    }

    _porter = new Porter({ from: this.requestChunkInbox, to: this.collectChunkBatch, timeout: 100, maxSize: 50 });
    _collectors = new ClerkGroup({
        assigned: this.collectChunkBatch,
        initialMemberCount: 3,
        instantiate(params) {
            return new Clerk(params);
        },
        job: async (item) => {
            const chunk = await this.localDatabase.allDocs({ keys: item, include_docs: true });
            for (const row of chunk.rows) {
                if ("error" in row) {
                    await this.requestFetchChunkInbox.post(row.key as unknown as DocumentID);
                } else {
                    const doc = row.doc as EntryLeaf;
                    this.hashCaches.set(doc._id, doc.data);
                    globalSlipBoard.submit("retrieve-chunk", doc._id, doc);
                }
            }
        },
    });
    _porterFetch = new Porter({
        from: this.requestFetchChunkInbox,
        to: this.fetchChunkBatch,
        timeout: 25,
        maxSize: 100,
    });

    _paceMaker = new PaceMaker(300);
    _fetchers = new ClerkGroup({
        assigned: this.fetchChunkBatch,
        initialMemberCount: 3,
        instantiate: (params) => {
            const c = new Clerk(params);
            return c;
        },
        job: async (item) => {
            // Ensure interval between network requests
            await this._paceMaker.paced;
            const chunk = await this.env.$$getReplicator().fetchRemoteChunks(item, false);
            if (chunk) {
                chunk.forEach((e) => this.hashCaches.set(e._id, e.data));
                await this.localDatabase.bulkDocs(chunk, { new_edits: false });
                chunk.forEach((e) => globalSlipBoard.submit("retrieve-chunk", e._id, e));
            } else {
                item.forEach((id) =>
                    globalSlipBoard.submit("retrieve-chunk", id, { _id: id, error: "SERVER_OFFLINE" })
                );
            }
        },
    });
}
