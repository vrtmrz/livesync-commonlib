import { describe, expect, it, vi } from "vitest";
import { PouchDB } from "./pouchdb-http.ts";

type PurgeMultiParam = [docId: string, rev: string];
type PurgeMultiResult = {
    ok: true;
    deletedRevs: string[];
    documentWasRemovedCompletely: boolean;
};
type PurgeMultiValue = PurgeMultiResult | Error | string;
type PurgeMultiResults = Record<string, PurgeMultiValue>;
type PurgeMultiCallback = (error: unknown, result?: PurgeMultiResults) => void;
type PouchDBConstructor = (typeof import("./pouchdb-http.ts"))["PouchDB"];
type RevisionTree = {
    pos: number;
    ids: [hash: string, options: Record<string, unknown>, branches: unknown[]];
};
type PurgeHistoryEntry = { docId: string; rev: string; purgeSeq: number };
type PurgeHistoryDocument = {
    _id: string;
    _rev?: string;
    purgeSeq: number;
    purges: PurgeHistoryEntry[];
    [key: string]: unknown;
};
type FakeDatabase = {
    _closed?: boolean;
    _destroyed?: boolean;
    adapter: string;
    name: string;
    purged_infos_limit: number;
    taskqueue: { isReady: boolean };
    _getRevisionTree: (
        this: FakeDatabase,
        docId: string,
        callback: (error: Error | null, revs?: RevisionTree[]) => void
    ) => void;
    _purge?: (
        this: FakeDatabase,
        docId: string,
        path: string[],
        callback: (error: Error | null, result?: PurgeMultiResult) => void
    ) => void;
    get: (this: FakeDatabase, id: string) => Promise<PurgeHistoryDocument>;
    put: (this: FakeDatabase, doc: PurgeHistoryDocument) => Promise<unknown>;
};
type PurgeMultiMethod = (
    this: FakeDatabase,
    docs: PurgeMultiParam[],
    callback?: PurgeMultiCallback
) => Promise<PurgeMultiResults>;
type RevisionOutcome = { error?: Error; missing?: boolean };
type PurgeOutcome = { error?: Error; result?: PurgeMultiResult };
type FakeDatabaseOptions = {
    revisionOutcomes?: Record<string, RevisionOutcome>;
    purgeOutcomes?: Record<string, PurgeOutcome>;
    purgeHistory?: PurgeHistoryDocument;
    purgeHistoryReadError?: unknown;
    purgeHistoryWriteError?: unknown;
    purgedInfosLimit?: number;
};
const purgeMulti = (PouchDB.prototype as unknown as { purgeMulti: PurgeMultiMethod }).purgeMulti;

function createFakeDatabase(PouchDB: PouchDBConstructor, docs: PurgeMultiParam[], options: FakeDatabaseOptions = {}) {
    const db = Object.create(PouchDB.prototype) as FakeDatabase;
    const events: string[] = [];
    const receivers: unknown[] = [];
    let activePurges = 0;
    let maximumActivePurges = 0;

    const _getRevisionTree = vi.fn(function (
        this: FakeDatabase,
        docId: string,
        callback: (error: Error | null, revs?: RevisionTree[]) => void
    ) {
        receivers.push(this);
        events.push(`tree:${docId}`);
        const outcome = options.revisionOutcomes?.[docId];
        if (outcome?.error) {
            return callback(outcome.error, []);
        }
        if (outcome?.missing) {
            return callback(null, undefined);
        }

        const requestedRev = docs.find(([id]) => id === docId)?.[1] ?? "1-revision";
        const separator = requestedRev.indexOf("-");
        const tree: RevisionTree[] = [
            {
                pos: Number(requestedRev.slice(0, separator)),
                ids: [requestedRev.slice(separator + 1), {}, []],
            },
        ];
        return callback(null, tree);
    });

    const _purge = vi.fn(function (
        this: FakeDatabase,
        docId: string,
        path: string[],
        callback: (error: Error | null, result?: PurgeMultiResult) => void
    ) {
        receivers.push(this);
        events.push(`purge:${docId}`);
        activePurges++;
        maximumActivePurges = Math.max(maximumActivePurges, activePurges);
        const outcome = options.purgeOutcomes?.[docId];
        setTimeout(() => {
            activePurges--;
            if (outcome?.error) {
                return callback(outcome.error);
            }
            return callback(
                null,
                outcome?.result ?? {
                    ok: true,
                    deletedRevs: [path[0] ?? ""],
                    documentWasRemovedCompletely: false,
                }
            );
        }, 0);
    });

    const get = vi.fn(function (this: FakeDatabase, id: string) {
        receivers.push(this);
        events.push(`get:${id}`);
        if ("purgeHistoryReadError" in options) {
            return Promise.reject(options.purgeHistoryReadError);
        }
        return Promise.resolve(
            options.purgeHistory ?? {
                _id: "_local/purges",
                purges: [],
                purgeSeq: 0,
            }
        );
    });

    const put = vi.fn(function (this: FakeDatabase, doc: PurgeHistoryDocument) {
        receivers.push(this);
        events.push(`put:${doc._id}`);
        if ("purgeHistoryWriteError" in options) {
            return Promise.reject(options.purgeHistoryWriteError);
        }
        return Promise.resolve({ ok: true });
    });

    Object.assign(db, {
        adapter: "fake",
        name: "purge-multi-test",
        purged_infos_limit: options.purgedInfosLimit ?? 50,
        taskqueue: { isReady: true },
        _getRevisionTree,
        _purge,
        get,
        put,
    });

    return {
        db,
        events,
        receivers,
        get maximumActivePurges() {
            return maximumActivePurges;
        },
    };
}

