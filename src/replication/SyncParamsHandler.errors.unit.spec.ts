import { describe, expect, it, vi } from "vitest";
import { captureRemoteTransportFailure, getReplicationNetworkFailure } from "./remoteTransportFailure.ts";
import { DEFAULT_SYNC_PARAMETERS } from "@lib/common/models/sync.definition.ts";
import {
    createSyncParamsHandler,
    SyncParamsFetchError,
    SyncParamsHandlerError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
    isSyncParamsError,
} from "./SyncParamsHandler.ts";

describe("Security Seed failure", () => {
    it("retains the terminal transport cause for callers awaiting the same Security Seed read", async () => {
        const failure = captureRemoteTransportFailure(
            Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
            new AbortController().signal,
            () => true
        );
        const get = vi.fn().mockRejectedValue(failure);
        const handler = createSyncParamsHandler({ get, create: vi.fn(), put: vi.fn() });
        const results = await Promise.allSettled([
            handler.fetch(),
            handler.fetch(),
            handler.getPBKDF2Salt(),
            handler.getPBKDF2Salt(),
        ]);

        expect(results[0]).toEqual({ status: "fulfilled", value: false });
        expect(results[1]).toEqual({ status: "fulfilled", value: false });
        for (const result of results.slice(2)) {
            expect(result.status).toBe("rejected");
            if (result.status !== "rejected") continue;
            expect(result.reason).toBeInstanceOf(SyncParamsFetchError);
            expect(getReplicationNetworkFailure(result.reason)).toMatchObject({
                reason: "remote-transport",
                hostOnlineAtFailure: true,
            });
        }
        expect(get).toHaveBeenCalledOnce();
        await expect(handler.fetch()).resolves.toBe(false);
        expect(get).toHaveBeenCalledTimes(2);
    });

    it("keeps a newer refresh cached when an older refresh fails", async () => {
        let rejectOlderRefresh!: (reason: unknown) => void;
        const olderRequest = new Promise<never>((_resolve, reject) => {
            rejectOlderRefresh = reject;
        });
        const params = {
            ...DEFAULT_SYNC_PARAMETERS,
            pbkdf2salt: btoa("0123456789abcdef0123456789abcdef"),
        };
        const get = vi.fn().mockReturnValueOnce(olderRequest).mockResolvedValue(params);
        const handler = createSyncParamsHandler({ get, create: vi.fn(), put: vi.fn() });

        const olderRefresh = handler.fetch(true);
        const newerRefresh = handler.fetch(true);
        await expect(newerRefresh).resolves.toMatchObject(params);

        rejectOlderRefresh(new Error("stale refresh failed"));
        await expect(olderRefresh).resolves.toBe(false);
        await expect(handler.fetch()).resolves.toMatchObject(params);

        expect(get).toHaveBeenCalledTimes(2);
    });
});

describe("isSyncParamsError", () => {
    it.each([SyncParamsFetchError, SyncParamsNotFoundError, SyncParamsUpdateError])(
        "recognises %s and its subclasses",
        (ErrorType) => {
            class DerivedError extends ErrorType {}
            expect(isSyncParamsError(new ErrorType("failed"))).toBe(true);
            expect(isSyncParamsError(new DerivedError("failed"))).toBe(true);
        }
    );

    it.each([
        undefined,
        null,
        "SyncParamsFetchError",
        { name: "SyncParamsFetchError" },
        new Error("failed"),
        new SyncParamsHandlerError("base error"),
        new Error("wrapped", { cause: new SyncParamsFetchError("failed") }),
    ])("preserves the existing error classification for %s", (error) => {
        expect(isSyncParamsError(error)).toBe(false);
    });
});
