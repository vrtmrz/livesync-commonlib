// Notice!! This module is for browsers
import { Notifier } from "../concurrency/processor.ts";
//@ts-ignore
import WorkerX from "./split.worker.ts";

export type SplitArguments = {
    key: number;
    dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename?: string,
    useV2: boolean
}

let key = 0;
const buffers = new Map<number, (string | undefined)[]>();
const notify = new Notifier();
const worker = WorkerX() as Worker;

let isTerminated = false;
worker.onmessage = ({ data }) => {
    const [key, string] = data
    if (!buffers.has(key)) {
        buffers.set(key, [])
    }
    buffers.set(key, buffers.get(key)!.concat(string))
    notify.notify();
}
worker.onerror = () => {
    worker.terminate();
    isTerminated = true;
}

export function terminateWorker() {
    worker.terminate();
    isTerminated = true;
}

export function splitPieces2Worker(dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename?: string) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, false);
}
export function splitPieces2WorkerV2(dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename?: string) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, true);
}


function _splitPieces2Worker(dataSrc: Blob, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, filename: string | undefined, useV2: boolean) {

    key++;
    worker.postMessage({
        data:
            { key: key, dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useV2 }
    })
    buffers.set(key, []);
    return async function* pieces(): AsyncGenerator<string> {
        const _key = key;
        do {
            const buf = buffers.get(_key)!;

            if (buf.length > 0) {
                const item = buf.shift();
                buffers.set(_key, buf);
                if (!item) {
                    buffers.delete(_key);
                    return;
                }
                yield item;
            } else {
                await notify.nextNotify;
            }
        } while (!isTerminated);
    }
}
