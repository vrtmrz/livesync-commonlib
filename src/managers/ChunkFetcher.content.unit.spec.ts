import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import {
    DEFAULT_SETTINGS,
    E2EEAlgorithms,
    type E2EEAlgorithm,
    type DocumentID,
    type EntryDoc,
    type EntryLeaf,
    type MetaEntry,
    type PlainEntry,
} from "@lib/common/types.ts";
import { getConfiguredFunctionsForEncryption } from "@lib/pouchdb/encryption.ts";
import type { IReplicatorService, ISettingService } from "@lib/services/base/IService.ts";
import { ChunkFetcher, EVENT_CHUNK_FETCHED } from "./ChunkFetcher.ts";
import { LayeredChunkManager } from "./LayeredChunkManager.ts";
import type { ChunkManagerOptions } from "./LayeredChunkManager/types.ts";
import { getDBEntryFromMeta } from "./EntryManager/EntryManagerImpls.ts";

PouchDB.plugin(MemoryAdapter);
const body = "Synthetic plaintext which must not appear in rejection logs.";
let databaseCounter = 0;
const log = vi.fn();

beforeEach(() => {
    log.mockClear();
    setGlobalLogFunction(log);
});
afterEach(() => setGlobalLogFunction(defaultLogger));

async function readRemoteBody(
    remoteDocument: EntryDoc,
    algorithm: E2EEAlgorithm,
    acceptUnencryptedContent: boolean,
    encrypt = true
) {
    const database = new PouchDB<EntryDoc>(`chunk-content-${++databaseCounter}`, { adapter: "memory" });
    const settings = {
        ...DEFAULT_SETTINGS,
        encrypt,
        acceptUnencryptedContent,
        useOnlyLocalChunk: false,
        readChunksOnline: true,
        minimumIntervalOfReadChunksOnline: 1,
    };
    const setting = { currentSettings: () => settings } as ISettingService;
    const manager = new LayeredChunkManager({
        database,
        settingService: setting,
        changeManager: { addCallback: () => () => undefined } as unknown as ChunkManagerOptions["changeManager"],
    });
    const decrypt = getConfiguredFunctionsForEncryption(
        "chunk-content-passphrase",
        false,
        false,
        async () => new Uint8Array(32),
        algorithm,
        false,
        log,
        acceptUnencryptedContent
    ).outgoing;
    const fetchRemoteChunks = vi.fn(async (ids: DocumentID[]) => {
        expect(ids).toEqual([remoteDocument._id]);
        return [encrypt ? await decrypt(remoteDocument) : remoteDocument] as EntryLeaf[];
    });
    const arrived = vi.fn();
    manager.addListener(EVENT_CHUNK_FETCHED, arrived);
    const fetcher = new ChunkFetcher({
        chunkManager: manager,
        settingService: setting,
        replicatorService: {
            getActiveReplicator: () => ({ fetchRemoteChunks }),
            runBoundedRemoteActivity: async (task: () => Promise<unknown>) => await task(),
        } as unknown as IReplicatorService,
    });
    try {
        const metadata: PlainEntry = {
            _id: "fixture.md" as DocumentID,
            type: "plain",
            path: "fixture.md" as PlainEntry["path"],
            children: [remoteDocument._id],
            ctime: 1,
            mtime: 1,
            size: body.length,
            eden: {},
        };
        const receivedMetadata = encrypt ? await decrypt(metadata) : metadata;
        const host = { services: { setting, path: { id2path: () => metadata.path } } };
        const result = await getDBEntryFromMeta(
            host as Parameters<typeof getDBEntryFromMeta>[0],
            { localDatabase: database, chunkManager: manager } as Parameters<typeof getDBEntryFromMeta>[1],
            receivedMetadata as MetaEntry
        );
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        const stored = await database.allDocs({ keys: [remoteDocument._id], include_docs: true });
        return {
            result,
            stored: stored.rows.some((row) => "doc" in row && !!row.doc),
            arrivals: arrived.mock.calls.length,
        };
    } finally {
        fetcher.destroy();
        manager.destroy();
        await database.destroy();
    }
}

describe.each([E2EEAlgorithms.V2, E2EEAlgorithms.ForceV1])("on-demand Chunk content with %s", (algorithm) => {
    describe.each([false, true])("plaintext acceptance %s", (accept) => {
        it.each([
            ["syncinfo", "syncinfo", false],
            ["obsydian_livesync_version", "versioninfo", false],
            ["soft-deleted.md", "plain", true],
            ["_local/forged-chunk", "leaf", false],
        ] as const)(
            "rejects %s as a referenced Chunk without storing, emitting, or logging its body",
            async (id, type, deleted) => {
                const remoteDocument = {
                    _id: id as DocumentID,
                    _rev: "1-0123456789abcdef0123456789abcdef",
                    type,
                    deleted,
                    data: body,
                } as EntryDoc;
                const outcome = await readRemoteBody(remoteDocument, algorithm, accept);
                expect(outcome).toEqual({ result: false, stored: false, arrivals: 0 });
                expect(JSON.stringify(log.mock.calls)).not.toContain(body);
            }
        );
    });

    it("reads a decrypted leaf while plaintext receipt is disabled", async () => {
        const encrypt = getConfiguredFunctionsForEncryption(
            "chunk-content-passphrase",
            false,
            false,
            async () => new Uint8Array(32),
            algorithm
        ).incoming;
        const remote = await encrypt({
            _id: "h:+encrypted" as DocumentID,
            _rev: "1-0123456789abcdef0123456789abcdef",
            type: "leaf",
            data: body,
        });
        const outcome = await readRemoteBody(remote, algorithm, false);
        expect(outcome).toMatchObject({ result: { data: [body] }, stored: true, arrivals: 1 });
    });

    it("reads a third-party plaintext leaf after explicit opt-in", async () => {
        const remote: EntryLeaf = {
            _id: "h:third-party" as DocumentID,
            _rev: "1-0123456789abcdef0123456789abcdef",
            type: "leaf",
            data: body,
        };
        const outcome = await readRemoteBody(remote, algorithm, true);
        expect(outcome).toMatchObject({ result: { data: [body] }, stored: true, arrivals: 1 });
    });

    it("reads an ordinary plaintext leaf with E2EE disabled", async () => {
        const remote: EntryLeaf = {
            _id: "h:unencrypted" as DocumentID,
            _rev: "1-0123456789abcdef0123456789abcdef",
            type: "leaf",
            data: body,
        };
        const outcome = await readRemoteBody(remote, algorithm, false, false);
        expect(outcome).toMatchObject({ result: { data: [body] }, stored: true, arrivals: 1 });
    });
});
