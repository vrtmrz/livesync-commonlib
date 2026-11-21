// A mock for bgWorker (For environments where Worker cannot be used).
import { decrypt, encrypt } from "octagonal-wheels/encryption/index.js";
import { encrypt as encryptHKDF, decrypt as decryptHKDF } from "octagonal-wheels/encryption/hkdf";

import { splitPieces2, splitPieces2V2, splitPiecesRabinKarp } from "@lib/string_and_binary/chunks.ts";
import type {
    EncryptArguments,
    EncryptHKDFArguments,
    EncryptHKDFProcessItem,
    EncryptProcessItem,
    ProcessItem,
    SplitArguments,
    SplitProcessItem,
} from "./universalTypes.ts";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { LiveSyncEventHub } from "@lib/hub/hub.ts";
import { groupSplitChunks } from "./splitWindows.ts";

export function terminateWorker() {
    return;
}

export function splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return async function* () {
        const split = await splitPieces2(
            dataSrc,
            pieceSize,
            plainSplit,
            minimumChunkSize,
            filename,
            useSegmenter ?? false
        );
        yield* split();
    };
}
export function splitPieces2WorkerV2(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return async function* () {
        const split = await splitPieces2V2(
            dataSrc,
            pieceSize,
            plainSplit,
            minimumChunkSize,
            filename,
            useSegmenter ?? false
        );
        yield* split();
    };
}
export function splitPieces2WorkerRabinKarp(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return async function* () {
        const splitter = await splitPiecesRabinKarp(
            dataSrc,
            pieceSize,
            plainSplit,
            minimumChunkSize,
            filename,
            useSegmenter ?? false
        );
        yield* splitter();
    };
}

/** @experimental */
export function splitPieces2WorkerRabinKarpWindowed(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    windowBytes: number,
    filename?: string,
    useSegmenter = false
): () => AsyncGenerator<readonly string[], void, unknown> {
    const create = splitPieces2WorkerRabinKarp(
        dataSrc,
        pieceSize,
        plainSplit,
        minimumChunkSize,
        filename,
        useSegmenter
    );
    return () => groupSplitChunks(create(), windowBytes);
}

export function encryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    return encrypt(input, passphrase, autoCalculateIterations);
}

export function decryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean) {
    return decrypt(input, passphrase, autoCalculateIterations);
}

export function encryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return encryptHKDF(input, passphrase, pbkdf2Salt);
}

export function decryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return decryptHKDF(input, passphrase, pbkdf2Salt);
}

export function startWorker(data: Omit<EncryptHKDFArguments, "key">): EncryptHKDFProcessItem;
export function startWorker(data: Omit<EncryptArguments, "key">): EncryptProcessItem;
export function startWorker(data: Omit<SplitArguments, "key">): SplitProcessItem;
export function startWorker(data: Omit<EncryptArguments | SplitArguments | EncryptHKDFArguments, "key">): ProcessItem {
    const task = promiseWithResolvers<string>();
    task.resolve("");
    return {
        task: task,
        key: 0,
        type: data.type,
        finalize: () => {
            // No op
        },
    };
}

export const tasks = new Map<number, ProcessItem>();

export function removeTask(key: number): void {
    tasks.delete(key);
}

export function cancelSplitTask(key: number): void {
    if (tasks.get(key)?.type === "split") {
        removeTask(key);
    }
}

export function initialiseWorkerModule(_events: LiveSyncEventHub) {}
