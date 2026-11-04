import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import {
    DEFAULT_SETTINGS,
    type BucketSyncSetting,
    type DocumentID,
    type EntryDoc,
    type EntryLeaf,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types.ts";
import { type SimpleStore, pickBucketSyncSettings } from "@lib/common/utils.ts";
import { CheckPointInfoDefault, type CheckPointInfo } from "./JournalSyncTypes.ts";
import { wrappedDeflate } from "@lib/pouchdb/compress.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";

PouchDB.plugin(MemoryAdapter);

type JournalSettings = typeof DEFAULT_SETTINGS;

function cloneCheckpoint(checkpoint: CheckPointInfo): CheckPointInfo {
    return {
        ...checkpoint,
        knownIDs: new Set(checkpoint.knownIDs),
        sentIDs: new Set(checkpoint.sentIDs),
        receivedFiles: new Set(checkpoint.receivedFiles),
        sentFiles: new Set(checkpoint.sentFiles),
    };
}

function metadata(id: string, rev: string, chunkId: string, size = 0): PlainEntry & PouchDB.Core.GetMeta {
    const separatorIndex = rev.indexOf("-");
    const start = Number(rev.slice(0, separatorIndex));
    const hash = rev.slice(separatorIndex + 1);
    return {
        _id: id as DocumentID,
        _rev: rev,
        _revisions: { start, ids: start === 1 ? [hash] : [hash, "root"] },
        type: "plain",
        path: `${id}.md` as FilePathWithPrefix,
        children: chunkId ? [chunkId] : [],
        ctime: 1,
        mtime: 2,
        size,
        eden: {},
    };
}

async function compressJournal(records: EntryDoc[]): Promise<Uint8Array> {
    const content = records
        .map((record) =>
            record._id.startsWith("h:")
                ? `~${record._id}\u001f${(record as EntryLeaf).data}\n`
                : `${JSON.stringify(record)}\n`
        )
        .join("");
    return await wrappedDeflate(new TextEncoder().encode(content), {});
}

function captureLogs() {
    const entries: Array<{ message: unknown; level?: number; key?: string }> = [];
    setGlobalLogFunction((message, level, key) => entries.push({ message, level, key }));
    return {
        entries,
        restore: () => setGlobalLogFunction(defaultLogger),
    };
}

function downloadCount(storage: IJournalStorage, key: string): number {
    const fromResult = vi
        .mocked(storage.downloadWithResult)
        .mock.calls.filter(([candidate]) => candidate === key).length;
    const fromDownload = vi.mocked(storage.download).mock.calls.filter(([candidate]) => candidate === key).length;
    return fromResult + fromDownload;
}

describe("JournalSyncCore receive failure recovery", () => {
    let dbCounter = 0;
    let localDB: PouchDB.Database<EntryDoc>;
    let core: JournalSyncCore;
    let env: LiveSyncJournalReplicatorEnv;
    let storage: IJournalStorage;
    let virtualStorage: Map<string, Uint8Array>;
    let checkpoint: CheckPointInfo;
    let store: SimpleStore<CheckPointInfo>;
    let settings: JournalSettings;
    let failReceivedCheckpointWrite: boolean;
    let failedReceivedCheckpointWrites: number;
    let returnCheckpointReference: boolean;

    beforeEach(() => {
        dbCounter++;
        localDB = new PouchDB(`journal_receive_failure_${dbCounter}`, { adapter: "memory" });
        virtualStorage = new Map();
        checkpoint = cloneCheckpoint(CheckPointInfoDefault);
        failReceivedCheckpointWrite = false;
        failedReceivedCheckpointWrites = 0;
        returnCheckpointReference = false;
        settings = { ...DEFAULT_SETTINGS };

        store = {
            get: vi.fn(async () => (returnCheckpointReference ? checkpoint : cloneCheckpoint(checkpoint))),
            set: vi.fn(async (_key, value) => {
                if (failReceivedCheckpointWrite && value.receivedFiles.size > checkpoint.receivedFiles.size) {
                    failedReceivedCheckpointWrites++;
                    throw new Error("checkpoint write failed");
                }
                checkpoint = cloneCheckpoint(value);
            }),
            keys: vi.fn(async () => []),
            delete: vi.fn(async () => {}),
        } as unknown as SimpleStore<CheckPointInfo>;

        storage = {
            applyNewConfig: vi.fn(),
            upload: vi.fn(async () => true),
            download: vi.fn(async (key: string) => virtualStorage.get(key) ?? false),
            downloadWithResult: vi.fn(async (key: string) => {
                const value = virtualStorage.get(key);
                return value === undefined ? { status: "not-found" as const } : { status: "available" as const, value };
            }),
            listFiles: vi.fn(async (from: string, limit?: number) =>
                Array.from(virtualStorage.keys())
                    .sort()
                    .filter((key) => key > (from || ""))
                    .slice(0, limit)
            ),
            deleteFile: vi.fn(async (key: string) => {
                virtualStorage.delete(key);
            }),
        } as unknown as IJournalStorage;

        const context = createServiceContext();
        env = {
            services: {
                context,
                database: { localDatabase: { localDatabase: localDB } },
                setting: { currentSettings: () => settings },
                replicator: {
                    replicationStatics: {
                        value: {
                            sent: 0,
                            arrived: 0,
                            maxPullSeq: 0,
                            maxPushSeq: 0,
                            lastSyncPullSeq: 0,
                            lastSyncPushSeq: 0,
                            syncStatus: "NOT_CONNECTED",
                        },
                    },
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;
        const bucketSettings: BucketSyncSetting = pickBucketSyncSettings(DEFAULT_SETTINGS);
        core = new JournalSyncCore(bucketSettings, store, env, storage);
        core.processReplication = async () => true;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await localDB.destroy();
    });

    async function putJournal(key: string, records: EntryDoc[]): Promise<void> {
        virtualStorage.set(key, await compressJournal(records));
    }

    it("stops at the first failed Journal even if an obsolete skip toggle is present", async () => {
        Object.assign(settings, { ignoreBrokenJournals: true });
        virtualStorage.set("001-first.jsonl.gz", new Uint8Array([1]));
        virtualStorage.set("002-second.jsonl.gz", new Uint8Array([1]));
        await putJournal("003-later.jsonl.gz", [metadata("later", "1-later", "")]);

        await expect(core.receiveRemoteJournal()).resolves.toBe(false);

        expect(checkpoint.receivedFiles).toEqual(new Set());
        await expect(localDB.get("later")).rejects.toMatchObject({ status: 404 });
    });

    it.each(["Chunk bulk rejection", "Chunk row failure", "Metadata row failure"] as const)(
        "stops at a %s, keeps earlier checkpoints, and retries the partially saved Journal",
        async (failure) => {
            const earlierKey = "001-earlier.jsonl.gz";
            const failedKey = "002-failed.jsonl.gz";
            const laterKey = "003-later.jsonl.gz";
            const earlierChunkId = `h:earlier-${dbCounter}`;
            const earlierMetadataId = `earlier-${dbCounter}`;
            const failedChunkIds = [`h:failed-a-${dbCounter}`, `h:failed-b-${dbCounter}`];
            const failedMetadataId = `conflict-${dbCounter}`;
            const laterChunkId = `h:later-${dbCounter}`;
            const laterMetadataId = `later-${dbCounter}`;
            const conflictMetadata = [
                metadata(failedMetadataId, "2-winner", failedChunkIds[0], "partial chunk".length),
                metadata(failedMetadataId, "2-conflict", failedChunkIds[1], "failing chunk".length),
            ];
            let injectedFailureCount = 0;

            await putJournal(earlierKey, [
                { _id: earlierChunkId as DocumentID, type: "leaf", data: "earlier chunk" },
                metadata(earlierMetadataId, "1-earlier", earlierChunkId, "earlier chunk".length),
            ]);
            await putJournal(failedKey, [
                { _id: failedChunkIds[0] as DocumentID, type: "leaf", data: "partial chunk" },
                { _id: failedChunkIds[1] as DocumentID, type: "leaf", data: "failing chunk" },
                ...conflictMetadata,
            ]);
            await putJournal(laterKey, [
                { _id: laterChunkId as DocumentID, type: "leaf", data: "later chunk" },
                metadata(laterMetadataId, "1-later", laterChunkId, "later chunk".length),
            ]);

            const parseSynchroniseResult = vi.fn(async (_docs: PouchDB.Core.ExistingDocument<EntryDoc>[]) => true);
            core.processReplication = parseSynchroniseResult;
            const realBulkDocs = localDB.bulkDocs.bind(localDB);
            const bulkDocsSpy = vi.spyOn(localDB, "bulkDocs").mockImplementation(async (docs, options) => {
                const rows = docs as EntryDoc[];
                const addError = (id: string): PouchDB.Core.Error => ({
                    id,
                    error: "internal_server_error",
                    name: "internal_server_error",
                    status: 500,
                    message: "injected row failure",
                });

                if (
                    failure === "Chunk bulk rejection" &&
                    options?.new_edits !== false &&
                    rows.some((row) => row._id === failedChunkIds[0])
                ) {
                    injectedFailureCount++;
                    throw new Error("injected Chunk bulk rejection");
                }

                if (
                    failure === "Chunk row failure" &&
                    options?.new_edits !== false &&
                    rows.some((row) => row._id === failedChunkIds[1])
                ) {
                    injectedFailureCount++;
                    const accepted = docs.filter((row) => row._id !== failedChunkIds[1]);
                    const saved = accepted.length > 0 ? await realBulkDocs(accepted, options) : [];
                    return [...saved, addError(failedChunkIds[1])];
                }

                if (
                    failure === "Metadata row failure" &&
                    options?.new_edits === false &&
                    rows.some((row) => row._rev === "2-conflict")
                ) {
                    injectedFailureCount++;
                    const accepted = docs.filter((row) => row._rev !== "2-conflict");
                    const saved = accepted.length > 0 ? await realBulkDocs(accepted, options) : [];
                    return [...saved, addError(failedMetadataId)];
                }

                return await realBulkDocs(docs, options);
            });

            await expect(core.receiveRemoteJournal()).resolves.toBe(false);
            expect(injectedFailureCount).toBe(1);
            expect(checkpoint.receivedFiles).toEqual(new Set([earlierKey]));
            expect(downloadCount(storage, failedKey)).toBe(1);
            await expect(localDB.get(earlierMetadataId)).resolves.toMatchObject({
                _id: earlierMetadataId,
                children: [earlierChunkId],
            });
            expect(checkpoint.receivedFiles.has(failedKey)).toBe(false);
            expect(checkpoint.receivedFiles.has(laterKey)).toBe(false);

            if (failure === "Chunk row failure") {
                await expect(localDB.get<EntryLeaf>(failedChunkIds[0])).resolves.toMatchObject({
                    data: "partial chunk",
                });
            }
            if (failure === "Metadata row failure") {
                await expect(localDB.get(failedMetadataId, { rev: "2-winner" })).resolves.toMatchObject({
                    _rev: "2-winner",
                    children: [failedChunkIds[0]],
                });
            }

            const parseCallsBeforeRetry = parseSynchroniseResult.mock.calls.length;
            bulkDocsSpy.mockRestore();
            await expect(core.receiveRemoteJournal()).resolves.toBe(true);

            expect(downloadCount(storage, failedKey)).toBe(2);
            expect(checkpoint.receivedFiles).toEqual(new Set([earlierKey, failedKey, laterKey]));
            const retriedMetadata = parseSynchroniseResult.mock.calls
                .slice(parseCallsBeforeRetry)
                .flatMap(([docs]) => docs)
                .filter((doc) => doc._id === failedMetadataId);
            expect(retriedMetadata.map((doc) => doc._rev)).toEqual(expect.arrayContaining(["2-winner", "2-conflict"]));

            const winner = await localDB.get<EntryDoc>(failedMetadataId, { rev: "2-winner", revs: true });
            const conflict = await localDB.get<EntryDoc>(failedMetadataId, { rev: "2-conflict", revs: true });
            expect((winner as PouchDB.Core.GetMeta)._revisions).toEqual({ start: 2, ids: ["winner", "root"] });
            expect((conflict as PouchDB.Core.GetMeta)._revisions).toEqual({ start: 2, ids: ["conflict", "root"] });
            const current = await localDB.get<EntryDoc>(failedMetadataId, { conflicts: true });
            expect([current._rev, ...(current._conflicts ?? [])]).toEqual(
                expect.arrayContaining(["2-winner", "2-conflict"])
            );
            await expect(localDB.get(laterMetadataId)).resolves.toMatchObject({
                _id: laterMetadataId,
                children: [laterChunkId],
            });
        }
    );

    it("does not acknowledge a valid prefix followed by a truncated final record in default mode", async () => {
        const key = "010-truncated.jsonl.gz";
        const laterKey = "020-later.jsonl.gz";
        const prefixChunkId = `h:truncated-prefix-${dbCounter}`;
        const laterChunkId = `h:truncated-later-${dbCounter}`;
        const laterMetadataId = `truncated-later-${dbCounter}`;
        const raw = `~${prefixChunkId}\u001fprefix data\n{"_id":"unfinished-${dbCounter}`;
        virtualStorage.set(key, await wrappedDeflate(new TextEncoder().encode(raw), {}));
        await putJournal(laterKey, [
            { _id: laterChunkId as DocumentID, type: "leaf", data: "later" },
            metadata(laterMetadataId, "1-truncatedlater", laterChunkId, "later".length),
        ]);

        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        expect(downloadCount(storage, key)).toBe(1);
        expect(checkpoint.receivedFiles).toEqual(new Set());
        await expect(localDB.get(laterMetadataId)).rejects.toMatchObject({ status: 404 });
    });

    it.each(["per-document write failure", "generic bulkDocs rejection", "truncated final record"] as const)(
        "skips a stopped %s only by explicit request, reports its key and stage, and continues",
        async (kind) => {
            const earlierKey = "030-earlier.jsonl.gz";
            const brokenKey = "040-broken.jsonl.gz";
            const laterKey = "050-later.jsonl.gz";
            const brokenChunkId = `h:broken-${dbCounter}`;
            const laterChunkId = `h:skip-later-${dbCounter}`;
            const brokenMetadataId = `broken-${dbCounter}`;
            const laterMetadataId = `skip-later-${dbCounter}`;
            let injectedFailureCount = 0;
            const privateChunkContent = `private-chunk-content-${dbCounter}`;
            await putJournal(earlierKey, []);
            await putJournal(laterKey, [
                { _id: laterChunkId as DocumentID, type: "leaf", data: "later" },
                metadata(laterMetadataId, "1-skiplater", laterChunkId, "later".length),
            ]);

            if (kind !== "truncated final record") {
                await putJournal(brokenKey, [
                    { _id: brokenChunkId as DocumentID, type: "leaf", data: privateChunkContent },
                    metadata(brokenMetadataId, "1-broken", brokenChunkId, privateChunkContent.length),
                ]);
            } else {
                const prefixChunkId = `h:truncated-skip-prefix-${dbCounter}`;
                const truncated = `~${prefixChunkId}\u001f${privateChunkContent}\n{"_id":"unfinished-${dbCounter}`;
                virtualStorage.set(brokenKey, await wrappedDeflate(new TextEncoder().encode(truncated), {}));
            }

            const logs = captureLogs();
            let bulkDocsSpy: { mockRestore: () => void } | undefined;
            try {
                if (kind === "per-document write failure") {
                    const realBulkDocs = localDB.bulkDocs.bind(localDB);
                    bulkDocsSpy = vi.spyOn(localDB, "bulkDocs").mockImplementation(async (docs, options) => {
                        const rows = docs as EntryDoc[];
                        if (options?.new_edits === false && rows.some((row) => row._id === brokenMetadataId)) {
                            injectedFailureCount++;
                            const accepted = docs.filter((row) => row._id !== brokenMetadataId);
                            const saved = accepted.length > 0 ? await realBulkDocs(accepted, options) : [];
                            return [
                                ...saved,
                                {
                                    id: brokenMetadataId,
                                    error: "internal_server_error",
                                    name: "internal_server_error",
                                    status: 500,
                                    message: "injected Metadata row failure",
                                },
                            ];
                        }
                        return await realBulkDocs(docs, options);
                    });
                } else if (kind === "generic bulkDocs rejection") {
                    const realBulkDocs = localDB.bulkDocs.bind(localDB);
                    bulkDocsSpy = vi.spyOn(localDB, "bulkDocs").mockImplementation(async (docs, options) => {
                        const rows = docs as EntryDoc[];
                        if (options?.new_edits !== false && rows.some((row) => row._id === brokenChunkId)) {
                            injectedFailureCount++;
                            throw new Error("injected Chunk bulkDocs failure");
                        }
                        return await realBulkDocs(docs, options);
                    });
                }

                const parseSynchroniseResult = vi.fn(async (_docs: PouchDB.Core.ExistingDocument<EntryDoc>[]) => true);
                core.processReplication = parseSynchroniseResult;
                await expect(core.receiveRemoteJournal()).resolves.toBe(false);
                expect(checkpoint.receivedFiles).toEqual(new Set([earlierKey]));
                const stopped = core.getStoppedJournal();
                expect(stopped?.key).toBe(brokenKey);
                if (!stopped) throw new Error("Expected a stopped Journal");
                await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(true);

                expect(injectedFailureCount).toBe(kind === "truncated final record" ? 0 : 1);
                expect(checkpoint.receivedFiles).toEqual(new Set([earlierKey, brokenKey, laterKey]));
                await expect(localDB.get(laterMetadataId)).resolves.toMatchObject({ children: [laterChunkId] });
                if (kind === "per-document write failure") {
                    await expect(localDB.get<EntryLeaf>(brokenChunkId)).resolves.toMatchObject({
                        data: privateChunkContent,
                    });
                    await expect(localDB.get(brokenMetadataId)).rejects.toMatchObject({ status: 404 });
                } else {
                    const prefixChunkId = `h:truncated-skip-prefix-${dbCounter}`;
                    await expect(localDB.get(prefixChunkId)).rejects.toMatchObject({ status: 404 });
                }

                if (kind === "generic bulkDocs rejection") {
                    await expect(localDB.get(brokenChunkId)).rejects.toMatchObject({ status: 404 });
                    await expect(localDB.get(brokenMetadataId)).rejects.toMatchObject({ status: 404 });
                }
                const warning = logs.entries.find(({ message }) => String(message).includes(brokenKey));
                expect(warning).toBeDefined();
                expect(String(warning?.message)).toMatch(
                    /(metadata|write|record|decode|parse|inflate|chunk|bulkDocs)/i
                );
                expect(logs.entries.map(({ message }) => String(message)).join("\n")).not.toContain(
                    privateChunkContent
                );

                const priorReads = downloadCount(storage, brokenKey);
                await expect(core.receiveRemoteJournal()).resolves.toBe(true);
                expect(downloadCount(storage, brokenKey)).toBe(priorReads);

                bulkDocsSpy?.mockRestore();
                await putJournal(brokenKey, [
                    { _id: brokenChunkId as DocumentID, type: "leaf", data: privateChunkContent },
                    metadata(brokenMetadataId, "1-broken", brokenChunkId, privateChunkContent.length),
                ]);
                await core.updateCheckPointInfo((info) => ({
                    ...info,
                    receivedFiles: new Set(),
                    knownIDs: new Set(),
                }));
                await expect(core.receiveRemoteJournal()).resolves.toBe(true);
                expect(downloadCount(storage, brokenKey)).toBe(priorReads + 1);
                await expect(localDB.get<EntryLeaf>(brokenChunkId)).resolves.toMatchObject({
                    data: privateChunkContent,
                });
                await expect(localDB.get(brokenMetadataId, { revs: true })).resolves.toMatchObject({
                    _rev: "1-broken",
                    _revisions: { start: 1, ids: ["broken"] },
                    children: [brokenChunkId],
                });
                await expect(localDB.get(laterMetadataId)).resolves.toMatchObject({ _rev: "1-skiplater" });
            } finally {
                bulkDocsSpy?.mockRestore();
                logs.restore();
            }
        }
    );

    it("stops at a missing listed Journal until that exact Journal is explicitly skipped", async () => {
        const missingKey = "055-missing.jsonl.gz";
        const laterKey = "056-later.jsonl.gz";
        const laterId = `missinglater-${dbCounter}`;
        await putJournal(missingKey, []);
        await putJournal(laterKey, [metadata(laterId, "1-missinglater", "")]);
        const download = vi.mocked(storage.downloadWithResult).getMockImplementation()!;
        vi.mocked(storage.downloadWithResult).mockImplementation(async (key, ...options) =>
            key === missingKey ? { status: "not-found" } : await download(key, ...options)
        );
        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());
        await expect(localDB.get(laterId)).rejects.toMatchObject({ status: 404 });
        const stopped = core.getStoppedJournal();
        expect(stopped).toEqual({ key: missingKey, stage: "download" });
        if (!stopped) throw new Error("Expected a stopped Journal");
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(true);
        expect(checkpoint.receivedFiles).toEqual(new Set([missingKey, laterKey]));
        await expect(localDB.get(laterId)).resolves.toMatchObject({ _rev: "1-missinglater" });
    });

    async function stopAtFirstOfTwoFailures() {
        virtualStorage.set("001-first.jsonl.gz", new Uint8Array([1]));
        virtualStorage.set("002-second.jsonl.gz", new Uint8Array([1]));
        await putJournal("003-later.jsonl.gz", [metadata("later", "1-later", "")]);
        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        const stopped = core.getStoppedJournal();
        if (!stopped) throw new Error("Expected a stopped Journal");
        return stopped;
    }

    it("refuses a missing failure snapshot without starting receipt", async () => {
        await expect(core.skipStoppedJournalAndResume(undefined as never)).resolves.toBe(false);
        expect(storage.listFiles).not.toHaveBeenCalled();
    });

    it("keeps the failed Journal unacknowledged if Stop arrives during skip preparation", async () => {
        const stopped = await stopAtFirstOfTwoFailures();
        const list = vi.mocked(storage.listFiles).getMockImplementation()!;
        vi.mocked(storage.listFiles).mockImplementationOnce(async (...args) => {
            core.requestStop();
            return await list(...args);
        });
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());
        expect(core.getStoppedJournal()).toBeUndefined();
        expect(env.services.replicator.replicationStatics.value.syncStatus).toBe("CLOSED");
    });

    it("skips exactly one confirmed failure and stops again at the next Journal", async () => {
        const first = await stopAtFirstOfTwoFailures();
        expect(first).toEqual({ key: "001-first.jsonl.gz", stage: "inflate" });
        expect(Object.isFrozen(first)).toBe(true);
        await expect(core.skipStoppedJournalAndResume({ ...first })).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());

        await expect(core.skipStoppedJournalAndResume(first)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set([first.key]));
        const second = core.getStoppedJournal();
        expect(second?.key).toBe("002-second.jsonl.gz");
        await expect(localDB.get("later")).rejects.toMatchObject({ status: 404 });
        await expect(core.skipStoppedJournalAndResume(first)).resolves.toBe(false);
        if (!second) throw new Error("Expected the next stopped Journal");
        await expect(core.skipStoppedJournalAndResume(second)).resolves.toBe(true);
        expect(checkpoint.receivedFiles).toEqual(new Set([first.key, second.key, "003-later.jsonl.gz"]));
        await expect(localDB.get("later")).resolves.toMatchObject({ _rev: "1-later" });
        expect(core.getStoppedJournal()).toBeUndefined();
    });

    it("does not reuse a failure from an earlier retry or another client", async () => {
        const first = await stopAtFirstOfTwoFailures();
        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        expect(core.getStoppedJournal()).not.toBe(first);
        await expect(core.skipStoppedJournalAndResume(first)).resolves.toBe(false);
        const restarted = new JournalSyncCore(pickBucketSyncSettings(settings), store, env, storage);
        expect(restarted.getStoppedJournal()).toBeUndefined();
        await expect(restarted.skipStoppedJournalAndResume(first)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());
    });

    it.each(["settings", "checkpoint reset", "stop"] as const)("rejects a skip after %s changes", async (change) => {
        const stopped = await stopAtFirstOfTwoFailures();
        if (change === "settings") settings.passphrase = "changed";
        if (change === "checkpoint reset") await core.resetCheckpointInfo();
        if (change === "stop") core.requestStop();
        expect(core.getStoppedJournal()).toBeUndefined();
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());
    });

    it("rejects an old failure after the local database is replaced", async () => {
        const stopped = await stopAtFirstOfTwoFailures();
        const replacement = new PouchDB<EntryDoc>(`replacement_${dbCounter}`, { adapter: "memory" });
        env.services.database.localDatabase.localDatabase = replacement;
        try {
            await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
            expect(checkpoint.receivedFiles).toEqual(new Set());
        } finally {
            env.services.database.localDatabase.localDatabase = localDB;
            await replacement.destroy();
        }
    });

    it("rejects duplicate skips while receipt is active", async () => {
        const stopped = await stopAtFirstOfTwoFailures();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const list = vi.mocked(storage.listFiles).getMockImplementation()!;
        vi.mocked(storage.listFiles).mockImplementationOnce(async (...args) => {
            entered();
            await gate;
            return await list(...args);
        });
        const resume = core.skipStoppedJournalAndResume(stopped);
        await started;
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(core.receiveRemoteJournal()).toBe(resume);
        release();
        await expect(resume).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set([stopped.key]));
        expect(core.getStoppedJournal()?.key).toBe("002-second.jsonl.gz");
    });

    it("does not acknowledge a skip when its checkpoint cannot be saved", async () => {
        const stopped = await stopAtFirstOfTwoFailures();
        failReceivedCheckpointWrite = true;
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(failedReceivedCheckpointWrites).toBe(1);
        expect(checkpoint.receivedFiles).toEqual(new Set());
        expect(core.getStoppedJournal()).toBeUndefined();
        failReceivedCheckpointWrite = false;
        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        expect(core.getStoppedJournal()?.key).toBe(stopped.key);
    });

    it("rejects a skip when an earlier unprocessed Journal appears", async () => {
        const stopped = await stopAtFirstOfTwoFailures();
        await putJournal("000-new-earlier.jsonl.gz", []);
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set());
    });

    it.each([
        { name: "indexed_db_went_bad", message: "unknown", reason: "QuotaExceededError", status: 500 },
        { name: "precondition_failed", message: "Database not open", status: 412 },
    ])("stops again after one explicit skip while the database keeps returning $name", async (error) => {
        await putJournal("001-first.jsonl.gz", [{ _id: "h:first" as DocumentID, type: "leaf", data: "first" }]);
        await putJournal("002-second.jsonl.gz", [{ _id: "h:second" as DocumentID, type: "leaf", data: "second" }]);
        vi.spyOn(localDB, "bulkDocs").mockRejectedValue(error);
        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        const stopped = core.getStoppedJournal();
        if (!stopped) throw new Error("Expected a stopped Journal");
        await expect(core.skipStoppedJournalAndResume(stopped)).resolves.toBe(false);
        expect(checkpoint.receivedFiles).toEqual(new Set(["001-first.jsonl.gz"]));
        expect(core.getStoppedJournal()).toEqual({ key: "002-second.jsonl.gz", stage: "chunk-write" });
    });

    it("accepts an empty successful new_edits:false result", async () => {
        const key = "060-already-present.jsonl.gz";
        const existing = metadata(`already-present-${dbCounter}`, "1-present", "");
        await localDB.bulkDocs([existing], { new_edits: false });
        await putJournal(key, [existing]);
        core.processReplication = async () => true;
        const bulkDocsSpy = vi.spyOn(localDB, "bulkDocs");

        await expect(core.receiveRemoteJournal()).resolves.toBe(true);

        expect(bulkDocsSpy).toHaveBeenCalledWith([], { new_edits: false });
        expect(checkpoint.receivedFiles).toEqual(new Set([key]));
    });

    it.each([
        "unavailable download",
        "QuotaExceededError",
        "HTTP 401 authorization failure",
        "HTTP 403 authorization failure",
        "checkpoint failure",
    ] as const)("stops without automatically skipping a %s", async (failure) => {
        const key = "070-must-stop.jsonl.gz";
        const laterKey = "080-later.jsonl.gz";
        const chunkId = `h:must-stop-${dbCounter}`;
        const metadataId = `must-stop-${dbCounter}`;
        const laterMetadataId = `stop-later-${dbCounter}`;
        await putJournal(key, [
            { _id: chunkId as DocumentID, type: "leaf", data: "data" },
            metadata(metadataId, "1-stop", chunkId, "data".length),
        ]);
        await putJournal(laterKey, [metadata(laterMetadataId, "1-stoplater", "")]);

        let injectedFailureCount = 0;
        let authOrQuotaBulkDocsSpy: { mockRestore: () => void } | undefined;

        if (failure === "unavailable download") {
            vi.mocked(storage.download).mockResolvedValueOnce(false);
            vi.mocked(storage.downloadWithResult).mockResolvedValueOnce({
                status: "unavailable",
                error: new Error("temporary storage outage"),
            });
        } else if (failure === "QuotaExceededError") {
            const realBulkDocs = localDB.bulkDocs.bind(localDB);
            authOrQuotaBulkDocsSpy = vi.spyOn(localDB, "bulkDocs").mockImplementation(async (docs, options) => {
                const rows = docs as EntryDoc[];
                if (options?.new_edits !== false && rows.some((row) => row._id === chunkId)) {
                    injectedFailureCount++;
                    throw Object.assign(new Error("database quota exceeded"), { name: "QuotaExceededError" });
                }
                return await realBulkDocs(docs, options);
            });
        } else if (failure.startsWith("HTTP ")) {
            const status = failure.startsWith("HTTP 401") ? 401 : 403;
            const name = status === 401 ? "unauthorized" : "forbidden";
            authOrQuotaBulkDocsSpy = vi.spyOn(localDB, "bulkDocs").mockResolvedValueOnce([
                {
                    id: chunkId,
                    error: name,
                    name,
                    status,
                    message: "injected authorization failure",
                },
            ]);
        } else {
            failReceivedCheckpointWrite = true;
        }

        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        if (failure === "unavailable download") {
            expect(storage.downloadWithResult).toHaveBeenCalledWith(key, true);
            expect(storage.download).not.toHaveBeenCalledWith(key, true);
        } else if (failure === "QuotaExceededError") {
            expect(injectedFailureCount).toBe(1);
        } else if (failure.startsWith("HTTP ")) {
            expect(authOrQuotaBulkDocsSpy).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ _id: chunkId })]),
                { new_edits: true }
            );
        } else {
            expect(failedReceivedCheckpointWrites).toBe(1);
        }
        expect(downloadCount(storage, key)).toBe(1);
        expect(checkpoint.receivedFiles).toEqual(new Set());
        await expect(localDB.get(laterMetadataId)).rejects.toMatchObject({ status: 404 });
    });

    it("retries after the receivedFiles checkpoint write fails on the same core", async () => {
        const key = "085-checkpoint-retry.jsonl.gz";
        const chunkId = "h:checkpoint-retry-" + dbCounter;
        const metadataId = "checkpoint-retry-" + dbCounter;
        await putJournal(key, [
            { _id: chunkId as DocumentID, type: "leaf", data: "retryable data" },
            metadata(metadataId, "1-checkpointretry", chunkId, "retryable data".length),
        ]);
        core.processReplication = async () => true;
        returnCheckpointReference = true;
        failReceivedCheckpointWrite = true;

        await expect(core.receiveRemoteJournal()).resolves.toBe(false);
        expect(failedReceivedCheckpointWrites).toBe(1);
        expect(checkpoint.receivedFiles.has(key)).toBe(false);
        expect(core._currentCheckPointInfo.receivedFiles.has(key)).toBe(false);
        expect(downloadCount(storage, key)).toBe(1);
        await expect(localDB.get(metadataId)).resolves.toMatchObject({ children: [chunkId] });

        failReceivedCheckpointWrite = false;
        await expect(core.receiveRemoteJournal()).resolves.toBe(true);

        expect(downloadCount(storage, key)).toBe(2);
        expect(checkpoint.receivedFiles).toEqual(new Set([key]));
        await expect(localDB.get<EntryLeaf>(chunkId)).resolves.toMatchObject({ data: "retryable data" });
    });

    it("does not skip a malformed in-flight Journal after stop is requested", async () => {
        const key = "095-active-stop.jsonl.gz";
        virtualStorage.set(key, new Uint8Array([1]));

        let resolveDownload!: (result: { status: "available"; value: Uint8Array }) => void;
        const pendingDownload = new Promise<{ status: "available"; value: Uint8Array }>((resolve) => {
            resolveDownload = resolve;
        });
        let signalDownloadStarted!: () => void;
        const downloadStarted = new Promise<void>((resolve) => {
            signalDownloadStarted = resolve;
        });
        vi.mocked(storage.downloadWithResult).mockImplementationOnce(async (downloadKey) => {
            expect(downloadKey).toBe(key);
            signalDownloadStarted();
            return await pendingDownload;
        });

        const malformedPack = await wrappedDeflate(new TextEncoder().encode("~h:missing-separator\n"), {});
        const logs = captureLogs();
        try {
            const receive = core.receiveRemoteJournal();
            await downloadStarted;
            core.requestStop();
            resolveDownload({ status: "available", value: malformedPack });

            await expect(receive).resolves.toBe(false);

            expect(downloadCount(storage, key)).toBe(1);
            expect(checkpoint.receivedFiles.has(key)).toBe(false);
            expect(
                logs.entries.filter(({ message }) => String(message).includes(key) && /skip/i.test(String(message)))
            ).toEqual([]);
            expect(env.services.replicator.replicationStatics.value.syncStatus).toBe("CLOSED");
        } finally {
            logs.restore();
        }
    });

    it("preserves a successful active Metadata write when stop is requested", async () => {
        const key = "096-active-write-stop.jsonl.gz";
        const chunkId = "h:active-write-stop-" + dbCounter;
        const metadataId = "active-write-stop-" + dbCounter;
        const content = "completed active Chunk payload — with 日本語 😀";
        const expectedBytes = new TextEncoder().encode(content);
        await putJournal(key, [
            { _id: chunkId as DocumentID, type: "leaf", data: content },
            metadata(metadataId, "1-activestopwrite", chunkId, expectedBytes.length),
        ]);

        let releaseMetadataWrite!: () => void;
        const metadataWriteGate = new Promise<void>((resolve) => {
            releaseMetadataWrite = resolve;
        });
        let signalMetadataWriteStarted!: () => void;
        const metadataWriteStarted = new Promise<void>((resolve) => {
            signalMetadataWriteStarted = resolve;
        });
        let metadataWriteCount = 0;
        const realBulkDocs = localDB.bulkDocs.bind(localDB);
        vi.spyOn(localDB, "bulkDocs").mockImplementation(async (docs, options) => {
            if (options?.new_edits === false && docs.some((row) => row._id === metadataId)) {
                metadataWriteCount++;
                signalMetadataWriteStarted();
                await metadataWriteGate;
            }
            return await realBulkDocs(docs, options);
        });

        const logs = captureLogs();
        try {
            const receive = core.receiveRemoteJournal();
            await metadataWriteStarted;
            core.requestStop();
            releaseMetadataWrite();

            await expect(receive).resolves.toBe(false);

            expect(metadataWriteCount).toBe(1);
            expect(checkpoint.receivedFiles).toEqual(new Set([key]));
            const persistedMetadata = await localDB.get<EntryDoc>(metadataId, { revs: true });
            expect(persistedMetadata._rev).toBe("1-activestopwrite");
            expect((persistedMetadata as PouchDB.Core.GetMeta)._revisions).toEqual({
                start: 1,
                ids: ["activestopwrite"],
            });
            const persistedChunk = await localDB.get<EntryLeaf>(chunkId);
            expect(new TextEncoder().encode(persistedChunk.data)).toEqual(expectedBytes);
            expect(env.services.replicator.replicationStatics.value.syncStatus).toBe("CLOSED");
            expect(
                logs.entries.filter(({ message }) => String(message).includes(key) && /skip/i.test(String(message)))
            ).toEqual([]);
        } finally {
            releaseMetadataWrite();
            logs.restore();
        }
    });

    it("does not acknowledge a Journal as skipped when a stop is requested before its download", async () => {
        const key = "090-stop.jsonl.gz";
        virtualStorage.set(key, await compressJournal([]));

        vi.mocked(storage.listFiles).mockImplementationOnce(async () => {
            core.requestStop();
            return [key];
        });

        await expect(core.receiveRemoteJournal()).resolves.toBe(false);

        expect(storage.listFiles).toHaveBeenCalled();
        expect(checkpoint.receivedFiles).toEqual(new Set());
        expect(downloadCount(storage, key)).toBe(0);
        expect(env.services.replicator.replicationStatics.value.syncStatus).toBe("CLOSED");
    });
});
