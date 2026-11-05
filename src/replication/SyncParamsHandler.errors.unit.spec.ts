import { describe, expect, it } from "vitest";
import {
    SyncParamsFetchError,
    SyncParamsHandlerError,
    SyncParamsNotFoundError,
    SyncParamsUpdateError,
    isSyncParamsError,
} from "./SyncParamsHandler.ts";

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
