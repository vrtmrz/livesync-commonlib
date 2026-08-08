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

function streamWhichFailsAfterCurrentRows(lines: string[], error: Error) {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
            setTimeout(() => controller.error(error), 10);
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

function changesStatus(available: number, lastSequence: string | number) {
    const results = available > 0 ? [JSON.parse(changeLine(`${lastSequence}-probe-row`, "probe-document"))] : [];
    return {
        results,
        pending: available - results.length,
        last_seq: lastSequence,
    };
}

function queueChangesFeed(
    target: string | number,
    available: number,
    body: string[] | ReadableStream<Uint8Array>,
    pageTerminator: string | number = target
): void {
    fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: target })))
        .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(available, "probe-sequence"))))
        .mockResolvedValueOnce(
            new Response(
                Array.isArray(body) ? textStream([...body, JSON.stringify({ last_seq: pageTerminator })]) : body
            )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(0, pageTerminator))));
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

    it("checkpoints a finite page only after all requested rows are persisted", async () => {
        const localDB = createLocalDatabase("streaming-fetch-target-completion");
        const checkpointSequences: Array<string | number> = [];
        queueChangesFeed(2, 2, [changeLine(1, "doc1", "one"), changeLine(2, "doc2", "two")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        await expect(localDB.get("doc2")).resolves.toMatchObject({ value: "two" });
        expect(checkpointSequences.at(-1)).toBe(2);
    });

    it("uses the bounded feed terminator when the last row sequence differs from last_seq", async () => {
        const localDB = createLocalDatabase("streaming-fetch-bounded-feed-terminator");
        const checkpointSequences: Array<string | number> = [];
        const targetSequence = "2-target-token";
        const rowSequence = "2-row-token";
        queueChangesFeed(targetSequence, 1, [changeLine(rowSequence, "doc1", "one")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
        expect(checkpointSequences.at(-1)).toBe(targetSequence);
        const changesURL = new URL(fetchMock.mock.calls[2][0]);
        expect(changesURL.searchParams.get("feed")).toBe("continuous");
        expect(changesURL.searchParams.get("limit")).toBe("1");
    });

    it("lets CouchDB 3.2 close a bounded page after its current changes are exhausted", async () => {
        const localDB = createLocalDatabase("streaming-fetch-couchdb-3-2-page-completion");
        let probeCount = 0;
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = new URL(input.toString());
            if (url.searchParams.get("since") === "now") {
                return new Response(JSON.stringify({ last_seq: "target-sequence" }));
            }
            if (url.searchParams.get("feed") === "normal") {
                const available = probeCount++ === 0 ? 1 : 0;
                return new Response(JSON.stringify(changesStatus(available, "page-terminator")));
            }
            if (url.searchParams.has("heartbeat")) {
                // CouchDB 3.2 keeps a continuous heartbeat feed open after its
                // finite limit is exhausted. Fail the fixture after delivering the
                // current rows so that this server-side wait is detected promptly.
                return new Response(
                    streamWhichFailsAfterCurrentRows(
                        [changeLine("row-sequence", "doc1", "one")],
                        new Error("CouchDB 3.2 kept the bounded heartbeat feed open")
                    )
                );
            }
            return new Response(
                textStream([
                    changeLine("row-sequence", "doc1", "one"),
                    JSON.stringify({ last_seq: "page-terminator", pending: 0 }),
                ])
            );
        });

        await fetchInitial(localDB);

        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
        const pageUrl = new URL(fetchMock.mock.calls[2][0]);
        expect(pageUrl.searchParams.get("heartbeat")).toBeNull();
        expect(pageUrl.searchParams.get("timeout")).toBe("1000");
    });

    it("continues from each opaque terminator in pages of at most 10,000 rows", async () => {
        const localDB = createLocalDatabase("streaming-fetch-multiple-bounded-pages");
        const firstPageTerminator = "10000-first-page";
        const targetSequence = "10001-target";
        const firstPage = Array.from({ length: 10_000 }, (_, index) => changeLine(index + 1, `doc-${index + 1}`));
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: targetSequence })))
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(10_001, "first-probe"))))
            .mockResolvedValueOnce(
                new Response(textStream([...firstPage, JSON.stringify({ last_seq: firstPageTerminator })]))
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(1, "second-probe"))))
            .mockResolvedValueOnce(
                new Response(
                    textStream([changeLine("10001-row", "doc-10001"), JSON.stringify({ last_seq: targetSequence })])
                )
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(0, targetSequence))));

        await fetchInitial(localDB);

        const firstPageUrl = new URL(fetchMock.mock.calls[2][0]);
        const secondProbeUrl = new URL(fetchMock.mock.calls[3][0]);
        const secondPageUrl = new URL(fetchMock.mock.calls[4][0]);
        expect(firstPageUrl.searchParams.get("since")).toBe("0");
        expect(firstPageUrl.searchParams.get("limit")).toBe("10000");
        expect(secondProbeUrl.searchParams.get("feed")).toBe("normal");
        expect(secondProbeUrl.searchParams.get("since")).toBe(firstPageTerminator);
        expect(secondProbeUrl.searchParams.get("limit")).toBe("1");
        expect(secondPageUrl.searchParams.get("since")).toBe(firstPageTerminator);
        expect(secondPageUrl.searchParams.get("limit")).toBe("1");
    });

    it("re-probes after a valid page which is shorter than the previous estimate", async () => {
        const localDB = createLocalDatabase("streaming-fetch-short-page");
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "progress-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(2, "first-probe"))))
            .mockResolvedValueOnce(
                new Response(
                    textStream([
                        changeLine("first-row", "doc1", "one"),
                        JSON.stringify({ last_seq: "first-terminator" }),
                    ])
                )
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(1, "second-probe"))))
            .mockResolvedValueOnce(
                new Response(
                    textStream([
                        changeLine("second-row", "doc2", "two"),
                        JSON.stringify({ last_seq: "second-terminator" }),
                    ])
                )
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(0, "second-terminator"))));

        await fetchInitial(localDB);

        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
        await expect(localDB.get("doc2")).resolves.toMatchObject({ value: "two" });
        expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get("limit")).toBe("2");
        expect(new URL(fetchMock.mock.calls[3][0]).searchParams.get("since")).toBe("first-terminator");
        expect(new URL(fetchMock.mock.calls[4][0]).searchParams.get("limit")).toBe("1");
    });

    it("fails retryably when a positive probe is followed by a zero-row page", async () => {
        const localDB = createLocalDatabase("streaming-fetch-zero-row-page");
        const checkpointSequences: Array<string | number> = [];
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "progress-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(1, "probe-sequence"))))
            .mockResolvedValueOnce(new Response(textStream([JSON.stringify({ last_seq: "empty-page-terminator" })])));

        await expect(
            fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence))
        ).rejects.toMatchObject({
            stage: "transport",
            retryable: true,
            message: expect.stringContaining("status probe reported available changes"),
        });
        expect(checkpointSequences).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("flushes preceding documents before checkpointing a row without a document", async () => {
        const localDB = createLocalDatabase("streaming-fetch-docless-checkpoint");
        const checkpointSequences: Array<string | number> = [];
        queueChangesFeed(2, 2, [changeLine(1, "doc1", "one"), changeLine(2, "doc2")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        expect(checkpointSequences).toEqual([1, 2, 2]);
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

    it("requires a changes-feed sequence for progress reporting", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-target");
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ db_name: "db" })));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("changes progress target"),
        });
    });

    it("does not treat a missing pending count as proof of completion", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-pending");
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], last_seq: "0-since" })));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("pending count"),
        });
    });

    it("does not treat a missing results list as proof of completion", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-results");
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 0, last_seq: "0-since" })));

        await expect(fetchInitial(localDB)).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("results list"),
        });
    });

    it("does not open a stream when the probe has no results or pending changes", async () => {
        const localDB = createLocalDatabase("streaming-fetch-no-pending-changes");
        const checkpointSequences: Array<string | number> = [];
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "0-target" })))
            .mockResolvedValueOnce(new Response(JSON.stringify(changesStatus(0, "0-since"))));

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        expect(checkpointSequences).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("since")).toBe("now");
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("limit")).toBe("1");
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("include_docs")).toBe("false");
    });

    it("counts the normal-feed result row as available work when pending is zero", async () => {
        const localDB = createLocalDatabase("streaming-fetch-result-plus-pending");
        const checkpointSequences: Array<string | number> = [];
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ last_seq: "progress-target" })))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        results: [JSON.parse(changeLine("row-sequence", "doc1"))],
                        pending: 0,
                        last_seq: "probe-sequence",
                    })
                )
            )
            .mockResolvedValueOnce(
                new Response(
                    textStream([
                        changeLine("row-sequence", "doc1", "one"),
                        JSON.stringify({ last_seq: "page-terminator" }),
                    ])
                )
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ results: [], pending: 0, last_seq: "page-terminator" }))
            );

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
        expect(checkpointSequences.at(-1)).toBe("page-terminator");
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const firstProbeUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(firstProbeUrl.searchParams.get("feed")).toBe("normal");
        expect(firstProbeUrl.searchParams.get("since")).toBe("0");
        expect(firstProbeUrl.searchParams.get("limit")).toBe("1");
        expect(firstProbeUrl.searchParams.get("include_docs")).toBe("false");
        const pageUrl = new URL(fetchMock.mock.calls[2][0]);
        expect(pageUrl.searchParams.get("feed")).toBe("continuous");
        expect(pageUrl.searchParams.get("since")).toBe("0");
        expect(pageUrl.searchParams.get("limit")).toBe("1");
        const finalProbeUrl = new URL(fetchMock.mock.calls[3][0]);
        expect(finalProbeUrl.searchParams.get("since")).toBe("page-terminator");
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
