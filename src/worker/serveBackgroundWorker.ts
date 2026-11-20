/// <reference lib="webworker" />

import { decrypt, encrypt } from "octagonal-wheels/encryption";
import { decrypt as decryptHKDF, encrypt as encryptHKDF } from "octagonal-wheels/encryption/hkdf";
import { serveWorkerRpc, serveWorkerStream, type ServeWorkerRpcOptions } from "@vrtmrz/rpc/worker";
import { backgroundWorkerContract, splitChunkCapacity } from "./backgroundWorkerRpcContract.ts";
import { splitBackgroundRequest } from "./bg.worker.splitting.ts";

export function serveBackgroundWorker(port: ServeWorkerRpcOptions<typeof backgroundWorkerContract>["port"]) {
    return serveWorkerRpc({
        contract: backgroundWorkerContract,
        port,
        register(endpoint, lifetime) {
            endpoint.handle("encrypt", (_context, input, passphrase, autoCalculateIterations) =>
                encrypt(input, passphrase, autoCalculateIterations)
            );
            endpoint.handle("decrypt", (_context, input, passphrase, autoCalculateIterations) =>
                decrypt(input, passphrase, autoCalculateIterations)
            );
            endpoint.handle("encryptHKDF", (_context, input, passphrase, salt) => encryptHKDF(input, passphrase, salt));
            endpoint.handle("decryptHKDF", (_context, input, passphrase, salt) => decryptHKDF(input, passphrase, salt));
            endpoint.handle("split", (_context, request) =>
                serveWorkerStream({
                    createChannel: () => new MessageChannel(),
                    maxChunkBytes: splitChunkCapacity(request.dataSrc),
                    signal: lifetime,
                    createSource: (signal) => splitBackgroundRequest(request, signal),
                })
            );
        },
    });
}
