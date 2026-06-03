import { describe, expect, it } from "vitest";
import { LiveSyncError, LiveSyncFatalError } from "./LSError";

describe("LiveSyncError", () => {
    describe("constructor", () => {
        it("should create an instance with a message", () => {
            const error = new LiveSyncError("test message");
            expect(error.message).toBe("test message");
            expect(error.name).toBe("LiveSyncError");
        });

        it("should capture the cause if provided", () => {
            const cause = new Error("original error");
            const error = new LiveSyncError("wrapped error", { cause });
            expect(error.cause).toBe(cause);
        });

        it("[FIX] should wrap non-Error cause in an Error", () => {
            const cause = { status: 404, message: "not found" };
            const error = new LiveSyncError("wrapped error", { cause });
            expect(error.cause).toBeInstanceOf(Error);
            expect((error.cause as Error).message).toContain("Unknown cause");
            expect((error.cause as Error).message).toContain(JSON.stringify(cause));
        });
    });

    describe("status property", () => {
        it("should return 500 by default", () => {
            const error = new LiveSyncError("default error");
            expect(error.status).toBe(500);
        });

        it("should return overrideStatus if set", () => {
            const error = new LiveSyncError("error", { status: 400 });
            expect(error.status).toBe(400);
        });

        it("should extract status from cause if available", () => {
            const cause = new Error("forbidden");
            (cause as any).status = 403;
            const error = new LiveSyncError("error", { cause });
            expect(error.status).toBe(403);
        });

        it("[FIX] should extract status from nested cause if available", () => {
            const rootCause = { status: 418 };
            const midError = new Error("mid error");
            (midError as any).cause = rootCause;
            const error = new LiveSyncError("error", { cause: midError });
            expect(error.status).toBe(418);
        });

        it("should prioritize overrideStatus over cause status", () => {
            const cause = { status: 403 };
            const error = new LiveSyncError("error", { cause, status: 404 });
            expect(error.status).toBe(404);
        });
    });

    describe("isCausedBy static method", () => {
        it("should return true if error is an instance of the class", () => {
            const error = new LiveSyncFatalError("fatal");
            expect(LiveSyncError.isCausedBy(error, LiveSyncFatalError)).toBe(true);
        });

        it("should return true if error.cause is an instance of the class", () => {
            const cause = new LiveSyncFatalError("fatal cause");
            const error = new LiveSyncError("wrapped", { cause });
            expect(LiveSyncError.isCausedBy(error, LiveSyncFatalError)).toBe(true);
        });

        it("should return true if nested cause matches the class", () => {
            const rootCause = new LiveSyncFatalError("root fatal");
            const midError = new Error("mid");
            (midError as any).cause = rootCause;
            const error = new LiveSyncError("wrapped", { cause: midError });
            expect(LiveSyncError.isCausedBy(error, LiveSyncFatalError)).toBe(true);
        });

        it("should return false if no occurrence of the class is found", () => {
            const error = new LiveSyncError("normal error");
            expect(LiveSyncError.isCausedBy(error, LiveSyncFatalError)).toBe(false);
        });

        it("[FIX] should handle circular references gracefully", () => {
            const error: any = new LiveSyncError("circular");
            error.cause = error;
            expect(LiveSyncError.isCausedBy(error, LiveSyncFatalError)).toBe(false);
        });

        it("should return false for null/undefined", () => {
            expect(LiveSyncError.isCausedBy(null, LiveSyncError)).toBe(false);
            expect(LiveSyncError.isCausedBy(undefined, LiveSyncError)).toBe(false);
        });
    });

    describe("fromError static method", () => {
        it("should return the same instance if it matches the class", () => {
            const error = new LiveSyncError("original");
            const wrapped = LiveSyncError.fromError(error);
            expect(wrapped).toBe(error);
        });

        it("should wrap a standard Error", () => {
            const original = new Error("standard");
            const wrapped = LiveSyncError.fromError(original);
            expect(wrapped).toBeInstanceOf(LiveSyncError);
            expect(wrapped.message).toContain("standard");
            expect(wrapped.cause).toBe(original);
            expect(wrapped.stack).toBe(original.stack);
        });

        it("[FIX] should wrap a string error", () => {
            const wrapped = LiveSyncError.fromError("failure");
            expect(wrapped).toBeInstanceOf(LiveSyncError);
            expect(wrapped.message).toContain("failure");
            expect(wrapped.cause).toBeInstanceOf(Error);
            expect((wrapped.cause as Error).message).toContain("failure");
        });

        it("should inherit the correct class name when called on a subclass", () => {
            const original = new Error("oops");
            const wrapped = LiveSyncFatalError.fromError(original);
            expect(wrapped).toBeInstanceOf(LiveSyncFatalError);
            expect(wrapped.name).toBe("LiveSyncFatalError");
        });

        it("[FIX] should extract status from non-Error object in fromError", () => {
            const errorObj = { status: 401, message: "unauthorized" };
            const wrapped = LiveSyncError.fromError(errorObj);
            expect(wrapped.status).toBe(401);
            expect(wrapped.cause).toBeInstanceOf(Error);
        });
    });
});
