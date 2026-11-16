import { describe, expect, it, vi } from "vitest";
import { isInvalidStateError, observeLocalDatabaseErrors } from "./localDatabaseErrors";

function invalidStateError() {
    return Object.assign(new Error("database context is invalid"), { name: "InvalidStateError" });
}

describe("local database error observation", () => {
    it("matches InvalidStateError by its public name only", () => {
        expect(isInvalidStateError(invalidStateError())).toBe(true);
        expect(isInvalidStateError({ name: "InvalidStateError" })).toBe(true);
        expect(
            isInvalidStateError(
                Object.assign(new Error("local database unavailable"), {
                    name: "LocalDatabaseUnavailableError",
                    cause: invalidStateError(),
                })
            )
        ).toBe(true);
        expect(isInvalidStateError({ name: "UnknownError" })).toBe(false);
        expect(isInvalidStateError({ name: "not_found", status: 404 })).toBe(false);
        expect(isInvalidStateError({ name: "conflict", status: 409 })).toBe(false);
        expect(isInvalidStateError({ name: "unauthorized", status: 401 })).toBe(false);
        expect(isInvalidStateError(null)).toBe(false);
        expect(isInvalidStateError("InvalidStateError")).toBe(false);
    });

    it("observes core public I/O promise failures and preserves their rejection", async () => {
        const error = invalidStateError();
        const onError = vi.fn();
        const database = {
            get: vi.fn(() => Promise.reject(error)),
            info: vi.fn(() => Promise.reject(error)),
            allDocs: vi.fn(() => Promise.reject(error)),
            bulkDocs: vi.fn(() => Promise.reject(error)),
        };
        const observed = observeLocalDatabaseErrors(database, onError);

        const operations = [observed.get(), observed.info(), observed.allDocs(), observed.bulkDocs()];
        const settled = await Promise.allSettled(operations);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(4));

        expect(settled).toEqual([
            { status: "rejected", reason: error },
            { status: "rejected", reason: error },
            { status: "rejected", reason: error },
            { status: "rejected", reason: error },
        ]);
        expect(onError).toHaveBeenNthCalledWith(1, error);
        expect(onError).toHaveBeenNthCalledWith(2, error);
        expect(onError).toHaveBeenNthCalledWith(3, error);
        expect(onError).toHaveBeenNthCalledWith(4, error);
    });

    it("preserves the method receiver, callback receiver, arguments, and return value", () => {
        const error = invalidStateError();
        const database = {
            marker: "database",
            get(this: { marker: string }, _id: string, callback: (...args: unknown[]) => unknown) {
                expect(this.marker).toBe("database");
                Reflect.apply(callback, callbackReceiver, [error, null]);
                return methodResult;
            },
        };
        const callbackReceiver = { marker: "callback" };
        const callbackResult = { callback: "result" };
        const methodResult = { method: "result" };
        const onError = vi.fn();
        const observed = observeLocalDatabaseErrors(database, onError);
        let receivedThis: unknown;
        let receivedArguments: unknown[] = [];
        const callback = function (this: unknown, ...args: unknown[]) {
            receivedThis = this;
            receivedArguments = args;
            return callbackResult;
        };

        const returned = observed.get("note.md", callback);

        expect(returned).toBe(methodResult);
        expect(receivedThis).toBe(callbackReceiver);
        expect(receivedArguments).toEqual([error, null]);
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(error);
    });

    it("passes a query map function unchanged so PouchDB can serialise its source", async () => {
        const map = function (document: { value: number }) { return document.value; };
        const result = Promise.resolve({ rows: [] });
        const query = vi.fn((_map: typeof map) => result);
        const database = observeLocalDatabaseErrors({ query }, vi.fn());
        expect(database.query(map)).toBe(result);
        expect(query).toHaveBeenCalledWith(map);
        await result;
    });

    it("observes changes errors without replacing the thenable or cancellation handle", async () => {
        const error = invalidStateError();
        let rejectChanges!: (error: unknown) => void;
        const completion = new Promise<never>((_resolve, reject) => {
            rejectChanges = reject;
        });
        const listeners = new Map<string, (error: unknown) => void>();
        const changes = {
            on(event: string, handler: (error: unknown) => void) {
                listeners.set(event, handler);
                return this;
            },
            then: completion.then.bind(completion),
            catch: completion.catch.bind(completion),
            cancel: vi.fn(),
        };
        const database = { changes: vi.fn((_options: { since: number }) => changes) };
        const onError = vi.fn();
        const observed = observeLocalDatabaseErrors(database, onError);

        const result = observed.changes({ since: 0 });
        expect(result).toBe(changes);
        expect(result.cancel).toBe(changes.cancel);
        expect(result.then).toBe(changes.then);
        expect(listeners.has("error")).toBe(true);
        listeners.get("error")?.(error);
        rejectChanges(error);

        await expect(Promise.resolve(result)).rejects.toBe(error);
        await vi.waitFor(() => {
            expect(onError).toHaveBeenCalledOnce();
            expect(onError).toHaveBeenCalledWith(error);
        });
    });

    it("does not replace a database rejection when its observer fails", async () => {
        const error = invalidStateError();
        const observerError = new Error("observer failed");
        const onError = vi.fn(() => Promise.reject(observerError));
        const observed = observeLocalDatabaseErrors({ info: () => Promise.reject(error) }, onError);

        await expect(observed.info()).rejects.toBe(error);
        await vi.waitFor(() => {
            expect(onError).toHaveBeenCalledOnce();
            expect(onError).toHaveBeenCalledWith(error);
        });
    });
});
