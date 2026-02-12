import { encryptHKDFWorker, decryptHKDFWorker } from "@lib/worker/bgWorker.ts";

export const encryptHKDF = encryptHKDFWorker;
export const decryptHKDF = decryptHKDFWorker;
