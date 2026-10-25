import { describe, expect, expectTypeOf, it, vi } from "vitest";
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

    it.each([{ kind: "completed" }, { kind: "veto" }] as const)(
        "waits for a payload-free $kind outcome and stops",
        async (outcome) => {
            const handler = new FirstHandledHandler<[]>("void outcome");
            let release!: (result: HandlerOutcome) => void;
            const pending = new Promise<HandlerOutcome>((resolve) => {
                release = resolve;
            });
            const later = vi.fn((): HandlerOutcome => ({ kind: "completed" }));
            handler.addHandler(() => ({ kind: "not-applicable" }));
            handler.addHandler(() => pending);
            handler.addHandler(later);
            let settled = false;
            const invocation = handler.invoke().then((result) => {
                settled = true;
                return result;
            });

            await Promise.resolve();
            expect(settled).toBe(false);
            expect(later).not.toHaveBeenCalled();
            release(outcome);
            await expect(invocation).resolves.toBe(outcome);
            expect(later).not.toHaveBeenCalled();
        }
    );

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
        laterCalled = false;
        await expect(handler.invoke()).resolves.toEqual({ kind: "not-applicable" });
        expect(laterCalled).toBe(false);
        unregisterFirst();
        expect(handler.hasHandlers).toBe(false);
    });

    it("runs a callback once per invocation and honours repeated unregistration", async () => {
        const handler = new FirstHandledHandler<[]>("registration");
        const skip = vi.fn((): HandlerOutcome => ({ kind: "not-applicable" }));
        const complete = vi.fn((): HandlerOutcome => ({ kind: "completed" }));
        const unregisterSkip = handler.use(skip);
        handler.addHandler(skip);
        const unregisterComplete = handler.addHandler(complete);

        await expect(handler.invoke()).resolves.toEqual({ kind: "completed" });
        await expect(handler.invoke()).resolves.toEqual({ kind: "completed" });
        expect(skip).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(2);

        unregisterSkip();
        unregisterSkip();
        handler.removeHandler(() => ({ kind: "veto" }));
        await expect(handler.invoke()).resolves.toEqual({ kind: "completed" });
        expect(skip).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(3);
        expect(handler.hasHandlers).toBe(true);
        unregisterComplete();
        expect(handler.hasHandlers).toBe(false);
        await expect(handler.invoke()).resolves.toEqual({ kind: "not-applicable" });
    });

    it("defers registrations made during an asynchronous invocation until the next invocation", async () => {
        const handler = new FirstHandledHandler<[], HandlerOutcome<string>>("new registration");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = vi.fn(async (): Promise<HandlerOutcome<string>> => {
            await gate;
            return { kind: "not-applicable" };
        });
        const original = vi.fn((): HandlerOutcome<string> => ({ kind: "completed", value: "original" }));
        const added = vi.fn((): HandlerOutcome<string> => ({ kind: "completed", value: "added" }));
        handler.addHandler(first);
        handler.addHandler(original, 10);

        const invocation = handler.invoke();
        expect(first).toHaveBeenCalledTimes(1);
        handler.addHandler(added, -1);
        release();
        await expect(invocation).resolves.toEqual({ kind: "completed", value: "original" });
        expect(added).not.toHaveBeenCalled();

        await expect(handler.invoke()).resolves.toEqual({ kind: "completed", value: "added" });
        expect(added).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
        expect(original).toHaveBeenCalledTimes(1);
    });

    it("keeps concurrent invocations and their results independent", async () => {
        const handler = new FirstHandledHandler<[string], HandlerOutcome<string>>("concurrent");
        const releases = new Map<string, () => void>();
        const completed: string[] = [];
        handler.addHandler(async (input) => {
            await new Promise<void>((resolve) => {
                releases.set(input, resolve);
            });
            return { kind: "not-applicable" };
        });
        handler.addHandler((input) => {
            completed.push(input);
            return { kind: "completed", value: input };
        });

        const first = handler.invoke("first");
        const second = handler.invoke("second");
        expect([...releases.keys()]).toEqual(["first", "second"]);
        releases.get("second")!();
        await expect(second).resolves.toEqual({ kind: "completed", value: "second" });
        expect(completed).toEqual(["second"]);
        releases.get("first")!();
        await expect(first).resolves.toEqual({ kind: "completed", value: "first" });
        expect(completed).toEqual(["second", "first"]);
    });

    it("can invoke the same registrations again after a rejected invocation", async () => {
        const handler = new FirstHandledHandler<[], HandlerOutcome<number>>("retry");
        const failure = new Error("first invocation failed");
        const first = vi
            .fn<() => Promise<HandlerOutcome<number>>>()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({ kind: "not-applicable" });
        const next = vi.fn((): HandlerOutcome<number> => ({ kind: "completed", value: 7 }));
        handler.addHandler(first);
        handler.addHandler(next);

        await expect(handler.invoke()).rejects.toBe(failure);
        expect(next).not.toHaveBeenCalled();
        await expect(handler.invoke()).resolves.toEqual({ kind: "completed", value: 7 });
        expect(first).toHaveBeenCalledTimes(2);
        expect(next).toHaveBeenCalledTimes(1);
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

    it("forwards priorities and every argument without replacing referenced values", async () => {
        type Payload = { text: string };
        type Callback = (path: string, payload: Payload, ...positions: number[]) => HandlerOutcome<Payload>;
        const handler = firstHandledFunction<Callback>("arguments");
        const payload = { text: "content" };
        const order: string[] = [];
        const late = vi.fn<Callback>(() => {
            order.push("late");
            return { kind: "completed", value: payload };
        });
        const early = vi.fn<Callback>(() => {
            order.push("early");
            return { kind: "not-applicable" };
        });
        handler.addHandler(late, 10);
        handler.addHandler(early, -1);

        const result = await handler("note.md", payload, 0, 4);
        expect(order).toEqual(["early", "late"]);
        expect(early).toHaveBeenCalledExactlyOnceWith("note.md", payload, 0, 4);
        expect(late).toHaveBeenCalledExactlyOnceWith("note.md", payload, 0, 4);
        expect(early.mock.calls[0][1]).toBe(payload);
        expect(late.mock.calls[0][1]).toBe(payload);
        expect(result).toEqual({ kind: "completed", value: payload });
        if (result.kind === "completed") expect(result.value).toBe(payload);
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
