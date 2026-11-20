import { RpcError } from "@vrtmrz/rpc";

export function toBackgroundWorkerError(error: unknown): unknown {
    if (error instanceof RpcError && error.code === "remote-error" && error.remoteName !== undefined) {
        const remoteError = new Error(error.message, { cause: error });
        remoteError.name = error.remoteName;
        return remoteError;
    }
    return error;
}
