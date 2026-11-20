import { call, defineContract } from "@vrtmrz/rpc";
import type { WorkerStreamPort } from "@vrtmrz/rpc/worker";
import type { SplitArguments } from "./universalTypes.ts";

export type WorkerSplitRequest = Omit<SplitArguments, "type" | "key">;

type EncryptionArguments = [input: string, passphrase: string, autoCalculateIterations: boolean];
type HkdfEncryptionArguments = [input: string, passphrase: string, salt: Uint8Array<ArrayBuffer>];

export const backgroundWorkerContract = defineContract({
    split: call<[request: WorkerSplitRequest], WorkerStreamPort>().transfer({ result: "required" }),
    encrypt: call<EncryptionArguments, string>(),
    decrypt: call<EncryptionArguments, string>(),
    encryptHKDF: call<HkdfEncryptionArguments, string>(),
    decryptHKDF: call<HkdfEncryptionArguments, string>(),
});

export function splitChunkCapacity(dataSrc: Blob): number {
    // Base64 is the largest supported representation, and the stream charges two bytes per code unit.
    // The splitter can exceed its requested piece size for some content and settings.
    return Math.max(2, 8 * Math.ceil(dataSrc.size / 3));
}
