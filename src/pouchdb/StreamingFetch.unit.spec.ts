import { beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { fetchChangesForInitialSync } from "./StreamingFetch";

PouchDB.plugin(MemoryAdapter);

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/common/coreEnvFunctions", () => ({
    _fetch: fetchMock,
}));

const SECRET_HEADER_VALUE = "super-secret-token";
const CUSTOM_HEADERS = {
    "CF-Access-Client-Id": "client-id",
    "CF-Access-Client-Secret": SECRET_HEADER_VALUE,
};

beforeEach(() => {
    fetchMock.mockReset();
});

function textStream(lines: string[]) {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
            controller.close();
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

describe("fetchChangesForInitialSync", () => {
    it("reports the last persisted sequence for resumable fast fetch", async () => {
        const localDB = new PouchDB("streaming-fetch-checkpoint", {
            adapter: "memory",
        });
        const checkpointSequences: Array<string | number> = [];

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ update_seq: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 1, last_seq: 1 })))
            .mockResolvedValueOnce(
                new Response(
                    textStream([
                        JSON.stringify({
                            seq: 1,
                            id: "doc1",
                            changes: [{ rev: "1-a" }],
                            doc: { _id: "doc1", _rev: "1-a", value: "one" },
                        }),
                        JSON.stringify({
                            seq: 2,
                            id: "doc2",
                            changes: [{ rev: "1-b" }],
                            doc: { _id: "doc2", _rev: "1-b", value: "two" },
                        }),
                    ])
                )
            );

        await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            (sequence) => {
                checkpointSequences.push(sequence);
            }
        );

        expect(checkpointSequences[checkpointSequences.length - 1]).toBe(2);
        await expect(localDB.get("doc2")).resolves.toMatchObject({ value: "two" });

        await localDB.destroy();
    });

    it("does not treat an external AbortError as successful completion", async () => {
        const localDB = new PouchDB("streaming-fetch-external-abort", {
            adapter: "memory",
        });

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ update_seq: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 1, last_seq: 1 })))
            .mockResolvedValueOnce(new Response(failingStream(new DOMException("network changed", "AbortError"))));

        await expect(
            fetchChangesForInitialSync(
                localDB,
                "https://example.com/db",
                "Basic test",
                (doc) => Promise.resolve(doc as any),
                "0"
            )
        ).rejects.toMatchObject({ name: "AbortError" });

        await localDB.destroy();
    });

    // Queue successful responses for the database information, the changes summary, and the changes stream.
    function mockSuccessfulSequence() {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ update_seq: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 1, last_seq: 1 })))
            .mockResolvedValueOnce(
                new Response(
                    textStream([
                        JSON.stringify({
                            seq: 1,
                            id: "doc1",
                            changes: [{ rev: "1-a" }],
                            doc: { _id: "doc1", _rev: "1-a", value: "one" },
                        }),
                        JSON.stringify({
                            seq: 2,
                            id: "doc2",
                            changes: [{ rev: "1-b" }],
                            doc: { _id: "doc2", _rev: "1-b", value: "two" },
                        }),
                    ])
                )
            );
    }

    it("sends the configured custom headers on every request", async () => {
        const localDB = new PouchDB("streaming-fetch-custom-headers", { adapter: "memory" });
        mockSuccessfulSequence();

        await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            undefined,
            CUSTOM_HEADERS
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[1].headers).toMatchObject(CUSTOM_HEADERS);
        }

        await localDB.destroy();
    });

    it("does not allow custom headers to override the authorisation header", async () => {
        const localDB = new PouchDB("streaming-fetch-auth-precedence", { adapter: "memory" });
        mockSuccessfulSequence();

        await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            undefined,
            { ...CUSTOM_HEADERS, Authorization: "Basic overridden" }
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[1].headers.Authorization).toBe("Basic test");
        }

        await localDB.destroy();
    });

    it("keeps the request headers unchanged when no custom headers are configured", async () => {
        const localDB = new PouchDB("streaming-fetch-no-custom-headers", { adapter: "memory" });
        mockSuccessfulSequence();

        await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0"
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[1].headers).toEqual({
                Accept: "application/json",
                Authorization: "Basic test",
            });
        }

        await localDB.destroy();
    });

    it("reports the stage and the status when the changes summary is unauthorised", async () => {
        const localDB = new PouchDB("streaming-fetch-summary-unauthorised", { adapter: "memory" });

        fetchMock
            .mockResolvedValueOnce(new Response("", { status: 401, statusText: "Unauthorized" }))
            .mockResolvedValueOnce(new Response("", { status: 401, statusText: "Unauthorized" }));

        const error = await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            undefined,
            CUSTOM_HEADERS
        ).catch((ex: Error) => ex);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("changes summary");
        expect((error as Error).message).toContain("401");
        expect((error as Error).message).not.toContain(SECRET_HEADER_VALUE);

        await localDB.destroy();
    });

    it("reports the stage and the status when a proxy returns a non-JSON error page", async () => {
        const localDB = new PouchDB("streaming-fetch-summary-forbidden", { adapter: "memory" });

        fetchMock
            .mockResolvedValueOnce(new Response("<html>Access denied</html>", { status: 403, statusText: "Forbidden" }))
            .mockResolvedValueOnce(new Response("<html>Access denied</html>", { status: 403, statusText: "Forbidden" }));

        const error = await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            undefined,
            CUSTOM_HEADERS
        ).catch((ex: Error) => ex);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).not.toBe("SyntaxError");
        expect((error as Error).message).toContain("changes summary");
        expect((error as Error).message).toContain("403");

        await localDB.destroy();
    });

    it("reports the stage and the status when the changes stream is rejected", async () => {
        const localDB = new PouchDB("streaming-fetch-stream-forbidden", { adapter: "memory" });

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ update_seq: 2 })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ pending: 1, last_seq: 1 })))
            .mockResolvedValueOnce(
                new Response("<html>Access denied</html>", { status: 403, statusText: "Forbidden" })
            );

        const error = await fetchChangesForInitialSync(
            localDB,
            "https://example.com/db",
            "Basic test",
            (doc) => Promise.resolve(doc as any),
            "0",
            undefined,
            undefined,
            CUSTOM_HEADERS
        ).catch((ex: Error) => ex);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("changes stream");
        expect((error as Error).message).toContain("403");
        await expect(localDB.allDocs()).resolves.toMatchObject({ total_rows: 0 });

        await localDB.destroy();
    });
});
