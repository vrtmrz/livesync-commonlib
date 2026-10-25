import { describe, expect, expectTypeOf, it } from "vitest";
import { FirstHandledHandler, firstHandledFunction, HandlerOutcome, handlers } from "./HandlerUtils";

describe("HandlerOutcome", () => {
    it("omits values for void payload types and requires them for typed payloads", () => {
        expectTypeOf<HandlerOutcome>().toEqualTypeOf<
            { kind: "not-applicable" } | { kind: "completed" } | { kind: "veto" }
        >();
        expectTypeOf<HandlerOutcome<number, string>>().toEqualTypeOf<
            { kind: "not-applicable" } | { kind: "completed"; value: number } | { kind: "veto"; value: string }
        >();
    });
});

describe("FirstHandledHandler", () => {
    it("returns not-applicable with no registered handlers or when all handlers skip", async () => {
        const empty = new FirstHandledHandler<[], HandlerOutcome<number, string>>("empty");
        await expect(empty.invoke()).resolves.toEqual({ kind: "not-applicable" });

        const allSkip = new FirstHandledHandler<[], HandlerOutcome<number, string>>("allSkip");
        allSkip.addHandler(async () => ({ kind: "not-applicable" }));
        allSkip.addHandler(() => ({ kind: "not-applicable" }));
        await expect(allSkip.invoke()).resolves.toEqual({ kind: "not-applicable" });
    });

    it("includes not-applicable for a completed-only provider with an empty chain", async () => {
        type CompletedOnly = { kind: "completed"; value: number };
        const empty = new FirstHandledHandler<[], CompletedOnly>("completedOnly");
        expectTypeOf(empty.invoke()).toEqualTypeOf<Promise<CompletedOnly | { kind: "not-applicable" }>>();
        await expect(empty.invoke()).resolves.toEqual({ kind: "not-applicable" });
    });

    it("awaits each asynchronous handler before invoking the next", async () => {
        let releaseWait!: () => void;
        const wait = new Promise<void>((resolve) => {
            releaseWait = resolve;
        });
        const handler = new FirstHandledHandler<[], HandlerOutcome<number, string>>("async");
        const order: string[] = [];
        handler.addHandler(async () => {
            order.push("started");
            await wait;
            order.push("finished");
            return { kind: "not-applicable" };
        });
        handler.addHandler(() => {
            order.push("handled");
            return { kind: "completed", value: 5 };
        });

        const invocation = handler.invoke();
        await Promise.resolve();
        expect(order).toEqual(["started"]);
        releaseWait();
        await expect(invocation).resolves.toEqual({ kind: "completed", value: 5 });
        expect(order).toEqual(["started", "finished", "handled"]);
    });

    it("uses priority and registration order and stops after a handled outcome", async () => {
        const handler = new FirstHandledHandler<[], HandlerOutcome<number, string>>("ordered");
        const order: string[] = [];
        handler.addHandler(() => {
            order.push("priority 10");
            return { kind: "not-applicable" };
        }, 10);
        handler.addHandler(() => {
            order.push("priority 0 first");
            return { kind: "not-applicable" };
        }, 0);
        handler.addHandler(() => {
            order.push("priority 0 second");
            return { kind: "not-applicable" };
        }, 0);
        handler.addHandler(() => {
            order.push("priority 10 second");
            return { kind: "completed", value: 9 };
        }, 10);
        handler.addHandler(() => {
            order.push("never");
            return { kind: "completed", value: 10 };
        }, 11);

        await expect(handler.invoke()).resolves.toEqual({ kind: "completed", value: 9 });
        expect(order).toEqual(["priority 0 first", "priority 0 second", "priority 10", "priority 10 second"]);
    });

    it("returns completed and veto payloads unchanged, including falsy values, and stops", async () => {
        const outcomes = [
            { kind: "completed", value: 0 },
            { kind: "veto", value: false },
            { kind: "completed", value: "" },
        ] satisfies HandlerOutcome<number | string, boolean | string>[];

        for (const outcome of outcomes) {
            const handler = new FirstHandledHandler<[], HandlerOutcome<number | string, boolean | string>>("falsy");
            let laterCalled = false;
            handler.addHandler(() => outcome);
            handler.addHandler(() => {
                laterCalled = true;
                return { kind: "completed", value: 1 };
            });

            await expect(handler.invoke()).resolves.toBe(outcome);
            expect(laterCalled).toBe(false);
        }
    });

    it.each(["throw", "reject"] as const)("propagates a %s unchanged and stops", async (failureMode) => {
        const failure = { message: "handler failure" };
        const handler = new FirstHandledHandler<[], HandlerOutcome<number, string>>(failureMode);
        let laterCalled = false;
        if (failureMode === "throw") {
            handler.addHandler(() => {
                throw failure;
            });
        } else {
            handler.addHandler(() => Promise.reject(failure));
        }
        handler.addHandler(() => {
            laterCalled = true;
            return { kind: "completed", value: 1 };
        });

        await expect(handler.invoke()).rejects.toBe(failure);
        expect(laterCalled).toBe(false);
    });

    it("keeps an invocation snapshot while reporting current registrations", async () => {
        const handler = new FirstHandledHandler<[], HandlerOutcome<number, string>>("snapshot");
        let laterCalled = false;
        let unregisterLater = () => {};
        const unregisterFirst = handler.addHandler(() => {
            unregisterLater();
            return { kind: "not-applicable" };
        });
        unregisterLater = handler.addHandler(() => {
            laterCalled = true;
            return { kind: "completed", value: 0 };
        });

        expect(handler.hasHandlers).toBe(true);
        await expect(handler.invoke()).resolves.toEqual({ kind: "completed", value: 0 });
        expect(laterCalled).toBe(true);
        expect(handler.hasHandlers).toBe(true);
        unregisterFirst();
        expect(handler.hasHandlers).toBe(false);
    });
});