describe("installed HTTP purgeMulti", () => {
    it("purges serially on the receiver and calls back after writing purge history", async () => {
        const docs: PurgeMultiParam[] = [
            ["first", "1-first"],
            ["second", "1-second"],
        ];
        const history: PurgeHistoryDocument = { _id: "_local/purges", _rev: "1-history", purges: [], purgeSeq: 0 };
        const fixture = createFakeDatabase(PouchDB, docs, { purgeHistory: history });
        const callback = vi.fn(() => fixture.events.push("callback"));
        const expected: PurgeMultiResults = {
            first: { ok: true, deletedRevs: ["1-first"], documentWasRemovedCompletely: false },
            second: { ok: true, deletedRevs: ["1-second"], documentWasRemovedCompletely: false },
        };

        await expect(purgeMulti.call(fixture.db, docs, callback)).resolves.toEqual(expected);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(null, expected);
        expect(fixture.maximumActivePurges).toBe(1);
        expect(fixture.events).toEqual([
            "tree:first",
            "purge:first",
            "tree:second",
            "purge:second",
            "get:_local/purges",
            "put:_local/purges",
            "callback",
        ]);
        expect(fixture.receivers.every((receiver) => receiver === fixture.db)).toBe(true);
        expect(history).toEqual({
            _id: "_local/purges",
            _rev: "1-history",
            purges: [
                { docId: "first", rev: "1-first", purgeSeq: 1 },
                { docId: "second", rev: "1-second", purgeSeq: 2 },
            ],
            purgeSeq: 2,
        });
    });

    it("returns mixed outcomes and retains only successful purges within the history limit", async () => {
        const docs: PurgeMultiParam[] = [
            ["success-one", "1-success-one"],
            ["tree-error", "1-tree-error"],
            ["missing", "1-missing"],
            ["success-two", "1-success-two"],
            ["purge-error", "1-purge-error"],
        ];
        const treeError = new Error("revision tree unavailable");
        const purgeError = new Error("purge failed");
        const history: PurgeHistoryDocument = {
            _id: "_local/purges",
            _rev: "2-history",
            retained: "keep",
            purges: [{ docId: "old", rev: "1-old", purgeSeq: 4 }],
            purgeSeq: 4,
        };
        const fixture = createFakeDatabase(PouchDB, docs, {
            revisionOutcomes: { "tree-error": { error: treeError }, missing: { missing: true } },
            purgeOutcomes: { "purge-error": { error: purgeError } },
            purgeHistory: history,
            purgedInfosLimit: 2,
        });

        const result = await purgeMulti.call(fixture.db, docs);

        expect(result).toMatchObject({
            "success-one": { ok: true, deletedRevs: ["1-success-one"] },
            "tree-error": treeError,
            missing: { status: 404 },
            "success-two": { ok: true, deletedRevs: ["1-success-two"] },
            "purge-error": purgeError,
        });
        expect(history).toEqual({
            _id: "_local/purges",
            _rev: "2-history",
            retained: "keep",
            purges: [
                { docId: "success-one", rev: "1-success-one", purgeSeq: 5 },
                { docId: "success-two", rev: "1-success-two", purgeSeq: 6 },
            ],
            purgeSeq: 6,
        });
    });

    it("starts purge history at zero when its document is missing", async () => {
        const docs: PurgeMultiParam[] = [
            ["first", "1-first"],
            ["second", "1-second"],
        ];
        const fixture = createFakeDatabase(PouchDB, docs, { purgeHistoryReadError: { status: 404 } });

        await purgeMulti.call(fixture.db, docs);

        expect(fixture.db.put).toHaveBeenCalledWith({
            _id: "_local/purges",
            purges: [
                { docId: "first", rev: "1-first", purgeSeq: 0 },
                { docId: "second", rev: "1-second", purgeSeq: 1 },
            ],
            purgeSeq: 2,
        });
    });

    it("reports adapters without purge support", async () => {
        const docs: PurgeMultiParam[] = [["first", "1-first"]];
        const fixture = createFakeDatabase(PouchDB, docs);
        delete fixture.db._purge;

        await expect(purgeMulti.call(fixture.db, docs)).rejects.toMatchObject({
            reason: "Purge is not implemented in the fake adapter.",
        });
    });

    it("returns purge-history read errors", async () => {
        const docs: PurgeMultiParam[] = [["first", "1-first"]];
        const readError = new Error("purge history read failed");
        const fixture = createFakeDatabase(PouchDB, docs, { purgeHistoryReadError: readError });

        await expect(purgeMulti.call(fixture.db, docs)).rejects.toBe(readError);
    });

    it("returns purge-history write errors", async () => {
        const docs: PurgeMultiParam[] = [["first", "1-first"]];
        const writeError = new Error("purge history write failed");
        const fixture = createFakeDatabase(PouchDB, docs, {
            purgeHistory: { _id: "_local/purges", purges: [], purgeSeq: 0 },
            purgeHistoryWriteError: writeError,
        });

        await expect(purgeMulti.call(fixture.db, docs)).rejects.toBe(writeError);
    });
});
