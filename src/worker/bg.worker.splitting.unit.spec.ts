import { RpcError } from "@vrtmrz/rpc";
import { connectWorkerRpc, readWorkerStream, type WorkerRpcClient, type WorkerRpcWorker } from "@vrtmrz/rpc/worker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    backgroundWorkerContract,
    splitChunkCapacity,
    type WorkerSplitRequest,
} from "./backgroundWorkerRpcContract.ts";
import { splitBackgroundRequest } from "./bg.worker.splitting.ts";
import { serveBackgroundWorker } from "./serveBackgroundWorker.ts";

const mockedSplitters = vi.hoisted(() => ({
    splitPieces2: vi.fn(),
    splitPieces2V2: vi.fn(),
    splitPiecesRabinKarp: vi.fn(),
}));

vi.mock("@lib/string_and_binary/chunks.ts", () => mockedSplitters);

const splitters = [mockedSplitters.splitPieces2, mockedSplitters.splitPieces2V2, mockedSplitters.splitPiecesRabinKarp];

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

describe("background Worker split RPC", () => {
    beforeEach(() => {
        for (const splitter of splitters) {
            splitter.mockReset();
        }
    });

    it.each([
        [1, mockedSplitters.splitPieces2],
        [2, mockedSplitters.splitPieces2V2],
        [3, mockedSplitters.splitPiecesRabinKarp],
    ] as const)("streams ordered chunks for split version %i", async (splitVersion, splitter) => {
        splitter.mockImplementation(
            async () =>
                async function* chunks() {
                    await Promise.resolve();
                    yield "chunk-1";
                    yield "chunk-2";
                }
        );

        const dataSrc = new Blob(["abcdef"]);
        const request: WorkerSplitRequest = {
            dataSrc,
            pieceSize: 2,
            plainSplit: true,
            minimumChunkSize: 1,
            filename: "note.pdf",
            useSegmenter: true,
            splitVersion,
        };

        await withWorkerClient(async (client) => {
            await expect(collectSplit(client, request)).resolves.toEqual(["chunk-1", "chunk-2"]);
        });

        expect(splitter).toHaveBeenCalledTimes(1);
        const [receivedBlob, ...arguments_] = splitter.mock.calls[0] as unknown[];
        expect(receivedBlob).toBeInstanceOf(Blob);
        expect((receivedBlob as Blob).size).toBe(dataSrc.size);
        expect(arguments_).toEqual([
            request.pieceSize,
            request.plainSplit,
            request.minimumChunkSize,
            request.filename,
            request.useSegmenter,
            ...(splitVersion === 3 ? [expect.any(AbortSignal)] : []),
        ]);
    });

    it("preserves an empty split as one empty chunk and finishes cleanly", async () => {
        mockedSplitters.splitPieces2.mockImplementation(async () => async function* noChunks() {});
        const request: WorkerSplitRequest = {
            dataSrc: new Blob(),
            pieceSize: 2,
            plainSplit: false,
            minimumChunkSize: 1,
            useSegmenter: false,
            splitVersion: 1,
        };

        await withWorkerClient(async (client) => {
            const port = await client.call.split([request]);
            const stream = readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(request.dataSrc) });
            await expect(stream.next()).resolves.toEqual({ done: false, value: "" });
            await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
            await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
        });
    });

    it.each([
        [1, mockedSplitters.splitPieces2],
        [2, mockedSplitters.splitPieces2V2],
    ] as const)("stops split version %i after an in-progress preparation", async (splitVersion, splitter) => {
        let finishPreparation!: (source: () => AsyncGenerator<string>) => void;
        let generatorStarted = false;
        splitter.mockReturnValue(
            new Promise<() => AsyncGenerator<string>>((resolve) => {
                finishPreparation = resolve;
            })
        );
        const request: WorkerSplitRequest = {
            dataSrc: new Blob(["contents"]),
            pieceSize: 2,
            plainSplit: false,
            minimumChunkSize: 1,
            useSegmenter: false,
            splitVersion,
        };
        const controller = new AbortController();
        const source = splitBackgroundRequest(request, controller.signal);
        const pending = source.next();
        await vi.waitFor(() => expect(splitter).toHaveBeenCalledTimes(1));

        controller.abort();
        finishPreparation(async function* chunks() {
            generatorStarted = true;
            yield "after cancellation";
        });

        await expect(pending).resolves.toEqual({ done: true, value: undefined });
        expect(generatorStarted).toBe(false);
    });

    it.each([
        [1, mockedSplitters.splitPieces2],
        [2, mockedSplitters.splitPieces2V2],
    ] as const)("stops split version %i after an in-progress read", async (splitVersion, splitter) => {
        let notifyReadStarted!: () => void;
        let finishRead!: () => void;
        const readStarted = new Promise<void>((resolve) => {
            notifyReadStarted = resolve;
        });
        const readGate = new Promise<void>((resolve) => {
            finishRead = resolve;
        });
        splitter.mockImplementation(
            async () =>
                async function* chunks() {
                    yield "first";
                    notifyReadStarted();
                    await readGate;
                    yield "after cancellation";
                }
        );
        const request: WorkerSplitRequest = {
            dataSrc: new Blob(["contents"]),
            pieceSize: 2,
            plainSplit: false,
            minimumChunkSize: 1,
            useSegmenter: false,
            splitVersion,
        };
        const controller = new AbortController();
        const source = splitBackgroundRequest(request, controller.signal);

        await expect(source.next()).resolves.toEqual({ done: false, value: "first" });
        const pending = source.next();
        await readStarted;
        controller.abort();
        finishRead();

        await expect(pending).resolves.toEqual({ done: true, value: undefined });
        await expect(source.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it("bridges stream cancellation to the Rabin–Karp AbortSignal", async () => {
        let nativeSignal: AbortSignal | undefined;
        let innerGeneratorReturned = false;
        mockedSplitters.splitPiecesRabinKarp.mockImplementation(async (...arguments_: unknown[]) => {
            nativeSignal = arguments_[6] as AbortSignal;
            return async function* chunks() {
                try {
                    yield "first";
                    yield "after cancellation";
                } finally {
                    innerGeneratorReturned = true;
                }
            };
        });
        const request: WorkerSplitRequest = {
            dataSrc: new Blob(["contents"]),
            pieceSize: 2,
            plainSplit: false,
            minimumChunkSize: 1,
            useSegmenter: false,
            splitVersion: 3,
        };

        await withWorkerClient(async (client) => {
            const port = await client.call.split([request]);
            const stream = readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(request.dataSrc) });
            await expect(stream.next()).resolves.toEqual({ done: false, value: "first" });
            if (!nativeSignal) {
                throw new Error("Rabin–Karp did not receive a native AbortSignal.");
            }
            const capturedSignal = nativeSignal;
            const abortObserved = new Promise<void>((resolve) => {
                capturedSignal.addEventListener("abort", () => resolve(), { once: true });
            });

            await stream.return();
            await abortObserved;
            expect(capturedSignal.aborted).toBe(true);
            await vi.waitFor(() => expect(innerGeneratorReturned).toBe(true));
        });
    });

    it("preserves safe split error details without forwarding the remote stack", async () => {
        const error = new TypeError("split read failed");
        error.stack = "private remote stack";
        mockedSplitters.splitPieces2.mockImplementation(async () => {
            throw error;
        });
        const request: WorkerSplitRequest = {
            dataSrc: new Blob(["contents"]),
            pieceSize: 2,
            plainSplit: false,
            minimumChunkSize: 1,
            useSegmenter: false,
            splitVersion: 1,
        };

        await withWorkerClient(async (client) => {
            const port = await client.call.split([request]);
            const stream = readWorkerStream({ port, maxChunkBytes: splitChunkCapacity(request.dataSrc) });
            const result = await stream.next().catch((caught: unknown) => caught);
            expect(result).toBeInstanceOf(RpcError);
            expect(result).toMatchObject({
                code: "remote-error",
                remoteName: "TypeError",
                message: "split read failed",
            });
            expect((result as Error).stack).not.toContain("private remote stack");
        });
    });
});