describe("firstHandledFunction", () => {
    it("preserves callback typing and exposes a live hasHandlers property", async () => {
        type Callback = (input: number) => Promise<HandlerOutcome<boolean, string>>;
        const handler = firstHandledFunction<Callback>();
        expectTypeOf(handler).parameter(0).toBeNumber();
        expectTypeOf(handler.hasHandlers).toEqualTypeOf<boolean>();
        expect(handler.hasHandlers).toBe(false);

        const unregister = handler.addHandler(async (input) => ({ kind: "completed", value: input > 0 }));
        expect(handler.hasHandlers).toBe(true);
        await expect(handler(1)).resolves.toEqual({ kind: "completed", value: true });
        unregister();
        expect(handler.hasHandlers).toBe(false);
    });

    it("returns a promise for synchronous callbacks and retains registration methods", async () => {
        type SyncCallback = (input: number) => { kind: "completed"; value: number };
        const handler = firstHandledFunction<SyncCallback>();
        expectTypeOf(handler).returns.toEqualTypeOf<
            Promise<{ kind: "completed"; value: number } | { kind: "not-applicable" }>
        >();
        expectTypeOf(handler.hasHandlers).toEqualTypeOf<boolean>();
        expectTypeOf(handler.removeHandler).parameter(0).toEqualTypeOf<SyncCallback>();

        const provider: SyncCallback = (input) => ({ kind: "completed", value: input });
        handler.addHandler(provider);
        const result = handler(7);
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toEqual({ kind: "completed", value: 7 });
        handler.removeHandler(provider);
        expect(handler.hasHandlers).toBe(false);
    });
});

describe("handlers<T>().firstHandled", () => {
    it("selects the named callback type and runs its bound handler", async () => {
        type Api = {
            resolve?: (input: string) => Promise<HandlerOutcome<number, string>>;
        };
        const resolve = handlers<Api>().firstHandled("resolve");
        expectTypeOf(resolve).parameter(0).toBeString();
        expectTypeOf(resolve.hasHandlers).toEqualTypeOf<boolean>();
        expect(resolve.hasHandlers).toBe(false);

        resolve.addHandler(async (input) => ({ kind: "completed", value: input.length }));
        expect(resolve.hasHandlers).toBe(true);
        await expect(resolve("ready")).resolves.toEqual({ kind: "completed", value: 5 });
    });
});
