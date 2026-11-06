import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { replicateShim, type ProgressInfo } from "./ReplicatorShim";

PouchDB.plugin(MemoryAdapter);

describe("shim transfer statistics", () => {
    let source: PouchDB.Database<object>;
    let target: PouchDB.Database<object>;
    beforeEach(() => {
        source = new PouchDB(`statistics-source-${crypto.randomUUID()}`, { adapter: "memory" });
        target = new PouchDB(`statistics-target-${crypto.randomUUID()}`, { adapter: "memory" });
    });
    afterEach(async () => {
        await Promise.all([source.destroy(), target.destroy()]);
    });

    it("reports every all-known batch without invoking the document callback", async () => {
        await source.bulkDocs([{ _id: "metadata" }, { _id: "h:chunk" }]);
        const documents = (await source.allDocs({ include_docs: true })).rows.map((row) => row.doc!);
        await target.bulkDocs(documents, { new_edits: false });
        const progress = vi.fn(async () => undefined);
        const onStatistics = vi.fn();
        const options = { batch_size: 1, onStatistics };

        await expect(replicateShim(target, source, progress, options)).resolves.toEqual({ status: "completed" });

        expect(onStatistics.mock.calls.map(([info]) => info.statistics)).toEqual([
            { documents: 0, checkedChanges: 1 },
            { documents: 0, checkedChanges: 2 },
        ]);
        expect(progress).not.toHaveBeenCalled();
    });

    it("counts transferred revisions separately from known entries and refreshed documents", async () => {
        await source.bulkDocs([{ _id: "known" }, { _id: "h:chunk" }, { _id: "metadata" }]);
        await target.bulkDocs([await source.get("known")], { new_edits: false });
        const progress = vi.fn(async (_docs: object[], _info: ProgressInfo) => undefined);
        const onStatistics = vi.fn();
        const options = { onStatistics };

        await replicateShim(target, source, progress, options);

        expect(progress).toHaveBeenCalledOnce();
        expect(progress.mock.calls[0][0]).toHaveLength(3);
        expect(progress.mock.calls[0][1]).toEqual({
            lastSeq: 3,
            maxSeqInBatch: 3,
            statistics: { documents: 2, checkedChanges: 3 },
        });
        expect(onStatistics).toHaveBeenLastCalledWith({
            lastSeq: 3,
            maxSeqInBatch: 3,
            statistics: { documents: 2, checkedChanges: 3 },
        });
    });

    it("counts both missing conflict revisions of one change entry", async () => {
        await source.bulkDocs(
            [
                { _id: "metadata", _rev: "1-a", value: "first" },
                { _id: "metadata", _rev: "1-b", value: "second" },
            ],
            { new_edits: false }
        );
        const progress = vi.fn(async (_docs: object[], _info: ProgressInfo) => undefined);
        const onStatistics = vi.fn();
        await replicateShim(target, source, progress, { onStatistics } as Parameters<typeof replicateShim>[3]);

        expect(progress.mock.calls[0][0]).toHaveLength(1);
        expect(onStatistics).toHaveBeenLastCalledWith(
            expect.objectContaining({
                statistics: { documents: 2, checkedChanges: 1 },
            })
        );
        const leaves = await target.get("metadata", { open_revs: "all" });
        expect(
            leaves
                .filter((leaf) => "ok" in leaf)
                .map((leaf) => "ok" in leaf && leaf.ok._rev)
                .sort()
        ).toEqual(["1-a", "1-b"]);
    });

    it("resets cumulative counts on the next attempt and isolates observer failures", async () => {
        await source.put({ _id: "first" });
        const firstObserver = vi.fn(() => {
            throw new Error("observer unavailable");
        });
        await expect(
            replicateShim(target, source, async () => undefined, { onStatistics: firstObserver } as any)
        ).resolves.toEqual({ status: "completed" });
        await source.put({ _id: "second" });
        const onStatistics = vi.fn();
        await replicateShim(target, source, async () => undefined, { onStatistics } as any);
        expect(onStatistics).toHaveBeenLastCalledWith(
            expect.objectContaining({
                statistics: { documents: 1, checkedChanges: 1 },
            })
        );
    });

    it("reports accepted writes when another revision fails without advancing the checkpoint", async () => {
        await source.bulkDocs([{ _id: "accepted" }, { _id: "rejected" }]);
        const bulkDocs = target.bulkDocs.bind(target);
        vi.spyOn(target, "bulkDocs").mockImplementationOnce(async (docs: any, options: any) => {
            await bulkDocs(
                docs.filter((doc: any) => doc._id === "accepted"),
                options
            );
            return [{ id: "rejected", error: true, status: 403, name: "forbidden" }];
        });
        const onStatistics = vi.fn();
        const progress = vi.fn(async () => undefined);
        await expect(replicateShim(target, source, progress, { onStatistics } as any)).rejects.toThrow(
            "Target rejected 1 document write(s)"
        );
        expect(onStatistics).toHaveBeenLastCalledWith(
            expect.objectContaining({
                statistics: { documents: 1, checkedChanges: 2 },
            })
        );
        expect(onStatistics.mock.calls.at(-1)?.[0].lastSeq).toBe(0);
        expect(progress).not.toHaveBeenCalled();
        const mark = (await source.get(`_local/replication-checkpoint-mark-${target.name}-${source.name}`)) as any;
        const checkpoint = (await target.get(`_local/replication-checkpoint-${target.name}-${mark.mark}`)) as any;
        expect(checkpoint.since).toBe("");
        expect(await target.get("accepted")).toMatchObject({ _id: "accepted" });
        await expect(target.get("rejected")).rejects.toMatchObject({ status: 404 });
    });

    it("reports writes when the target refresh fails before checkpointing", async () => {
        await source.put({ _id: "metadata" });
        vi.spyOn(target, "bulkGet").mockRejectedValueOnce(new Error("refresh unavailable"));
        const onStatistics = vi.fn();
        const progress = vi.fn(async () => undefined);
        await expect(replicateShim(target, source, progress, { onStatistics })).rejects.toThrow("refresh unavailable");
        expect(onStatistics).toHaveBeenLastCalledWith(
            expect.objectContaining({
                statistics: { documents: 1, checkedChanges: 1 },
            })
        );
        expect(onStatistics.mock.calls.at(-1)?.[0].lastSeq).toBe(0);
        expect(await target.get("metadata")).toMatchObject({ _id: "metadata" });
        expect(progress).not.toHaveBeenCalled();
    });

    it("reports the settled written batch on cancellation without starting another batch", async () => {
        await source.bulkDocs([{ _id: "first" }, { _id: "second" }]);
        const controller = new AbortController();
        const onStatistics = vi.fn();
        const progress = vi.fn(async () => {
            controller.abort();
        });
        await expect(
            replicateShim(target, source, progress, {
                batch_size: 1,
                signal: controller.signal,
                onStatistics,
            })
        ).resolves.toEqual({ status: "cancelled" });
        expect(progress).toHaveBeenCalledOnce();
        expect(onStatistics).toHaveBeenCalledOnce();
        expect(onStatistics).toHaveBeenLastCalledWith(
            expect.objectContaining({
                statistics: { documents: 1, checkedChanges: 1 },
            })
        );
        expect((await target.allDocs()).rows).toHaveLength(1);
    });

    it("keeps the observer sequence at the prior processed batch when the next write fails", async () => {
        await source.bulkDocs([{ _id: "first" }, { _id: "second" }]);
        const bulkDocs = target.bulkDocs.bind(target);
        vi.spyOn(target, "bulkDocs")
            .mockImplementationOnce((docs: any, options: any) => bulkDocs(docs, options))
            .mockResolvedValueOnce([{ id: "second", error: true, status: 403 }]);
        const onStatistics = vi.fn();
        const progress = vi.fn(async (_docs: object[], _info: ProgressInfo) => undefined);
        await expect(replicateShim(target, source, progress, { batch_size: 1, onStatistics })).rejects.toThrow(
            "Target rejected 1 document write(s)"
        );
        expect(progress).toHaveBeenCalledOnce();
        expect(progress.mock.calls[0][1].lastSeq).toBe(1);
        expect(onStatistics).toHaveBeenLastCalledWith({
            lastSeq: 1,
            maxSeqInBatch: 2,
            statistics: { documents: 1, checkedChanges: 2 },
        });
    });

    it("preserves document callback sequence values while a failed callback leaves observer sequence unchanged", async () => {
        await source.put({ _id: "metadata" });
        const onStatistics = vi.fn();
        const progress = vi.fn(async (_docs: object[], info: ProgressInfo) => {
            expect(info.lastSeq).toBe(1);
            throw new Error("document processing unavailable");
        });
        await expect(replicateShim(target, source, progress, { onStatistics })).resolves.toEqual({
            status: "completed",
        });
        expect(progress).toHaveBeenCalledOnce();
        expect(onStatistics).toHaveBeenLastCalledWith({
            lastSeq: 0,
            maxSeqInBatch: 1,
            statistics: { documents: 1, checkedChanges: 1 },
        });
    });

    it("counts comparison work without advancing the observer sequence when cancelled before writing", async () => {
        await source.put({ _id: "metadata" });
        const controller = new AbortController();
        const revsDiff = target.revsDiff.bind(target);
        vi.spyOn(target, "revsDiff").mockImplementationOnce(async (diff) => {
            const result = await revsDiff(diff);
            controller.abort();
            return result;
        });
        const onStatistics = vi.fn();
        const progress = vi.fn(async () => undefined);
        await expect(
            replicateShim(target, source, progress, { signal: controller.signal, onStatistics })
        ).resolves.toEqual({ status: "cancelled" });
        expect(progress).not.toHaveBeenCalled();
        expect(onStatistics).toHaveBeenLastCalledWith({
            lastSeq: 0,
            maxSeqInBatch: 1,
            statistics: { documents: 0, checkedChanges: 1 },
        });
        await expect(target.get("metadata")).rejects.toMatchObject({ status: 404 });
    });
});
