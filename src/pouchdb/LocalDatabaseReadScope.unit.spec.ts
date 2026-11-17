import { describe, expect, it, vi } from "vitest";
import { LocalDatabaseReadScope } from "./LocalDatabaseReadScope.ts";

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("LocalDatabaseReadScope", () => {
    it("rejects every pending caller wait with the same error when closed", async () => {
        const scope = new LocalDatabaseReadScope();
        const firstRead = createDeferred<string>();
        const secondRead = createDeferred<string>();
        const firstWait = scope.run(() => firstRead.promise);
        const secondWait = scope.run(() => secondRead.promise);
        const firstOutcome = firstWait.then(
            () => {
                throw new Error("Expected the first read wait to be rejected.");
            },
            (error: unknown) => error
        );
        const secondOutcome = secondWait.then(
            () => {
                throw new Error("Expected the second read wait to be rejected.");
            },
            (error: unknown) => error
        );

        scope.close();
        scope.close();

        const closeError = await firstOutcome;
        expect(scope.isClosed).toBe(true);
        expect(closeError).toBeInstanceOf(Error);
        expect((closeError as Error).message).toBe("Local database reads have stopped.");
        expect(await secondOutcome).toBe(closeError);
    });

    it("does not invoke operations submitted after closing", async () => {
        const scope = new LocalDatabaseReadScope();
        const operation = vi.fn(() => Promise.resolve("value"));

        scope.close();

        await expect(scope.run(operation)).rejects.toMatchObject({
            message: "Local database reads have stopped.",
        });
        expect(operation).not.toHaveBeenCalled();
    });

    it("keeps cancellation as the caller result when an underlying read resolves late", async () => {
        const scope = new LocalDatabaseReadScope();
        const read = createDeferred<string>();
        const wait = scope.run(() => read.promise);
        const outcome = wait.then(
            () => {
                throw new Error("Expected the read wait to be rejected.");
            },
            (error: unknown) => error
        );

        scope.close();
        const closeError = await outcome;
        read.resolve("late result");

        expect(await outcome).toBe(closeError);
    });

    it("handles an underlying rejection after close without an unhandled rejection", async () => {
        const scope = new LocalDatabaseReadScope();
        const read = createDeferred<string>();
        const wait = scope.run(() => read.promise);
        const outcome = wait.then(
            () => {
                throw new Error("Expected the read wait to be rejected.");
            },
            (error: unknown) => error
        );
        const unhandledRejections: unknown[] = [];
        const observeUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on("unhandledRejection", observeUnhandledRejection);

        try {
            scope.close();
            const closeError = await outcome;
            read.reject(new Error("late database failure"));
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(await outcome).toBe(closeError);
            expect(unhandledRejections).toEqual([]);
        } finally {
            process.off("unhandledRejection", observeUnhandledRejection);
        }
    });

    it("preserves synchronous and asynchronous operation errors unchanged", async () => {
        const scope = new LocalDatabaseReadScope();
        const synchronousError = new Error("synchronous failure");
        const asynchronousError = new Error("asynchronous failure");

        await expect(
            scope.run(() => {
                throw synchronousError;
            })
        ).rejects.toBe(synchronousError);
        await expect(scope.run(() => Promise.reject(asynchronousError))).rejects.toBe(asynchronousError);
    });

    it("keeps ordinary completion and rejection unchanged while open", async () => {
        const scope = new LocalDatabaseReadScope();
        const value = { result: "read" };
        const operationError = new Error("read failure");

        await expect(scope.run(() => Promise.resolve(value))).resolves.toBe(value);
        await expect(scope.run(() => Promise.reject(operationError))).rejects.toBe(operationError);

        scope.close();
        expect(scope.isClosed).toBe(true);
    });
});
