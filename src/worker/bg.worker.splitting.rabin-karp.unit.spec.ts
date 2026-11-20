import { RpcError } from "@vrtmrz/rpc";
import { connectWorkerRpc, readWorkerStream, type WorkerRpcClient, type WorkerRpcWorker } from "@vrtmrz/rpc/worker";
import { describe, expect, it, vi } from "vitest";
import { splitPiecesRabinKarp } from "../string_and_binary/chunks.ts";
import {
    backgroundWorkerContract,
    splitChunkCapacity,
    type WorkerSplitRequest,
} from "./backgroundWorkerRpcContract.ts";
import { serveBackgroundWorker } from "./serveBackgroundWorker.ts";

async function withWorkerClient<T>(
    run: (client: WorkerRpcClient<typeof backgroundWorkerContract>) => Promise<T>
): Promise<T> {
    const channel = new MessageChannel();
    const server = serveBackgroundWorker(channel.port2);
    const worker = Object.assign(channel.port1, {
        terminate: () => channel.port1.close(),
    }) as unknown as WorkerRpcWorker;
    const connection = connectWorkerRpc({ contract: backgroundWorkerContract, createWorker: () => worker });
    try {
        return await run(await connection.ready);
    } finally {
        server.close();
        connection.close();
        channel.port1.close();
        channel.port2.close();
    }
}

async function collectSplit(
    client: WorkerRpcClient<typeof backgroundWorkerContract>,
    request: WorkerSplitRequest
): Promise<string[]> {
    const port = await client.call.split([request]);
    const chunks: string[] = [];
    for await (const chunk of readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(request.dataSrc) })) {
        expect(typeof chunk).toBe("string");
        chunks.push(chunk as string);
    }
    return chunks;
}

function createRequest(dataSrc: Blob, pieceSize: number, plainSplit: boolean): WorkerSplitRequest {
    return {
        dataSrc,
        pieceSize,
        plainSplit,
        minimumChunkSize: 20,
        useSegmenter: false,
        splitVersion: 3,
    };
}

describe("Rabin–Karp background Worker stream", () => {
    it.each([
        [
            "ordinary Markdown",
            new Blob(["# Heading\n\nA note with unchanged paragraphs.\n".repeat(100)], { type: "text/plain" }),
            true,
        ],
        ["small-cap binary", new Blob([new Uint8Array(512 * 1024).map((_, i) => (i * 31) % 251)]), false],
        ["large UTF-8 text", new Blob(["漢🙂".repeat(600_000)], { type: "text/plain" }), true],
    ] as const)("preserves ordered chunk boundaries for %s", async (_label, dataSrc, plainSplit) => {
        const pieceSize = 100 * 1024;
        const direct = await splitPiecesRabinKarp(dataSrc, pieceSize, plainSplit, 20);
        const expected: string[] = [];
        for await (const chunk of direct()) {
            expected.push(chunk);
        }

        await withWorkerClient(async (client) => {
            const actual = await collectSplit(client, createRequest(dataSrc, pieceSize, plainSplit));
            expect(actual).toEqual(expected);
        });
    });

    it("stops after the in-flight Blob read when the stream is cancelled", async () => {
        const dataSrc = new Blob([new Uint8Array(3 * 1024 * 1024).fill(7)]);
        const request = createRequest(dataSrc, 64 * 1024, false);
        const originalArrayBuffer = Blob.prototype.arrayBuffer;
        let readCount = 0;
        let notifySecondRead: (() => void) | undefined;
        let releaseSecondRead: (() => void) | undefined;
        const secondReadStarted = new Promise<void>((resolve) => {
            notifySecondRead = resolve;
        });
        const arrayBuffer = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
            readCount++;
            if (readCount === 2) {
                notifySecondRead?.();
                return new Promise<ArrayBuffer>((resolve, reject) => {
                    releaseSecondRead = () => {
                        void originalArrayBuffer.call(this).then(resolve, reject);
                    };
                });
            }
            return originalArrayBuffer.call(this);
        });

        try {
            await withWorkerClient(async (client) => {
                const port = await client.call.split([request]);
                const stream = readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(dataSrc) });
                let pending = stream.next();
                let observedChunks = 0;

                while (true) {
                    const result = await Promise.race([
                        pending.then((value) => ({ kind: "pull" as const, value })),
                        secondReadStarted.then(() => ({ kind: "read" as const })),
                    ]);
                    if (result.kind === "read") {
                        break;
                    }
                    if (result.value.done) {
                        throw new Error("The stream completed before the second Blob read.");
                    }
                    observedChunks++;
                    pending = stream.next();
                }

                const pendingResult = pending.catch((error: unknown) => error);
                await stream.return();
                await expect(pendingResult).resolves.toEqual({ done: true, value: undefined });
                expect(observedChunks).toBeGreaterThan(0);
                expect(readCount).toBe(2);

                releaseSecondRead?.();
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                expect(readCount).toBe(2);
            });
        } finally {
            arrayBuffer.mockRestore();
            releaseSecondRead?.();
        }
    });

    it("reports a mid-read failure with safe remote details", async () => {
        const dataSrc = new Blob([new Uint8Array(3 * 1024 * 1024).fill(11)]);
        const request = createRequest(dataSrc, 64 * 1024, false);
        const originalArrayBuffer = Blob.prototype.arrayBuffer;
        const readError = new Error("second block could not be read");
        readError.name = "NotReadableError";
        readError.stack = "private remote stack";
        let readCount = 0;
        const arrayBuffer = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
            readCount++;
            return readCount === 2 ? Promise.reject(readError) : originalArrayBuffer.call(this);
        });

        try {
            await withWorkerClient(async (client) => {
                const port = await client.call.split([request]);
                const stream = readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(dataSrc) });
                let result: unknown;
                while (true) {
                    try {
                        const next = await stream.next();
                        if (next.done) {
                            break;
                        }
                    } catch (error) {
                        result = error;
                        break;
                    }
                }

                expect(readCount).toBe(2);
                expect(result).toBeInstanceOf(RpcError);
                expect(result).toMatchObject({
                    code: "remote-error",
                    remoteName: "NotReadableError",
                    message: "second block could not be read",
                });
                expect((result as Error).stack).not.toContain("private remote stack");
            });
        } finally {
            arrayBuffer.mockRestore();
        }
    });
});
