/// <reference lib="webworker" />

import { splitPieces2V2, splitPieces2 } from "../string_and_binary/chunks";
import type { SplitArguments } from "./splitWorker"

self.onmessage = async (e: MessageEvent) => {
    const data = e.data.data as SplitArguments;
    const key = data.key;
    const dataSrc = data.dataSrc;
    const pieceSize = data.pieceSize;
    const plainSplit = data.plainSplit;
    const minimumChunkSize = data.minimumChunkSize;
    const filename = data.filename;
    const func = data.useV2 ? splitPieces2V2 : splitPieces2;
    const gen = await func(dataSrc, pieceSize,
        plainSplit, minimumChunkSize, filename
    )
    for await (const v of gen()) {
        self.postMessage([key, v])
    }
    self.postMessage([key, undefined]);
}