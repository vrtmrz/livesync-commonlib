/// <reference lib="webworker" />

import { splitPieces2V2, splitPieces2, splitPiecesRabinKarp } from "../string_and_binary/chunks.ts";
import type { EncryptArguments, EncryptHKDFArguments, SplitArguments } from "./bgWorker.ts";
import { encrypt } from "octagonal-wheels/encryption";
import { decrypt } from "octagonal-wheels/encryption";
import { encrypt as encryptHKDF, decrypt as decryptHKDF } from "octagonal-wheels/encryption/hkdf";

async function processSplit(data: SplitArguments) {
    const key = data.key;
    const dataSrc = data.dataSrc;
    const pieceSize = data.pieceSize;
    const plainSplit = data.plainSplit;
    const minimumChunkSize = data.minimumChunkSize;
    const filename = data.filename;
    const useSegmenter = data.useSegmenter;

    const func = data.splitVersion == 3 ? splitPiecesRabinKarp : data.splitVersion == 2 ? splitPieces2V2 : splitPieces2;
    const gen = await func(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);
    let isSent = false;
    for await (const v of gen()) {
        isSent = true;
        self.postMessage({ key, result: v });
    }
    if (!isSent) self.postMessage({ key, result: "" });
    self.postMessage({ key, result: null });
}
async function processEncryption(data: EncryptArguments | EncryptHKDFArguments) {
    const key = data.key;
    const { type, input, passphrase } = data;
    try {
        if (type == "encrypt") {
            const autoCalculateIterations = data.autoCalculateIterations;
            const result = await encrypt(input, passphrase, autoCalculateIterations);
            self.postMessage({ key, result });
        } else if (type == "decrypt") {
            const autoCalculateIterations = data.autoCalculateIterations;
            const result = await decrypt(input, passphrase, autoCalculateIterations);
            self.postMessage({ key, result });
        } else if (type == "encryptHKDF") {
            const pbkdf2Salt = data.pbkdf2Salt;
            const result = await encryptHKDF(input, passphrase, pbkdf2Salt);
            self.postMessage({ key, result });
        } else if (type == "decryptHKDF") {
            const pbkdf2Salt = data.pbkdf2Salt;
            const result = await decryptHKDF(input, passphrase, pbkdf2Salt);
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
    } else if (data.type === "encryptHKDF" || data.type === "decryptHKDF") {
        return processEncryption(data);
    } else {
        self.postMessage({ key: data.key, error: new Error("Invalid type") });
    }
};
