/// <reference lib="webworker" />

import { splitPieces2V2, splitPieces2 } from "../string_and_binary/chunks.ts";
import { encrypt } from "octagonal-wheels/encryption/index.js";
import { decrypt } from "octagonal-wheels/encryption/index.js";

import type { EncryptArguments, SplitArguments } from "./bgWorker.ts";

async function processSplit(data: SplitArguments) {
    const key = data.key;
    const dataSrc = data.dataSrc;
    const pieceSize = data.pieceSize;
    const plainSplit = data.plainSplit;
    const minimumChunkSize = data.minimumChunkSize;
    const filename = data.filename;
    const useSegmenter = data.useSegmenter;
    const func = data.useV2 ? splitPieces2V2 : splitPieces2;
    const gen = await func(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);
    let isSent = false;
    for await (const v of gen()) {
        isSent = true;
        self.postMessage({ key, result: v });
    }
    if (!isSent) self.postMessage({ key, result: "" });
    self.postMessage({ key, result: null });
}
async function processEncryption(data: EncryptArguments) {
    const key = data.key;
    const { type, input, passphrase, autoCalculateIterations } = data;
    try {
        if (type == "encrypt") {
            const result = await encrypt(input, passphrase, autoCalculateIterations);
            self.postMessage({ key, result });
        } else if (type == "decrypt") {
            const result = await decrypt(input, passphrase, autoCalculateIterations);
            self.postMessage({ key, result });
        }
    } catch (ex) {
        self.postMessage({ key, error: ex });
    }
}
self.onmessage = (e: MessageEvent) => {
    const data = e.data.data as SplitArguments | EncryptArguments;
    // debugger;
    if (data.type === "split") {
        return processSplit(data);
    } else if (data.type === "encrypt" || data.type === "decrypt") {
        return processEncryption(data);
    } else {
        self.postMessage({ key: data.key, error: new Error("Invalid type") });
    }
};
