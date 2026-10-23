import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import {
    E2EEAlgorithms,
    VERSIONING_DOCID,
    type DocumentID,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types";
import { getConfiguredFunctionsForEncryption } from "./encryption";
import { checkRemoteFeaturesForInitialSync, fetchChangesForInitialSync } from "./StreamingFetch";

PouchDB.plugin(MemoryAdapter);

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/common/coreEnvFunctions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@lib/common/coreEnvFunctions")>()),
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
    const revisionHash = id.replace(/[^a-zA-Z0-9]/g, "") || "revision";
    const rev = `1-${revisionHash}`;
    return JSON.stringify({
        seq: sequence,
        id,
        changes: [{ rev }],
        doc: {
            _id: id,
            _rev: rev,
            _revisions: { start: 1, ids: [revisionHash] },
            ...(value === undefined ? {} : { value }),
        },
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

function remoteFeatureResponse(document?: unknown, totalRows = 1): Response {
    return new Response(
        JSON.stringify({
            total_rows: totalRows,
            rows: [
                document === undefined
                    ? { key: VERSIONING_DOCID, error: "not_found" }
                    : { key: VERSIONING_DOCID, doc: document },
            ],
        })
    );
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

function queueChangesFeedWithBulkGet(
    changeRows: string[],
    pageTerminator: string,
    bulkGetResponse: (requested: Array<{ id: string; rev: string }>) => unknown
) {
    const bulkGetRequests: Array<{ url: URL; init: RequestInit; requested: Array<{ id: string; rev: string }> }> = [];
    let statusProbe = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/_bulk_get")) {
            const requested = JSON.parse(String(init?.body ?? "{}")).docs;
            bulkGetRequests.push({ url, init: init ?? {}, requested });
            const result = bulkGetResponse(requested);
            return result instanceof Response ? result : new Response(JSON.stringify(result));
        }
        if (url.searchParams.get("since") === "now") {
            return new Response(JSON.stringify({ last_seq: pageTerminator }));
        }
        if (url.searchParams.get("feed") === "normal") {
            const available = statusProbe++ === 0 ? changeRows.length : 0;
            return new Response(JSON.stringify(changesStatus(available, pageTerminator)));
        }
        if (url.searchParams.get("feed") === "continuous") {
            return new Response(textStream([...changeRows, JSON.stringify({ last_seq: pageTerminator })]));
        }
        throw new Error(`Unexpected Fast Fetch request: ${url}`);
    });
    return bulkGetRequests;
}

function fetchInitial(
    localDatabase: PouchDB.Database,
    decrypt = (doc: any) => Promise.resolve(doc),
    onCheckpoint?: (sequence: string | number) => void,
    customHeaders?: Record<string, string>,
    onStoredRevisions?: (revisions: readonly { id: string; rev: string }[]) => void | Promise<void>,
    since: string | number = "0"
): Promise<void> {
    return fetchChangesForInitialSync(
        localDatabase,
        remoteDbUrl,
        "Basic test",
        decrypt,
        since,
        undefined,
        onCheckpoint,
        customHeaders,
        onStoredRevisions
    );
}

beforeEach(() => {
    fetchMock.mockReset();
});

afterEach(async () => {
    await Promise.all(localDatabases.splice(0).map((database) => database.destroy()));
});

describe("fetchChangesForInitialSync", () => {
    it("decrypts HKDF metadata before persisting and checkpointing an obfuscated document", async () => {
        const localDB = createLocalDatabase("streaming-fetch-hkdf-metadata");
        const salt = new Uint8Array(16);
        const { incoming, outgoing } = getConfiguredFunctionsForEncryption(
            "fast-fetch-metadata-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const document: PlainEntry = {
            _id: `f:${"d".repeat(64)}` as DocumentID,
            path: "Folder/Poem: Example.md" as FilePathWithPrefix,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: [],
            eden: {},
        };
        const encrypted = await incoming(document);
        expect("path" in encrypted && encrypted.path.startsWith("/\\:")).toBe(true);
        queueChangesFeed(1, 1, [
            JSON.stringify({
                seq: 1,
                id: document._id,
                changes: [{ rev: "1-test" }],
                doc: { ...encrypted, _rev: "1-test", _revisions: { start: 1, ids: ["test"] } },
            }),
        ]);
        const checkpoints: Array<string | number> = [];

        await fetchInitial(localDB, outgoing, (sequence) => checkpoints.push(sequence));

        await expect(localDB.get(document._id)).resolves.toMatchObject(document);
        expect(checkpoints.at(-1)).toBe(1);
    });

    it("sends custom headers on every request without allowing them to override authorisation", async () => {
        const localDB = createLocalDatabase("streaming-fetch-custom-headers");
        const customHeaders = {
            "CF-Access-Client-Id": "client-id",
            "CF-Access-Client-Secret": "client-secret",
            authorization: "Bearer must-not-win",
        };
        queueChangesFeed(1, 1, [changeLine(1, "doc1", "one")]);

        await fetchInitial(localDB, undefined, undefined, customHeaders);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const [, init] of fetchMock.mock.calls) {
            const headers = new Headers((init as RequestInit).headers);
            expect(headers.get("CF-Access-Client-Id")).toBe("client-id");
            expect(headers.get("CF-Access-Client-Secret")).toBe("client-secret");
            expect(headers.get("Authorization")).toBe("Basic test");
        }
    });

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

    it("fetches revisions from a changes row without an included document", async () => {
        const localDB = createLocalDatabase("streaming-fetch-docless-checkpoint");
        const checkpointSequences: Array<string | number> = [];
        const missingDocument = {
            _id: "doc2",
            _rev: "1-doc2",
            _revisions: { start: 1, ids: ["doc2"] },
            value: "two from _bulk_get",
        };
        const bulkGetRequests = queueChangesFeedWithBulkGet(
            [
                changeLine(1, "doc1", "one"),
                JSON.stringify({ seq: 2, id: "doc2", changes: [{ rev: missingDocument._rev }] }),
            ],
            "docless-page",
            (requested) => ({
                results: [
                    {
                        id: "doc2",
                        docs: requested.map(({ rev }) => ({
                            ok: rev === missingDocument._rev ? missingDocument : undefined,
                        })),
                    },
                ],
            })
        );

        await fetchInitial(localDB, undefined, (sequence) => checkpointSequences.push(sequence));

        await expect(localDB.get("doc1")).resolves.toMatchObject({ value: "one" });
        await expect(localDB.get("doc2")).resolves.toMatchObject({ value: "two from _bulk_get" });
        expect(bulkGetRequests).toHaveLength(1);
        expect(bulkGetRequests[0].requested).toEqual([{ id: "doc2", rev: "1-doc2" }]);
        expect(checkpointSequences.at(-1)).toBe("docless-page");
    });

    it("reconstructs generation-one ancestry from an included revision without _revisions", async () => {
        const localDB = createLocalDatabase("streaming-fetch-generation-one-without-ancestry");
        const document = { _id: "generation-one", _rev: "1-winner", value: "included winner" };
        const row = JSON.stringify({
            seq: "generation-one-row",
            id: document._id,
            changes: [{ rev: document._rev }],
            doc: document,
        });
        const bulkGetRequests = queueChangesFeedWithBulkGet([row], "generation-one-page", () => ({ results: [] }));

        await fetchInitial(localDB);

        await expect(localDB.get(document._id, { revs: true })).resolves.toMatchObject({
            _revisions: { start: 1, ids: ["winner"] },
            value: "included winner",
        });
        expect(bulkGetRequests).toHaveLength(0);
    });

    it("fetches actual ancestry for a generation-two included revision without _revisions", async () => {
        const localDB = createLocalDatabase("streaming-fetch-generation-two-without-ancestry");
        const id = "generation-two";
        const feedDocument = { _id: id, _rev: "2-winner", value: "included winner" };
        const storedDocument = {
            ...feedDocument,
            _revisions: { start: 2, ids: ["winner", "root"] },
        };
        const row = JSON.stringify({
            seq: "generation-two-row",
            id,
            changes: [{ rev: feedDocument._rev }],
            doc: feedDocument,
        });
        const bulkGetRequests = queueChangesFeedWithBulkGet([row], "generation-two-page", (requested) => ({
            results: [
                {
                    id,
                    docs: requested.map(({ rev }) => ({
                        ok: rev === storedDocument._rev ? storedDocument : undefined,
                    })),
                },
            ],
        }));
        const customHeaders = { "X-Proxy-Identity": "generation-two" };

        await fetchInitial(localDB, undefined, undefined, customHeaders);

        await expect(localDB.get(id, { revs: true })).resolves.toMatchObject({
            _revisions: storedDocument._revisions,
            value: "included winner",
        });
        expect(bulkGetRequests).toHaveLength(1);
        expect(bulkGetRequests[0].requested).toEqual([{ id, rev: feedDocument._rev }]);
        expect(bulkGetRequests[0].url.searchParams.get("revs")).toBe("true");
        const headers = new Headers(bulkGetRequests[0].init.headers);
        expect(headers.get("Authorization")).toBe("Basic test");
        expect(headers.get("X-Proxy-Identity")).toBe("generation-two");
    });

    it("fetches every current leaf revision, including a deleted conflict", async () => {
        const localDB = createLocalDatabase("streaming-fetch-conflict-leaves");
        const winner = {
            _id: "conflicted",
            _rev: "3-winner",
            _revisions: { start: 3, ids: ["winner", "parent", "root"] },
            value: "winner",
        };
        const liveConflict = {
            _id: "conflicted",
            _rev: "2-live",
            _revisions: { start: 2, ids: ["live", "root"] },
            value: "live conflict",
        };
        const deletedConflict = {
            _id: "conflicted",
            _rev: "2-deleted",
            _deleted: true,
            _revisions: { start: 2, ids: ["deleted", "root"] },
        };
        const secondWinner = {
            _id: "second-conflicted",
            _rev: "2-secondwinner",
            _revisions: { start: 2, ids: ["secondwinner", "root"] },
            value: "second winner",
        };
        const secondConflict = {
            _id: "second-conflicted",
            _rev: "2-secondconflict",
            _revisions: { start: 2, ids: ["secondconflict", "root"] },
            value: "second conflict",
        };
        const row = JSON.stringify({
            seq: "conflict-row",
            id: "conflicted",
            changes: [{ rev: winner._rev }, { rev: liveConflict._rev }, { rev: deletedConflict._rev }],
            doc: winner,
        });
        const secondRow = JSON.stringify({
            seq: "second-conflict-row",
            id: "second-conflicted",
            changes: [{ rev: secondWinner._rev }, { rev: secondConflict._rev }],
            doc: secondWinner,
        });
        const bodies = new Map([
            [winner._rev, winner],
            [liveConflict._rev, liveConflict],
            [deletedConflict._rev, deletedConflict],
            [secondWinner._rev, secondWinner],
            [secondConflict._rev, secondConflict],
        ]);
        const bulkGetRequests = queueChangesFeedWithBulkGet([row, secondRow], "conflict-page", (requested) => {
            const byId = new Map<string, Array<{ ok: unknown }>>();
            for (const ref of requested) {
                const docs = byId.get(ref.id) ?? [];
                docs.push({ ok: bodies.get(ref.rev) });
                byId.set(ref.id, docs);
            }
            return { results: [...byId].map(([id, docs]) => ({ id, docs })) };
        });
        const checkpoints: Array<string | number> = [];
        const storedRevisionBatches: Array<readonly { id: string; rev: string }[]> = [];
        const eventOrder: string[] = [];
        const customHeaders = { "X-Proxy-Identity": "fast-fetch", authorization: "Bearer ignored" };

        await fetchInitial(
            localDB,
            undefined,
            (sequence) => {
                checkpoints.push(sequence);
                eventOrder.push("checkpoint");
            },
            customHeaders,
            (revisions) => {
                storedRevisionBatches.push(revisions);
                eventOrder.push("stored");
            }
        );

        const diff = await localDB.revsDiff({
            conflicted: [winner._rev, liveConflict._rev, deletedConflict._rev],
            "second-conflicted": [secondWinner._rev, secondConflict._rev],
        });
        expect(diff).toEqual({});
        await expect(localDB.get("conflicted", { rev: liveConflict._rev })).resolves.toMatchObject({
            value: "live conflict",
        });
        await expect(localDB.get("second-conflicted", { rev: secondConflict._rev })).resolves.toMatchObject({
            value: "second conflict",
        });
        expect(bulkGetRequests).toHaveLength(1);
        expect(bulkGetRequests[0].url.pathname).toBe("/db/_bulk_get");
        expect(bulkGetRequests[0].url.searchParams.get("revs")).toBe("true");
        const bulkGetHeaders = new Headers(bulkGetRequests[0].init.headers);
        expect(bulkGetRequests[0].init.method).toBe("POST");
        expect(bulkGetHeaders.get("Authorization")).toBe("Basic test");
        expect(bulkGetHeaders.get("X-Proxy-Identity")).toBe("fast-fetch");
        expect(bulkGetHeaders.get("Content-Type")).toBe("application/json");
        expect(bulkGetRequests[0].requested).toContainEqual({ id: "conflicted", rev: liveConflict._rev });
        expect(bulkGetRequests[0].requested).toContainEqual({ id: "conflicted", rev: deletedConflict._rev });
        expect(bulkGetRequests[0].requested).toContainEqual({ id: "second-conflicted", rev: secondConflict._rev });
        expect(storedRevisionBatches.flat()).toEqual(
            expect.arrayContaining([
                { id: "conflicted", rev: winner._rev },
                { id: "conflicted", rev: liveConflict._rev },
                { id: "conflicted", rev: deletedConflict._rev },
                { id: "second-conflicted", rev: secondWinner._rev },
                { id: "second-conflicted", rev: secondConflict._rev },
            ])
        );
        expect(eventOrder.indexOf("stored")).toBeLessThan(eventOrder.indexOf("checkpoint"));
        expect(checkpoints.at(-1)).toBe("conflict-page");
    });

    it("groups missing generation-two winners across inline generation-one rows", async () => {
        const localDB = createLocalDatabase("streaming-fetch-grouped-missing-winners");
        const missingWinners = [
            { id: "metadata-a", rev: "2-leafa", value: "metadata a" },
            { id: "metadata-b", rev: "2-leafb", value: "metadata b" },
        ];
        const missingWinnerBodies = new Map(
            missingWinners.map(({ id, rev, value }) => [
                `${id}\u0000${rev}`,
                { _id: id, _rev: rev, _revisions: { start: 2, ids: [rev.slice(2), "parent"] }, value },
            ])
        );
        const winnerRows = missingWinners.map(({ id, rev, value }, index) =>
            JSON.stringify({ seq: `metadata-${index}`, id, changes: [{ rev }], doc: { _id: id, _rev: rev, value } })
        );
        const inlineRows = (group: string, start: number) =>
            Array.from({ length: 99 }, (_, index) => {
                const id = `chunk-${group}-${index}`;
                const rev = `1-${id.replace(/-/g, "")}`;
                return JSON.stringify({
                    seq: `chunk-${start + index}`,
                    id,
                    changes: [{ rev }],
                    doc: { _id: id, _rev: rev, _revisions: { start: 1, ids: [id] }, value: "chunk" },
                });
            });
        const rows = [winnerRows[0], ...inlineRows("a", 0), winnerRows[1], ...inlineRows("b", 99)];
        const bulkGetRequests = queueChangesFeedWithBulkGet(rows, "grouped-winners-page", (requested) => ({
            results: requested.map(({ id, rev }) => ({
                id,
                docs: [{ ok: missingWinnerBodies.get(`${id}\u0000${rev}`) }],
            })),
        }));

        await fetchInitial(localDB);

        expect(bulkGetRequests).toHaveLength(1);
        expect(bulkGetRequests[0].requested).toEqual(missingWinners.map(({ id, rev }) => ({ id, rev })));
        expect(bulkGetRequests[0].requested.length).toBeLessThanOrEqual(100);
        expect((await localDB.allDocs()).rows).toHaveLength(rows.length);
    });

    it("splits an oversized multi-revision response and allows a large singleton response", async () => {
        const localDB = createLocalDatabase("streaming-fetch-split-large-bulk-get");
        const largeData = "x".repeat(550 * 1024);
        const winner = {
            _id: "large-conflicted",
            _rev: "1-winner",
            _revisions: { start: 1, ids: ["winner"] },
            value: "winner",
        };
        const liveConflict = {
            _id: "large-conflicted",
            _rev: "1-live",
            _revisions: { start: 1, ids: ["live"] },
            value: largeData,
        };
        const secondConflict = {
            _id: "large-conflicted",
            _rev: "1-second",
            _revisions: { start: 1, ids: ["second"] },
            value: largeData,
        };
        const bodies = new Map([
            [liveConflict._rev, liveConflict],
            [secondConflict._rev, secondConflict],
        ]);
        const row = JSON.stringify({
            seq: "large-conflict-row",
            id: winner._id,
            changes: [{ rev: winner._rev }, { rev: liveConflict._rev }, { rev: secondConflict._rev }],
            doc: winner,
        });
        const bulkGetRequests = queueChangesFeedWithBulkGet([row], "large-conflict-page", (requested) => ({
            results: [
                {
                    id: winner._id,
                    docs: requested.map(({ rev }) => ({ ok: bodies.get(rev) })),
                },
            ],
        }));

        await fetchInitial(localDB);

        expect(bulkGetRequests).toHaveLength(3);
        expect(bulkGetRequests.map(({ requested }) => requested.length)).toEqual([2, 1, 1]);
        await expect(localDB.get(winner._id, { rev: liveConflict._rev })).resolves.toMatchObject({
            value: largeData,
        });
        await expect(
            localDB.revsDiff({ [winner._id]: [winner._rev, liveConflict._rev, secondConflict._rev] })
        ).resolves.toEqual({});
    });

    it("keeps the checkpoint at the completed prefix after a wide conflict row fails and replays missing leaves", async () => {
        const localDB = createLocalDatabase("streaming-fetch-wide-conflict-late-bulk-get-failure");
        const conflictId = "wide-conflict";
        const leafRevisions = [
            "1-winner",
            ...Array.from({ length: 101 }, (_, index) => `1-leaf${String(index).padStart(3, "0")}`),
        ];
        const revisionDocument = (id: string, rev: string) => ({
            _id: id,
            _rev: rev,
            _revisions: { start: 1, ids: [rev.slice(2)] },
            value: rev,
        });
        const conflictRow = JSON.stringify({
            seq: "conflict-row",
            id: conflictId,
            changes: leafRevisions.map((rev) => ({ rev })),
            doc: revisionDocument(conflictId, leafRevisions[0]),
        });
        const rows = [
            changeLine("before-conflict", "before-conflict", "before"),
            conflictRow,
            changeLine("after-conflict", "after-conflict", "after"),
        ];
        const bulkGetResponse = (requested: Array<{ id: string; rev: string }>) => ({
            results: requested.map(({ id, rev }) => ({
                id,
                docs: [{ ok: revisionDocument(id, rev) }],
            })),
        });
        const checkpoints: Array<string | number> = [];
        const checkpointSnapshots: Array<{ sequence: string | number; missingConflictRevisions: string[] }> = [];
        const storedBatches: Array<Array<{ id: string; rev: string }>> = [];
        let lastPersistedCursor: string | number = "0";
        let bulkGetCount = 0;
        const failedRequests = queueChangesFeedWithBulkGet(rows, "failed-conflict-page", (requested) => {
            bulkGetCount++;
            return bulkGetCount === 2 ? new Response("not JSON") : bulkGetResponse(requested);
        });

        await expect(
            fetchInitial(
                localDB,
                undefined,
                async (sequence) => {
                    checkpoints.push(sequence);
                    lastPersistedCursor = sequence;
                    const difference = await localDB.revsDiff({ [conflictId]: leafRevisions });
                    checkpointSnapshots.push({
                        sequence,
                        missingConflictRevisions: difference[conflictId]?.missing ?? [],
                    });
                },
                undefined,
                async (revisions) => {
                    const batch = [...revisions];
                    for (const { id, rev } of batch) {
                        await expect(localDB.get(id, { rev })).resolves.toMatchObject({ _id: id, _rev: rev });
                    }
                    storedBatches.push(batch);
                }
            )
        ).rejects.toMatchObject({ stage: "protocol", retryable: false });

        expect(failedRequests.map(({ requested }) => requested.length)).toEqual([100, 1]);
        expect(checkpoints).toContain("before-conflict");
        expect(checkpoints).not.toContain("conflict-row");
        expect(checkpoints).not.toContain("after-conflict");
        expect(lastPersistedCursor).toBe("before-conflict");
        expect(
            checkpointSnapshots.find(({ sequence }) => sequence === "before-conflict")?.missingConflictRevisions.length
        ).toBeGreaterThan(0);
        expect(storedBatches.some((batch) => batch.length === 100)).toBe(true);
        expect(storedBatches.flat()).toContainEqual({ id: "before-conflict", rev: "1-beforeconflict" });
        expect(storedBatches.flat()).toContainEqual({ id: conflictId, rev: leafRevisions[0] });

        const partialDifference = await localDB.revsDiff({ [conflictId]: leafRevisions });
        expect(partialDifference[conflictId]?.missing.length).toBeGreaterThan(0);
        expect(partialDifference[conflictId]?.missing.length).toBeLessThan(leafRevisions.length);

        const revisionsMissingBeforeReplay = partialDifference[conflictId]?.missing ?? [];
        const replayRows = [conflictRow, changeLine("after-conflict", "after-conflict", "after")];
        const replayRequests = queueChangesFeedWithBulkGet(replayRows, "replay-page", bulkGetResponse);
        const replayCheckpoints: Array<string | number> = [];
        const replayCheckpointSnapshots: Array<{ sequence: string | number; missingConflictRevisions: string[] }> = [];

        await fetchInitial(
            localDB,
            undefined,
            async (sequence) => {
                replayCheckpoints.push(sequence);
                const difference = await localDB.revsDiff({ [conflictId]: leafRevisions });
                replayCheckpointSnapshots.push({
                    sequence,
                    missingConflictRevisions: difference[conflictId]?.missing ?? [],
                });
            },
            undefined,
            async (revisions) => {
                for (const { id, rev } of revisions) {
                    await expect(localDB.get(id, { rev })).resolves.toMatchObject({ _id: id, _rev: rev });
                }
            },
            lastPersistedCursor
        );

        expect(replayRequests).toHaveLength(1);
        expect(replayRequests[0].requested).toEqual(
            revisionsMissingBeforeReplay.map((rev) => ({ id: conflictId, rev }))
        );
        expect(replayCheckpoints).toContain("replay-page");
        expect(
            replayCheckpointSnapshots.find(({ sequence }) => sequence === "replay-page")?.missingConflictRevisions
        ).toEqual([]);
        const replayContinuousRequests = fetchMock.mock.calls
            .map(([input]) => new URL(String(input)))
            .filter((url) => url.searchParams.get("feed") === "continuous");
        expect(replayContinuousRequests.at(-1)?.searchParams.get("since")).toBe(String(lastPersistedCursor));
        await expect(localDB.revsDiff({ [conflictId]: leafRevisions })).resolves.toEqual({});
        await expect(localDB.get("after-conflict")).resolves.toMatchObject({ value: "after" });
    });

    it("does not checkpoint a conflict row when the second singleton from a split response fails", async () => {
        const localDB = createLocalDatabase("streaming-fetch-split-bulk-get-late-failure");
        const id = "split-conflict";
        const largeValue = "x".repeat(270 * 1024);
        const leafRevisions = ["1-winner", "1-first", "1-second"];
        const revisionDocument = (rev: string) => ({
            _id: id,
            _rev: rev,
            _revisions: { start: 1, ids: [rev.slice(2)] },
            value: largeValue,
        });
        const row = JSON.stringify({
            seq: "split-conflict-row",
            id,
            changes: leafRevisions.map((rev) => ({ rev })),
            doc: { ...revisionDocument(leafRevisions[0]), value: "winner" },
        });
        let splitResponseBytes = 0;
        const requests = queueChangesFeedWithBulkGet([row], "split-failure-page", (requested) => {
            if (requested.length === 2) {
                const response = JSON.stringify({
                    results: requested.map(({ rev }) => ({
                        id,
                        docs: [{ ok: revisionDocument(rev) }],
                    })),
                });
                splitResponseBytes = new TextEncoder().encode(response).byteLength;
                return new Response(response);
            }
            if (requested[0].rev === leafRevisions[1]) {
                return new Response(
                    JSON.stringify({
                        results: [{ id, docs: [{ ok: revisionDocument(leafRevisions[1]) }] }],
                    })
                );
            }
            return new Response(
                JSON.stringify({
                    results: [{ id, docs: [{ error: "not_found", reason: "second split group is unavailable" }] }],
                })
            );
        });
        const checkpoints: Array<string | number> = [];
        const storedBatches: Array<Array<{ id: string; rev: string }>> = [];

        await expect(
            fetchInitial(
                localDB,
                undefined,
                (sequence) => checkpoints.push(sequence),
                undefined,
                async (revisions) => {
                    const batch = [...revisions];
                    for (const { id: storedId, rev } of batch) {
                        await expect(localDB.get(storedId, { rev })).resolves.toMatchObject({
                            _id: storedId,
                            _rev: rev,
                        });
                    }
                    storedBatches.push(batch);
                }
            )
        ).rejects.toMatchObject({ stage: "protocol", retryable: false });

        expect(splitResponseBytes).toBeGreaterThan(512 * 1024);
        expect(requests.map(({ requested }) => requested.length)).toEqual([2, 1, 1]);
        expect(requests.map(({ requested }) => requested[0].rev)).toEqual([
            leafRevisions[1],
            leafRevisions[1],
            leafRevisions[2],
        ]);
        expect(checkpoints).toEqual([]);
        const storedSplitRevisions = new Set(
            storedBatches
                .flat()
                .filter(({ id: storedId }) => storedId === id)
                .map(({ rev }) => rev)
        );
        expect(storedSplitRevisions.has(leafRevisions[1])).toBe(true);
        const difference = await localDB.revsDiff({ [id]: leafRevisions });
        expect(difference[id]?.missing).toContain(leafRevisions[2]);
        expect(difference[id]?.missing).not.toContain(leafRevisions[1]);
    });

    it("waits for stored revision observers to finish before checkpointing", async () => {
        const localDB = createLocalDatabase("streaming-fetch-delayed-stored-revision-observer");
        const row = changeLine("delayed-observer-row", "delayed-observer", "stored");
        const document = JSON.parse(row).doc;
        const checkpoints: Array<string | number> = [];
        let signalObserverStarted!: () => void;
        const observerStarted = new Promise<void>((resolve) => {
            signalObserverStarted = resolve;
        });
        let releaseObserver!: () => void;
        const observerGate = new Promise<void>((resolve) => {
            releaseObserver = resolve;
        });
        queueChangesFeed(1, 1, [row]);

        const fetchPromise = fetchInitial(
            localDB,
            undefined,
            (sequence) => checkpoints.push(sequence),
            undefined,
            async (revisions) => {
                expect(revisions).toEqual([{ id: document._id, rev: document._rev }]);
                await expect(localDB.get(document._id, { rev: document._rev })).resolves.toMatchObject({
                    _id: document._id,
                    _rev: document._rev,
                });
                signalObserverStarted();
                await observerGate;
            }
        );

        await observerStarted;
        const checkpointsBeforeObserverRelease = [...checkpoints];
        releaseObserver();
        await fetchPromise;

        expect(checkpointsBeforeObserverRelease).toEqual([]);
        expect(checkpoints).toContain("delayed-observer-row");
    });

    it("does not checkpoint when stored revision observers reject", async () => {
        const localDB = createLocalDatabase("streaming-fetch-rejected-stored-revision-observer");
        const row = changeLine("rejected-observer-row", "rejected-observer", "stored");
        const document = JSON.parse(row).doc;
        const checkpoints: Array<string | number> = [];
        queueChangesFeed(1, 1, [row]);

        await expect(
            fetchInitial(
                localDB,
                undefined,
                (sequence) => checkpoints.push(sequence),
                undefined,
                async (revisions) => {
                    expect(revisions).toEqual([{ id: document._id, rev: document._rev }]);
                    await expect(localDB.get(document._id, { rev: document._rev })).resolves.toMatchObject({
                        _id: document._id,
                        _rev: document._rev,
                    });
                    throw new Error("identity store unavailable");
                }
            )
        ).rejects.toMatchObject({
            stage: "storage",
            retryable: false,
            message: expect.stringContaining("identity store unavailable"),
        });

        expect(checkpoints).toEqual([]);
        await expect(localDB.get(document._id, { rev: document._rev })).resolves.toMatchObject({
            _id: document._id,
            _rev: document._rev,
        });
    });

    it("does not checkpoint a row whose missing leaf revision cannot be fetched", async () => {
        const localDB = createLocalDatabase("streaming-fetch-missing-conflict-leaf");
        const row = JSON.stringify({
            seq: "incomplete-row",
            id: "conflicted",
            changes: [{ rev: "1-winner" }, { rev: "1-missing" }],
            doc: {
                _id: "conflicted",
                _rev: "1-winner",
                _revisions: { start: 1, ids: ["winner"] },
                value: "winner",
            },
        });
        const checkpoints: Array<string | number> = [];
        queueChangesFeedWithBulkGet([row], "incomplete-page", (requested) => ({
            results: requested.map(({ id, rev }) => ({
                id,
                docs: [{ error: "not_found", reason: `missing ${rev}` }],
            })),
        }));

        await expect(fetchInitial(localDB, undefined, (sequence) => checkpoints.push(sequence))).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
        });
        expect(checkpoints).not.toContain("incomplete-row");
        expect(checkpoints).not.toContain("incomplete-page");
    });

    it.each([
        {
            label: "malformed response",
            stage: "protocol",
            response: () => new Response("not JSON"),
        },
        {
            label: "HTTP forbidden response",
            stage: "authentication",
            response: () => new Response("forbidden", { status: 403 }),
        },
        {
            label: "forbidden revision result",
            stage: "authentication",
            response: () => ({ results: [{ id: "conflicted", docs: [{ error: "forbidden" }] }] }),
        },
    ])("does not checkpoint when _bulk_get returns a $label", async ({ stage, response }) => {
        const localDB = createLocalDatabase(`streaming-fetch-${stage}-bulk-get`);
        const row = JSON.stringify({
            seq: "incomplete-row",
            id: "conflicted",
            changes: [{ rev: "1-winner" }, { rev: "1-missing" }],
            doc: {
                _id: "conflicted",
                _rev: "1-winner",
                _revisions: { start: 1, ids: ["winner"] },
                value: "winner",
            },
        });
        const checkpoints: Array<string | number> = [];
        queueChangesFeedWithBulkGet([row], "incomplete-page", () => response());

        await expect(fetchInitial(localDB, undefined, (sequence) => checkpoints.push(sequence))).rejects.toMatchObject({
            stage,
            retryable: false,
        });
        expect(checkpoints).not.toContain("incomplete-row");
        expect(checkpoints).not.toContain("incomplete-page");
    });

    it("skips writing an included revision that is already present locally", async () => {
        const localDB = createLocalDatabase("streaming-fetch-existing-leaf");
        const document = JSON.parse(changeLine(1, "already-stored", "existing body")).doc;
        await localDB.bulkDocs([document], { new_edits: false });
        const localBulkDocs = vi.spyOn(localDB, "bulkDocs");
        const checkpoints: Array<string | number> = [];
        queueChangesFeed(1, 1, [changeLine(1, "already-stored", "existing body")]);

        await fetchInitial(localDB, undefined, (sequence) => checkpoints.push(sequence));

        expect(localBulkDocs).not.toHaveBeenCalled();
        expect(checkpoints.at(-1)).toBe(1);
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

describe("checkRemoteFeaturesForInitialSync", () => {
    it.each([
        { local: 0, features: ["nfc-path-identity-v1"] },
        { local: 1, features: [] },
    ])("rejects a path identity mismatch before fetching ($local)", async ({ local, features }) => {
        fetchMock.mockResolvedValueOnce(
            remoteFeatureResponse({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: features,
            })
        );
        await expect(
            checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test", undefined, { pathNormalizationVersion: local })
        ).rejects.toThrow(/path identity/);
    });

    it.each(["not JSON", "null", '{"rows":[null]}'])("rejects a malformed response: %s", async (body) => {
        fetchMock.mockResolvedValueOnce(new Response(body));
        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
        });
    });

    const versionInfo = (version: number, used_features?: unknown, deleted = false) => ({
        _id: VERSIONING_DOCID,
        type: "versioninfo",
        version,
        ...(used_features === undefined ? {} : { used_features }),
        ...(deleted ? { _deleted: true } : {}),
    });

    it("rejects any unknown feature name, including beside a known feature", async () => {
        fetchMock.mockResolvedValueOnce(
            remoteFeatureResponse(versionInfo(13, ["encrypted-internal-metadata-v1", "future-index-v2"]))
        );

        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
            message: expect.stringContaining("future-index-v2"),
        });
    });

    it.each([
        ["generation 13 without a feature list", versionInfo(13)],
        ["a future generation", versionInfo(14, [])],
        ["a deleted generation 13 document", versionInfo(13, [], true)],
    ])("rejects %s", async (_label, document) => {
        fetchMock.mockResolvedValueOnce(remoteFeatureResponse(document));

        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
        });
    });

    it("rejects a missing version document in a populated remote", async () => {
        fetchMock.mockResolvedValueOnce(remoteFeatureResponse(undefined, 1));

        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "protocol",
            retryable: false,
        });
    });

    it.each([
        ["an empty remote", remoteFeatureResponse(undefined, 0)],
        ["legacy generation 11", remoteFeatureResponse(versionInfo(11))],
        ["generation 12", remoteFeatureResponse(versionInfo(12))],
        [
            "generation 13 with the supported feature",
            remoteFeatureResponse(versionInfo(13, ["encrypted-internal-metadata-v1"])),
        ],
    ])("allows %s", async (_label, response) => {
        fetchMock.mockResolvedValueOnce(response);

        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).resolves.toBeUndefined();
    });

    it("sends the version query with authentication and custom headers", async () => {
        fetchMock.mockResolvedValueOnce(remoteFeatureResponse(versionInfo(12)));

        await checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic expected", {
            "X-Custom-Header": "custom-value",
            authorization: "Bearer must-not-win",
        });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const requestURL = new URL(url);
        const headers = new Headers(init.headers);
        expect(requestURL.pathname).toBe("/db/_all_docs");
        expect(JSON.parse(requestURL.searchParams.get("keys") ?? "null")).toEqual([VERSIONING_DOCID]);
        expect(requestURL.searchParams.get("include_docs")).toBe("true");
        expect(headers.get("Authorization")).toBe("Basic expected");
        expect(headers.get("X-Custom-Header")).toBe("custom-value");
        expect(headers.get("Accept")).toBe("application/json");
    });

    it("classifies authentication and transport failures", async () => {
        fetchMock.mockResolvedValueOnce(new Response("unauthorised", { status: 401 }));
        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "authentication",
            retryable: false,
            status: 401,
        });

        fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
        await expect(checkRemoteFeaturesForInitialSync(remoteDbUrl, "Basic test")).rejects.toMatchObject({
            stage: "transport",
            retryable: true,
        });
    });
});
