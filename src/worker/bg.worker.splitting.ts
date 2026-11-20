import { RpcError, type CancelSignal } from "@vrtmrz/rpc";
import { splitPieces2, splitPieces2V2, splitPiecesRabinKarp } from "@lib/string_and_binary/chunks.ts";
import type { WorkerSplitRequest } from "./backgroundWorkerRpcContract.ts";

const splitters = {
    1: splitPieces2,
    2: splitPieces2V2,
    3: splitPiecesRabinKarp,
};

function readErrorField(error: unknown, field: "name" | "message"): string | undefined {
    try {
        const value = (error as Partial<Record<typeof field, unknown>> | null | undefined)?.[field];
        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
}

function asRemoteSplitError(error: unknown): RpcError {
    const remoteName = readErrorField(error, "name") ?? "Error";
    const message =
        typeof error === "string" ? error : (readErrorField(error, "message") ?? "Background splitting failed");
    return new RpcError("remote-error", message, { remoteName });
}

function bridgeCancellation(signal: CancelSignal, controller: AbortController): () => void {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) {
        abort();
    } else {
        signal.addEventListener("abort", abort, { once: true });
    }
    return () => signal.removeEventListener("abort", abort);
}

export async function* splitBackgroundRequest(
    request: WorkerSplitRequest,
    signal: CancelSignal
): AsyncGenerator<string, void, unknown> {
    if (signal.aborted) {
        return;
    }

    const controller = new AbortController();
    const removeAbortListener = request.splitVersion === 3 ? bridgeCancellation(signal, controller) : () => {};
    try {
        const { dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter, splitVersion } = request;
        const splitter = splitters[splitVersion];
        const split =
            splitVersion === 3
                ? await splitter(
                      dataSrc,
                      pieceSize,
                      plainSplit,
                      minimumChunkSize,
                      filename,
                      useSegmenter,
                      controller.signal
                  )
                : await splitter(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);

        // V1 and V2 may be awaiting Blob preparation here; cancellation takes effect after that read settles.
        if (signal.aborted) {
            return;
        }

        let produced = false;
        for await (const chunk of split()) {
            // V1 and V2 do not accept a signal, so stop after an in-progress read and between chunks.
            if (signal.aborted) {
                return;
            }
            produced = true;
            yield chunk;
        }
        if (!produced && !signal.aborted) {
            yield "";
        }
    } catch (error) {
        throw asRemoteSplitError(error);
    } finally {
        removeAbortListener();
    }
}
