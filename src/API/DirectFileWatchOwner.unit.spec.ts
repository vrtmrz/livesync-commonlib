import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { DirectFileWatchOwner, type DirectFileWatchHost, type DirectFileWatchState } from "./DirectFileWatchOwner.ts";
import type { MetaEntry } from "./DirectFileManipulatorV2.ts";

const loggerCalls = vi.hoisted(() => vi.fn());
vi.mock("octagonal-wheels/common/logger", async (importOriginal) => ({
    ...(await importOriginal<typeof import("octagonal-wheels/common/logger")>()),
    Logger: loggerCalls,
}));

describe("DirectFileWatchOwner", () => {
    const watchers: DirectFileWatchOwner[] = [];
    const note = (id: string, extra: Record<string, unknown> = {}) =>
        ({
            _id: id,
            _rev: "1-first",
            path: id,
            type: "plain",
            children: ["h:body"],
            ctime: 1,
            mtime: 2,
            size: 4,
            ...extra,
        }) as MetaEntry;
    const fixture = (getByMeta = vi.fn(async (doc: MetaEntry) => ({ ...doc, data: ["body"] }))) => {
        const feeds: Array<{ on: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = [];
        const openChanges = vi.fn((_since: string) => {
            const feed = { on: vi.fn().mockReturnThis(), cancel: vi.fn() };
            feeds.push(feed);
            return feed;
        });
        const state: DirectFileWatchState = { watching: false, changes: undefined, since: "start" };
        const owner = new DirectFileWatchOwner({
            state,
            openChanges: openChanges as unknown as DirectFileWatchHost["openChanges"],
            readDocument: getByMeta,
        });
        watchers.push(owner);
        const emit = (event: string, value?: unknown) => {
            const handler = feeds.at(-1)?.on.mock.calls.find(([name]) => name === event)?.[1];
            if (!handler) throw new Error(`Missing ${event} handler`);
            return handler(value);
        };
        return {
            owner,
            state,
            openChanges,
            getByMeta,
            feeds,
            emit,
            change: (doc: MetaEntry, seq: string | number) => emit("change", { id: doc._id, doc, seq }),
        };
    };
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        for (const watcher of watchers.splice(0)) watcher.endWatch();
        vi.useRealTimers();
    });

    it.each(["load", "selection", "delivery", "checkpoint"] as const)(
        "contains a synchronous %s failure and retries without changing the error",
        async (stage) => {
            const failure = new Error(`${stage} unavailable`);
            let fail = true;
            const rejectOnce = (current: typeof stage) => {
                if (stage === current && fail) {
                    fail = false;
                    throw failure;
                }
            };
            const f = fixture(
                vi.fn((doc: MetaEntry) => {
                    rejectOnce("load");
                    return Promise.resolve({ ...doc, data: ["body"] });
                })
            );
            const callback = vi.fn(() => rejectOnce("delivery"));
            const selection = vi.fn(() => {
                rejectOnce("selection");
                return true;
            });
            const checkpoint = vi.fn(() => rejectOnce("checkpoint"));
            loggerCalls.mockClear();
            f.owner.beginWatch(callback, selection, checkpoint);

            await expect(f.change(note("retry.md"), "retry-token")).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.state.since).toBe("start");
            expect(loggerCalls).toHaveBeenCalledWith(failure, expect.anything(), "watch");

            await vi.advanceTimersByTimeAsync(1_000);
            expect(f.state.since).toBe("retry-token");
            expect(callback).toHaveBeenCalledTimes(stage === "delivery" ? 2 : 1);
            expect(checkpoint).toHaveBeenCalledTimes(stage === "checkpoint" ? 2 : 1);
        }
    );

    it("contains a synchronous feed-opening failure and reconnects", async () => {
        const f = fixture();
        const failure = new Error("feed unavailable");
        f.openChanges.mockImplementationOnce(() => {
            throw failure;
        });
        loggerCalls.mockClear();

        expect(() => f.owner.beginWatch(vi.fn())).not.toThrow();
        expect(f.state.watching).toBe(false);
        expect(loggerCalls).toHaveBeenCalledWith(failure, expect.anything(), "watch");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.openChanges).toHaveBeenCalledTimes(2);
        expect(f.state.watching).toBe(true);
    });

    it("preserves a synchronous feed-cancellation failure after retiring the watch", () => {
        const f = fixture();
        const failure = new Error("feed cancellation failed");
        f.owner.beginWatch(vi.fn());
        f.feeds[0].cancel.mockImplementationOnce(() => {
            throw failure;
        });

        expect(() => f.owner.endWatch()).toThrow(failure);
        expect(f.state.watching).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(() => f.owner.beginWatch(vi.fn())).not.toThrow();
        expect(f.openChanges).toHaveBeenCalledTimes(2);
    });

    it("keeps delivery ownership independent between direct clients", async () => {
        const first = fixture();
        const second = fixture();
        const acknowledgement = promiseWithResolvers<void>();
        const firstCallback = vi.fn(() => acknowledgement.promise);
        const secondCallback = vi.fn();
        first.owner.beginWatch(firstCallback);
        second.owner.beginWatch(secondCallback);
        try {
            void first.change(note("same.md"), "first");
            await vi.advanceTimersByTimeAsync(0);
            await second.change(note("same.md"), "second");
            expect(firstCallback).toHaveBeenCalledOnce();
            expect(secondCallback).toHaveBeenCalledOnce();
            expect(first.state.since).toBe("start");
            expect(second.state.since).toBe("second");
        } finally {
            acknowledgement.resolve();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(first.state.since).toBe("first");
    });

    it("keeps an opaque checkpoint before an unreadable file while unrelated files continue", async () => {
        const first = note("late.md");
        let readable = false;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc._id === first._id && !readable) throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.owner.beginWatch(callback, undefined, checkpoint);
        await f.change(first, "z-opaque");
        await f.change(note("available.md"), "a-opaque");
        expect(callback.mock.calls.map(([doc]) => doc.path)).toEqual(["available.md"]);
        expect(f.state.since).toBe("start");
        expect(checkpoint).not.toHaveBeenCalled();
        readable = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(callback.mock.calls.map(([doc]) => doc.path)).toEqual(["available.md", "late.md"]);
        expect(checkpoint).toHaveBeenLastCalledWith("a-opaque");
        expect(f.state.since).toBe("a-opaque");
    });

    it("retries a rejected consumer acknowledgement without blocking unrelated files", async () => {
        const f = fixture();
        const callback = vi.fn().mockRejectedValueOnce(new Error("consumer unavailable"));
        const checkpoint = vi.fn();
        f.owner.beginWatch(callback, undefined, checkpoint);
        await f.change(note("retry.md"), 7);
        await f.change(note("other.md"), "later-token");
        expect(callback).toHaveBeenCalledTimes(2);
        expect(f.state.since).toBe("start");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(callback).toHaveBeenCalledTimes(3);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ path: "retry.md" }), 7);
        expect(f.state.since).toBe("later-token");
    });

    it("retries failed checkpoint persistence before advancing since", async () => {
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn().mockRejectedValueOnce(new Error("storage unavailable"));
        f.owner.beginWatch(callback, undefined, checkpoint);
        await f.change(note("one.md"), 9);
        expect(callback).toHaveBeenCalledOnce();
        expect(f.state.since).toBe("start");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(checkpoint.mock.calls).toEqual([[9], [9]]);
        expect(f.state.since).toBe("9");
        expect(callback).toHaveBeenCalledOnce();
    });

    it("retains a superseded file's original gap until its replacement is acknowledged", async () => {
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc._rev === "1-missing") throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        let acceptReplacement = false;
        const callback = vi.fn(async (doc: MetaEntry) => {
            if (doc._rev === "2-replacement" && !acceptReplacement) throw new Error("consumer unavailable");
        });
        f.owner.beginWatch(callback);
        await f.change(note("same.md", { _rev: "1-missing" }), "gap");
        await f.change(note("other.md"), "between");
        await f.change(note("same.md", { _rev: "2-replacement" }), "replacement");
        expect(f.state.since).toBe("start");
        acceptReplacement = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.state.since).toBe("replacement");
        expect(callback.mock.calls.filter(([doc]) => doc._rev === "1-missing")).toEqual([]);
    });

    it.each([{ deleted: true }, { _deleted: true }])(
        "delivers deletion metadata without loading chunks: %j",
        async (deleted) => {
            const f = fixture(vi.fn().mockRejectedValue(new Error("missing deleted chunks")));
            const callback = vi.fn();
            f.owner.beginWatch(callback);
            await f.change(note("deleted.md", deleted), "deleted");
            expect(f.getByMeta).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ...deleted, data: [] }), "deleted");
            expect(f.state.since).toBe("deleted");
        }
    );

    it("uses pending metadata to deliver a bare tombstone and fences the old read", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(vi.fn(() => oldRead.promise));
        const callback = vi.fn();
        f.owner.beginWatch(callback);
        const old = note("deleted.md");
        void f.change(old, "old");
        await f.change({ _id: old._id, _rev: "2-deleted", _deleted: true } as MetaEntry, "deleted");
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({ path: "deleted.md", _deleted: true, data: [] }),
            "deleted"
        );
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback).toHaveBeenCalledOnce();
        expect(f.state.since).toBe("deleted");
    });

    it("acknowledges ignored rows without loading their bodies", async () => {
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.owner.beginWatch(callback, (doc) => doc.path !== "excluded.md", checkpoint);
        await f.change(note("control", { type: "versioninfo" }), "control-token");
        await f.change(note("excluded.md"), "excluded-token");
        expect(f.getByMeta).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(checkpoint).toHaveBeenLastCalledWith("excluded-token");
        expect(f.state.since).toBe("excluded-token");
    });

    it("bounds simultaneous body loads and eventually processes every queued document", async () => {
        const loads: Array<() => void> = [];
        let active = 0;
        let maximum = 0;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                active++;
                maximum = Math.max(maximum, active);
                await new Promise<void>((resolve) => loads.push(resolve));
                active--;
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        f.owner.beginWatch(callback);
        for (let i = 0; i < 40; i++) void f.change(note(`note-${i}.md`), `token-${i}`);
        expect(maximum).toBeLessThanOrEqual(4);
        for (let i = 0; i < 40; i++) {
            const release = loads.shift();
            expect(release).toBeTypeOf("function");
            release!();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(callback).toHaveBeenCalledTimes(40);
        expect(f.state.since).toBe("token-39");
    });

    it("continues through many completed rows behind one gap and checkpoints their final position", async () => {
        let readable = false;
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc.path === "gap.md" && !readable) throw new Error("chunk unavailable");
                return { ...doc, data: ["body"] };
            })
        );
        const callback = vi.fn();
        const checkpoint = vi.fn();
        f.owner.beginWatch(callback, undefined, checkpoint);
        await f.change(note("gap.md"), "gap");
        for (let i = 0; i < 5_000; i++) await f.change(note(`note-${i}.md`), `token-${i}`);
        expect(callback).toHaveBeenCalledTimes(5_000);
        expect(checkpoint).not.toHaveBeenCalled();
        readable = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(checkpoint.mock.calls).toEqual([["token-4999"]]);
        expect(f.state.since).toBe("token-4999");
    });

    it("cancels retry and reconnect timers when stopped", async () => {
        const f = fixture(vi.fn().mockRejectedValue(new Error("chunk unavailable")));
        f.owner.beginWatch(vi.fn());
        await f.change(note("gap.md"), "gap");
        f.emit("error", new Error("connection lost"));
        f.owner.endWatch();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.openChanges).toHaveBeenCalledOnce();
        expect(f.getByMeta).toHaveBeenCalledOnce();
        expect(f.state.watching).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("fences a stopped session's late read after a new watch starts", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(
            vi
                .fn()
                .mockImplementationOnce(() => oldRead.promise)
                .mockImplementation(async (doc: MetaEntry) => ({ ...doc, data: ["current"] }))
        );
        const oldCallback = vi.fn();
        const currentCallback = vi.fn();
        f.owner.beginWatch(oldCallback);
        const old = note("old.md");
        void f.change(old, "old");
        f.owner.endWatch();
        f.owner.beginWatch(currentCallback);
        await f.change(note("current.md"), "current");
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).not.toHaveBeenCalled();
        expect(currentCallback).toHaveBeenCalledOnce();
        expect(f.state.since).toBe("current");
    });

    it("reconnects from the persisted checkpoint and fences reads from the failed connection", async () => {
        const oldRead = promiseWithResolvers<any>();
        const f = fixture(
            vi
                .fn()
                .mockImplementationOnce(() => oldRead.promise)
                .mockImplementation(async (doc: MetaEntry) => ({ ...doc, data: ["current"] }))
        );
        const callback = vi.fn();
        f.owner.beginWatch(callback);
        const old = note("old.md");
        void f.change(old, "gap");
        await f.change(note("other.md"), "later");
        f.emit("error", new Error("connection lost"));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.openChanges).toHaveBeenLastCalledWith("start");
        await f.change(note("old.md", { _rev: "2-current" }), "replayed");
        oldRead.resolve({ ...old, data: ["stale"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback.mock.calls.map(([doc]) => doc._rev)).toEqual(["1-first", "2-current"]);
        expect(f.state.since).toBe("replayed");
    });

    it("advances only to the completed prefix before the earliest unresolved document", async () => {
        const gap = promiseWithResolvers<any>();
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                if (doc.path === "gap.md") return gap.promise;
                return { ...doc, data: ["body"] };
            })
        );
        const checkpoint = vi.fn();
        f.owner.beginWatch(vi.fn(), undefined, checkpoint);
        await f.change(note("prefix.md"), "z-prefix");
        void f.change(note("gap.md"), "m-gap");
        await f.change(note("suffix.md"), "a-suffix");
        expect(checkpoint.mock.calls).toEqual([["z-prefix"]]);
        expect(f.state.since).toBe("z-prefix");
        gap.resolve({ ...note("gap.md"), data: ["ready"] });
        await vi.advanceTimersByTimeAsync(0);
        expect(checkpoint.mock.calls).toEqual([["z-prefix"], ["a-suffix"]]);
    });

    it("caps exponential retry delays while the file stays unavailable", async () => {
        const attempts: number[] = [];
        const f = fixture(
            vi.fn(async () => {
                attempts.push(Date.now());
                throw new Error("chunk unavailable");
            })
        );
        f.owner.beginWatch(vi.fn());
        await f.change(note("gap.md"), "gap");
        await vi.advanceTimersByTimeAsync(121_000);
        expect(attempts.slice(1).map((time, i) => time - attempts[i])).toEqual([
            1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
        ]);
        expect(f.state.since).toBe("start");
    });

    it("keeps unknown bare tombstones ignored when their file metadata is unavailable", async () => {
        const f = fixture();
        const callback = vi.fn();
        f.owner.beginWatch(callback);
        await f.change({ _id: "f:unknown", _rev: "2-deleted", _deleted: true } as MetaEntry, "deleted");
        expect(f.getByMeta).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(f.state.since).toBe("deleted");
    });

    it("serialises checkpoint persistence across stop and restart", async () => {
        const persistence = promiseWithResolvers<void>();
        const f = fixture();
        const oldCheckpoint = vi.fn(() => persistence.promise);
        const nextCheckpoint = vi.fn();
        f.owner.beginWatch(vi.fn(), undefined, oldCheckpoint);
        void f.change(note("old.md"), "old");
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCheckpoint).toHaveBeenCalledOnce();
        f.owner.endWatch();
        f.owner.beginWatch(vi.fn(), undefined, nextCheckpoint);
        void f.change(note("new.md"), "new");
        await vi.advanceTimersByTimeAsync(0);
        expect(nextCheckpoint).not.toHaveBeenCalled();
        persistence.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(nextCheckpoint).toHaveBeenCalledWith("new");
        expect(f.state.since).toBe("new");
    });

    it("keeps body loads bounded when stopped watches still have unresolved reads", async () => {
        const reads: Array<() => void> = [];
        const f = fixture(
            vi.fn(async (doc: MetaEntry) => {
                await new Promise<void>((resolve) => reads.push(resolve));
                return { ...doc, data: ["body"] };
            })
        );
        const oldCallback = vi.fn();
        const callback = vi.fn();
        f.owner.beginWatch(oldCallback);
        for (let i = 0; i < 4; i++) void f.change(note(`old-${i}.md`), `old-${i}`);
        expect(f.getByMeta).toHaveBeenCalledTimes(4);
        f.owner.endWatch();
        f.owner.beginWatch(callback);
        void f.change(note("new.md"), "new");
        expect(f.getByMeta).toHaveBeenCalledTimes(4);
        const oldReads = reads.splice(0);
        oldReads[0]();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.getByMeta).toHaveBeenCalledTimes(5);
        reads.shift()!();
        for (const release of oldReads.slice(1)) release();
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledOnce();
        expect(f.state.since).toBe("new");
    });

    it("serialises same-ID consumer writes across stop and restart", async () => {
        const acknowledgement = promiseWithResolvers<void>();
        const writes: string[] = [];
        const f = fixture();
        const oldCallback = vi.fn(async () => {
            await acknowledgement.promise;
            writes.push("old");
        });
        const currentCallback = vi.fn(() => {
            writes.push("new");
        });
        f.owner.beginWatch(oldCallback);
        void f.change(note("same.md"), "old");
        await vi.advanceTimersByTimeAsync(0);
        expect(oldCallback).toHaveBeenCalledOnce();
        f.owner.endWatch();
        f.owner.beginWatch(currentCallback);
        void f.change(note("same.md", { _rev: "2-current" }), "new");
        await vi.advanceTimersByTimeAsync(0);
        expect(currentCallback).not.toHaveBeenCalled();
        acknowledgement.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(currentCallback).toHaveBeenCalledOnce();
        expect(writes).toEqual(["old", "new"]);
        expect(f.state.since).toBe("new");
    });

    it("owns a reconnect while reporting the feed disconnected and rejecting duplicate watches", async () => {
        const f = fixture();
        f.owner.beginWatch(vi.fn());
        f.emit("error", new Error("connection lost"));
        expect(f.state.watching).toBe(false);
        expect(f.owner.beginWatch(vi.fn())).toBe(false);
        expect(f.openChanges).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.openChanges).toHaveBeenCalledTimes(2);
        expect(f.state.watching).toBe(true);
    });

    it("keeps delivering unrelated documents while checkpoint persistence is pending", async () => {
        const persistence = promiseWithResolvers<void>();
        const f = fixture();
        const callback = vi.fn();
        const checkpoint = vi.fn(() => persistence.promise);
        f.owner.beginWatch(callback, undefined, checkpoint);
        try {
            for (let i = 0; i < 40; i++) void f.change(note(`note-${i}.md`), `token-${i}`);
            await vi.advanceTimersByTimeAsync(0);
            expect(callback).toHaveBeenCalledTimes(40);
            expect(f.state.since).toBe("start");
        } finally {
            persistence.resolve();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(checkpoint).toHaveBeenLastCalledWith("token-39");
        expect(f.state.since).toBe("token-39");
    });
});
