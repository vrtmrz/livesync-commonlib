import { describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { fetchChangesForInitialSync } from "./StreamingFetch";

PouchDB.plugin(MemoryAdapter);

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/common/coreEnvFunctions", () => ({
    _fetch: fetchMock,
}));

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
});
