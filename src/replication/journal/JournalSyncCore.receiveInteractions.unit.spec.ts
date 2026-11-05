import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type EntryDoc } from "@lib/common/types.ts";
import { type SimpleStore, pickBucketSyncSettings } from "@lib/common/utils.ts";
import { REMOTE_CHUNK_FETCHED } from "@lib/pouchdb/LiveSyncLocalDB.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { CheckPointInfoDefault, type CheckPointInfo } from "./JournalSyncTypes.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";

type Record = Parameters<JournalSyncCore["processDocuments"]>[0][number];

function createFixture() {
    const chunks = [{ _id: "h:new", _rev: "8-remote", type: "leaf", data: "content" }] as Record[];
    const docs = [
        { _id: "note", _rev: "2-new", _revisions: { start: 2, ids: ["new", "root"] }, type: "plain" },
        { _id: "note", _rev: "2-existing", _revisions: { start: 2, ids: ["existing", "root"] }, type: "plain" },
    ] as Record[];
    const calls: string[] = [];
    const db = {
        allDocs: vi.fn(async () => {
            calls.push("inspect-chunks");
            return { rows: [{ key: "h:new", error: "not_found" }] };
        }),
        bulkDocs: vi.fn(async (_docs: EntryDoc[], options: { new_edits: boolean }) => {
            calls.push(options.new_edits ? "save-chunks" : "save-metadata");
            return options.new_edits ? [{ ok: true, id: "h:new", rev: "1-local" }] : [];
        }),
        revsDiff: vi.fn(async () => {
            calls.push("inspect-revisions");
            return { note: { missing: ["2-new"] } };
        }),
    };
    let checkpoint = {
        ...CheckPointInfoDefault,
        knownIDs: new Set<string>(),
        sentIDs: new Set<string>(),
        receivedFiles: new Set<string>(),
        sentFiles: new Set<string>(),
    };
    const store = {
        get: vi.fn(async () => checkpoint),
        set: vi.fn(async (_key: string, value: CheckPointInfo) => {
            calls.push("checkpoint");
            checkpoint = value;
        }),
    };
    const emitEvent = vi.fn(() => {
        calls.push("chunk-event");
    });
    const reflect = vi.fn(async () => {
        calls.push("reflect");
        return true;
    });
    const settings = { ...DEFAULT_SETTINGS };
    const env = {
        services: {
            context: { events: { emitEvent } },
            database: { localDatabase: { localDatabase: db } },
            setting: { currentSettings: () => settings },
            replication: { parseSynchroniseResult: reflect },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    const core = new JournalSyncCore(
        pickBucketSyncSettings(settings),
        store as unknown as SimpleStore<CheckPointInfo>,
        env,
        {} as IJournalStorage
    );
    return { core, chunks, docs, calls, db, store, emitEvent, reflect, settings, checkpoint: () => checkpoint };
}

describe("Journal receipt collaboration order", () => {
    it("persists and announces Chunks before saving revision ancestry and reflecting all Metadata", async () => {
        const f = createFixture();
        const input = [...f.docs, ...f.chunks];
        const before = structuredClone(input);

        await expect(f.core.processDocuments(input)).resolves.toBe(true);

        expect(f.calls).toEqual([
            "inspect-chunks",
            "save-chunks",
            "chunk-event",
            "checkpoint",
            "inspect-revisions",
            "save-metadata",
            "reflect",
            "checkpoint",
        ]);
        expect(f.db.allDocs).toHaveBeenCalledWith({ include_docs: true, keys: ["h:new"] });
        expect(f.db.bulkDocs).toHaveBeenNthCalledWith(1, [{ ...f.chunks[0], _rev: undefined }], { new_edits: true });
        expect(f.emitEvent).toHaveBeenCalledWith(REMOTE_CHUNK_FETCHED, { ...f.chunks[0], _rev: undefined });
        expect(f.db.revsDiff).toHaveBeenCalledWith({ note: ["2-new", "2-existing"] });
        expect(f.db.bulkDocs).toHaveBeenNthCalledWith(2, [f.docs[0]], { new_edits: false });
        expect(f.reflect).toHaveBeenCalledWith(f.docs);
        expect(f.checkpoint().knownIDs).toEqual(new Set(["h:new", "note-2-new", "note-2-existing"]));
        expect(input).toEqual(before);
    });

    it("announces a saved Chunk but does not checkpoint a partially failed Chunk batch", async () => {
        const f = createFixture();
        f.db.bulkDocs.mockImplementationOnce(async () => {
            f.calls.push("save-chunks");
            return [
                { ok: true, id: "h:new", rev: "1-local" },
                { error: "write-failed", id: "h:other" },
            ] as never;
        });
        const other = { _id: "h:other", _rev: "", type: "leaf", data: "other" } as Record;

        await expect(f.core.processDocuments([...f.chunks, other, ...f.docs])).resolves.toBe(false);

        expect(f.calls).toEqual(["inspect-chunks", "save-chunks", "chunk-event"]);
        expect(f.emitEvent).toHaveBeenCalledTimes(1);
        expect(f.store.set).not.toHaveBeenCalled();
        expect(f.db.revsDiff).not.toHaveBeenCalled();
        expect(f.reflect).not.toHaveBeenCalled();
    });

    it.each(["metadata-write", "reflection"] as const)("retains the Chunk checkpoint after %s fails", async (stage) => {
        const f = createFixture();
        if (stage === "metadata-write") {
            f.db.bulkDocs.mockImplementation(async (_docs, options) => {
                if (options.new_edits) return [{ ok: true, id: "h:new", rev: "1-local" }];
                throw new Error("write failed");
            });
        } else {
            f.reflect.mockRejectedValueOnce(new Error("reflection failed"));
        }

        await expect(f.core.processDocuments([...f.chunks, ...f.docs])).resolves.toBe(false);

        expect(f.store.set).toHaveBeenCalledTimes(1);
        expect(f.checkpoint().knownIDs).toEqual(new Set(["h:new"]));
        expect(f.checkpoint().receivedFiles).toEqual(new Set());
        expect(f.reflect).toHaveBeenCalledTimes(stage === "reflection" ? 1 : 0);
    });

    it("checkpoints persisted Metadata without invoking a suspended reflection callback", async () => {
        const f = createFixture();
        f.settings.suspendParseReplicationResult = true;

        await expect(f.core.processDocuments([...f.chunks, ...f.docs])).resolves.toBe(true);

        expect(f.reflect).not.toHaveBeenCalled();
        expect(f.store.set).toHaveBeenCalledTimes(2);
        expect(f.checkpoint().knownIDs).toEqual(new Set(["h:new", "note-2-new", "note-2-existing"]));
    });
});
