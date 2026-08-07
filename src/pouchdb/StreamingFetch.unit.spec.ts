import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { fetchChangesForInitialSync } from "./StreamingFetch";

PouchDB.plugin(MemoryAdapter);

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/common/coreEnvFunctions", () => ({
    _fetch: fetchMock,
}));

const remoteDbUrl = "https://example.com/db";
const localDatabases: PouchDB.Database[] = [];

function createLocalDatabase(name: string): PouchDB.Database {
    const database = new PouchDB(name, { adapter: "memory" });
    localDatabases.push(database);
    return database;
}

function textStream(lines: string[]) {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
            controller.close();
        },
    });
}

function openTextStream(lines: string[]) {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
        },
    });
}

function failingStream(error: Error) {
    return new ReadableStream({
        start(controller) {
            controller.error(error);
        },
    });
}

function changeLine(sequence: string | number, id: string, value?: string): string {
    return JSON.stringify({
        seq: sequence,
        id,
        changes: [{ rev: `1-${id}` }],
        ...(value === undefined ? {} : { doc: { _id: id, _rev: `1-${id}`, value } }),
    });
}

function queueChangesFeed(target: string | number, pending: number, body: string[] | ReadableStream<Uint8Array>): void {
    fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: target })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ pending, last_seq: "since" })))
        .mockResolvedValueOnce(new Response(Array.isArray(body) ? textStream(body) : body));
}

function fetchInitial(
    localDatabase: PouchDB.Database,
    decrypt = (doc: any) => Promise.resolve(doc),
    onCheckpoint?: (sequence: string | number) => void
): Promise<void> {
    return fetchChangesForInitialSync(localDatabase, remoteDbUrl, "Basic test", decrypt, "0", undefined, onCheckpoint);
}

beforeEach(() => {
    fetchMock.mockReset();
});

afterEach(async () => {
    await Promise.all(localDatabases.splice(0).map((database) => database.destroy()));
});

describe("fetchChangesForInitialSync", () => {
    it("does not checkpoint a batch when PouchDB reports an individual write failure", async () => {
        const localDB = createLocalDatabase("streaming-fetch-bulk-result-failure");
        const checkpointSequences: Array<string | number> = [];
        vi.spyOn(localDB, "bulkDocs").mockResolvedValueOnce([
            {
                id: "doc1",
                error: true,
                name: "forbidden",
                status: 403,
                message: "write rejected",
            },
        ] as any);
        queueChangesFeed(1, 1, [changeLine(1, "doc1", "one")]);

        await expect(
            fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence))
        ).rejects.toMatchObject({
            stage: "storage",
            retryable: false,
            message: expect.stringContaining("write rejected"),
        });
        expect(checkpointSequences).toEqual([]);
    });

    it("reports a decryption failure instead of skipping the affected row", async () => {
        const localDB = createLocalDatabase("streaming-fetch-decryption-failure");
        const checkpointSequences: Array<string | number> = [];
        queueChangesFeed(1, 1, [changeLine(1, "doc1", "one")]);

        await expect(
            fetchInitial(
                localDB,
                () => Promise.reject(new Error("cannot decrypt doc1")),
                (sequence) => checkpointSequences.push(sequence)
            )
        ).rejects.toMatchObject({
            stage: "decryption",
            retryable: false,
            message: expect.stringContaining("cannot decrypt doc1"),
        });
        expect(checkpointSequences).toEqual([]);
    });

    it("aborts the continuous request when document processing fails terminally", async () => {
        const localDB = createLocalDatabase("streaming-fetch-terminal-abort");
        queueChangesFeed(1, 1, openTextStream([changeLine(1, "doc1", "one")]));

        await expect(
            fetchInitial(localDB, () => Promise.reject(new Error("cannot decrypt doc1")))
        ).rejects.toMatchObject({
            stage: "decryption",
            retryable: false,
        });

        const request = fetchMock.mock.calls[2][1] as RequestInit;
        expect(request.signal?.aborted).toBe(true);
    });

    it("uses the captured target rather than the estimate and checkpoints the persisted target", async () => {
        const localDB = createLocalDatabase("streaming-fetch-target-completion");
        const checkpointSequences: Array<string | number> = [];
        queueChangesFeed(2, 1, [changeLine(1, "doc1", "one"), changeLine(2, "doc2", "two")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        await expect(localDB.get("doc2")).resolves.toMatchObject({ value: "two" });
        expect(checkpointSequences.at(-1)).toBe(2);
    });

    it("flushes preceding documents before checkpointing a row without a document", async () => {
        const localDB = createLocalDatabase("streaming-fetch-docless-checkpoint");
        const checkpointSequences: Array<string | number> = [];
        queueChangesFeed(2, 2, [changeLine(1, "doc1", "one"), changeLine(2, "doc2")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        expect(checkpointSequences).toEqual([1, 2]);
        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
    });

    it("classifies an authentication response as terminal", async () => {
        const localDB = createLocalDatabase("streaming-fetch-authentication-failure");
        fetchMock.mockResolvedValueOnce(new Response("unauthorised", { status: 401 }));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "authentication",
            retryable: false,
            status: 401,
        });
    });

    it("requires an authoritative target sequence from the changes-feed snapshot", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-target");
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ db_name: "db" })));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("authoritative changes target"),
        });
    });

    it("does not treat a missing pending count as proof of completion", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-pending");
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-since" })));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("pending count"),
        });
    });

    it("checkpoints a captured target without opening a stream when no changes are pending", async () => {
        const localDB = createLocalDatabase("streaming-fetch-no-pending-changes");
        const checkpointSequences: Array<string | number> = [];
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 0, last_seq: "0-since" })));

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        expect(checkpointSequences).toEqual(["0-target"]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("since")).toBe("now");
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("limit")).toBe("0");
    });

    it("classifies an external AbortError as a retryable transport failure", async () => {
        const localDB = createLocalDatabase("streaming-fetch-external-abort");
        queueChangesFeed(2, 2, failingStream(new DOMException("network changed", "AbortError")));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            name: "StreamingFetchFailure",
            stage: "transport",
            retryable: true,
        });
    });
});
