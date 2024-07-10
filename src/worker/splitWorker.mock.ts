import { splitPieces2, splitPieces2V2 } from "../string_and_binary/chunks";

export function terminateWorker() {
    return;
}

export function splitPieces2Worker(dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename?: string) {
    return splitPieces2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename);
}
export function splitPieces2WorkerV2(dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename?: string) {
    return splitPieces2V2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename);
}