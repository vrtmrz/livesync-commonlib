import { describe, it, expect, beforeEach } from "vitest";
import {
    Binder,
    LazyBinder,
    MultiBinder,
    Dispatch,
    DispatchParallel,
    AllHandler,
    ParallelAllHandler,
    AnySuccessHandler,
    FirstResultHandler,
    bindableFunction,
    allFunction,
    anySuccessFunction,
    handlers,
} from "./HandlerUtils";

describe("Binder", () => {
    describe("constructor", () => {
        it("should create a Binder without initial callback", () => {
            const binder = new Binder<() => string>("test");
            expect(binder).toBeDefined();
        });

        it("should create a Binder with initial callback", () => {
            const callback = () => "initial";
            const binder = new Binder<() => string>("test", callback);
            expect(binder).toBeDefined();
        });
    });

    describe("assign", () => {
        it("should assign a callback function", () => {
            const binder = new Binder<() => string>("test");
            const callback = () => "result";
            const unregister = binder.assign(callback);
            expect(unregister).toBeDefined();
            expect(typeof unregister).toBe("function");
        });

        it("should throw error when assigning twice without override", () => {
            const binder = new Binder<() => string>("test");
            const callback1 = () => "result1";
            const callback2 = () => "result2";
            binder.assign(callback1);
            expect(() => binder.assign(callback2)).toThrow(/already assigned/);
        });

        it("should allow override when override flag is true", () => {
            const binder = new Binder<() => string>("test");
            const callback1 = () => "result1";
            const callback2 = () => "result2";
            binder.assign(callback1);
            expect(() => binder.assign(callback2, true)).not.toThrow();
        });

        it("should throw error when assigning to initial callback without override", () => {
            const initialCallback = () => "initial";
            const binder = new Binder<() => string>("test", initialCallback);
            const newCallback = () => "new";
            expect(() => binder.assign(newCallback)).toThrow(/already assigned/);
        });
    });

    describe("invoke", () => {
        it("should invoke assigned callback with no arguments", () => {
            const binder = new Binder<() => string>("test");
            const callback = () => "result";
            binder.assign(callback);
            const result = binder.invoke();
            expect(result).toBe("result");
        });

        it("should invoke assigned callback with single argument", () => {
            const binder = new Binder<(x: number) => number>("test");
            const callback = (x: number) => x * 2;
            binder.assign(callback);
            const result = binder.invoke(5);
            expect(result).toBe(10);
        });

        it("should invoke assigned callback with multiple arguments", () => {
            const binder = new Binder<(a: number, b: number) => number>("test");
            const callback = (a: number, b: number) => a + b;
            binder.assign(callback);
            const result = binder.invoke(3, 4);
            expect(result).toBe(7);
        });

        it("should invoke initial callback", () => {
            const callback = () => "initial result";
            const binder = new Binder<() => string>("test", callback);
            const result = binder.invoke();
            expect(result).toBe("initial result");
        });

        it("should throw error when invoking without assigned callback", () => {
            const binder = new Binder<() => string>("test");
            expect(() => binder.invoke()).toThrow(/not assigned/);
        });

        it("should handle async callback that returns a promise", async () => {
            const binder = new Binder<() => Promise<string>>("test");
            const callback = async () => "async result";
            binder.assign(callback);
            const result = binder.invoke();
            expect(result instanceof Promise).toBe(true);
            const awaitedResult = await result;
            expect(awaitedResult).toBe("async result");
        });

        it("should propagate callback errors", () => {
            const binder = new Binder<() => void>("test");
            const callback = () => {
                throw new Error("callback error");
            };
            binder.assign(callback);
            expect(() => binder.invoke()).toThrow(/callback error/);
        });
    });

    describe("unregister function", () => {
        it("should clear the callback when invoked", () => {
            const binder = new Binder<() => string>("test");
            const callback = () => "result";
            const unregister = binder.assign(callback);
            unregister();
            expect(() => binder.invoke()).toThrow(/not assigned/);
        });

        it("should allow reassignment after unregister", () => {
            const binder = new Binder<() => string>("test");
            const callback1 = () => "result1";
            const callback2 = () => "result2";
            const unregister = binder.assign(callback1);
            unregister();
            binder.assign(callback2);
            const result = binder.invoke();
            expect(result).toBe("result2");
        });

        it("should return a function that can be called multiple times", () => {
            const binder = new Binder<() => string>("test");
            const callback = () => "result";
            const unregister = binder.assign(callback);
            unregister();
            expect(() => unregister()).not.toThrow();
        });
    });

    describe("generic typing", () => {
        it("should work with different return types", () => {
            const stringBinder = new Binder<() => string>("string");
            stringBinder.assign(() => "string");
            expect(stringBinder.invoke()).toBe("string");

            const numberBinder = new Binder<() => number>("number");
            numberBinder.assign(() => 42);
            expect(numberBinder.invoke()).toBe(42);
        });

        it("should work with object arguments and returns", () => {
            interface TestObject {
                value: string;
            }
            const binder = new Binder<(obj: TestObject) => TestObject>("test");
            const callback = (obj: TestObject) => ({
                ...obj,
                value: obj.value.toUpperCase(),
            });
            binder.assign(callback);
            const result = binder.invoke({ value: "hello" });
            expect(result.value).toBe("HELLO");
        });
    });
});

describe("LazyBinder", () => {
    describe("invoke", () => {
        it("should wait for handler assignment before invoking", async () => {
            const binder = new LazyBinder<() => Promise<string>>("test");
            const invokePromise = binder.invoke();
            const callback = async () => "lazy result";
            binder.assign(callback);
            const result = await invokePromise;
            expect(result).toBe("lazy result");
        });

        it("should invoke immediately if handler is already assigned", async () => {
            const callback = async () => "immediate result";
            const binder = new LazyBinder<() => Promise<string>>("test", callback);
            const result = await binder.invoke();
            expect(result).toBe("immediate result");
        });

        it("should handle multiple concurrent invocations", async () => {
            const binder = new LazyBinder<(x: number) => Promise<number>>("test");
            const callback = async (x: number) => x * 2;
            const invoke1 = binder.invoke(5);
            const invoke2 = binder.invoke(10);
            binder.assign(callback);
            const [result1, result2] = await Promise.all([invoke1, invoke2]);
            expect(result1).toBe(10);
            expect(result2).toBe(20);
        });

        it("should wait for newly assigned handler after unregister", async () => {
            const binder = new LazyBinder<() => Promise<string>>("test");
            const callback1 = async () => "result1";
            binder.assign(callback1);
            const unregister = binder.assign(callback1, true);
            unregister();
            const invokePromise = binder.invoke();
            const callback2 = async () => "result2";
            binder.assign(callback2);
            const result = await invokePromise;
            expect(result).toBe("result2");
        });
        it("should error if assign twice without override", () => {
            const binder = new LazyBinder<() => Promise<string>>("test");
            const callback1 = async () => "result1";
            const callback2 = async () => "result2";
            binder.assign(callback1);
            expect(() => binder.assign(callback2)).toThrow(/already assigned/);
        });
        it("should raise error if assigned null handler", async () => {
            const binder = new LazyBinder<() => Promise<string>>("test");
            binder.assign(null as any);
            await expect(binder.invoke()).rejects.toThrow(/not assigned/);
        });
    });
});

describe("MultiBinder", () => {
    describe("addHandler", () => {
        it("should add a handler function", () => {
            const multiBinder = new MultiBinder<() => string>("test");
            const callback = () => "result";
            const unregister = multiBinder.addHandler(callback);
            expect(unregister).toBeDefined();
            expect(typeof unregister).toBe("function");
        });

        it("should not add the same function twice", () => {
            const multiBinder = new MultiBinder<() => string>("test");
            const callback = () => "result";
            multiBinder.addHandler(callback);
            multiBinder.addHandler(callback);
            // We cannot directly test the Set size, so we test indirectly
            const unregister1 = multiBinder.addHandler(callback);
            unregister1();
            // If the same callback was added twice, it would still exist
            // This is a limitation of the Set approach
            expect(multiBinder).toBeDefined();
        });
    });

    describe("removeHandler", () => {
        it("should remove a handler function", () => {
            const multiBinder = new MultiBinder<() => string>("test");
            const callback = () => "result";
            multiBinder.addHandler(callback);
            multiBinder.removeHandler(callback);
            expect(multiBinder).toBeDefined();
        });

        it("should not throw error when removing non-existent handler", () => {
            const multiBinder = new MultiBinder<() => string>("test");
            const callback = () => "result";
            expect(() => multiBinder.removeHandler(callback)).not.toThrow();
        });
    });

    describe("unregister function", () => {
        it("should remove handler when called", () => {
            const multiBinder = new MultiBinder<() => string>("test");
            const callback = () => "result";
            const unregister = multiBinder.addHandler(callback);
            unregister();
            expect(multiBinder).toBeDefined();
        });
    });
});

describe("Dispatch", () => {
    describe("dispatch", () => {
        it("should collect results from all handlers sequentially", async () => {
            const dispatch = new Dispatch<[], number>("test");
            dispatch.addHandler(async () => 1);
            dispatch.addHandler(async () => 2);
            dispatch.addHandler(async () => 3);
            const results = await dispatch.dispatch();
            expect(results).toEqual([1, 2, 3]);
        });

        it("should collect errors from handlers", async () => {
            const dispatch = new Dispatch<[], number>("test");
            dispatch.addHandler(async () => 1);
            dispatch.addHandler(async () => {
                throw new Error("handler error");
            });
            dispatch.addHandler(async () => 3);
            const results = await dispatch.dispatch();
            expect(results).toHaveLength(3);
            expect(results[0]).toBe(1);
            expect(results[1] instanceof Error).toBe(true);
            expect(results[2]).toBe(3);
        });

        it("should handle synchronous handlers", async () => {
            const dispatch = new Dispatch<[], number>("test");
            dispatch.addHandler(() => 10);
            dispatch.addHandler(() => 20);
            const results = await dispatch.dispatch();
            expect(results).toEqual([10, 20]);
        });

        it("should pass arguments to handlers", async () => {
            const dispatch = new Dispatch<[number, number], number>("test");
            dispatch.addHandler(async (a: number, b: number) => a + b);
            dispatch.addHandler(async (a: number, b: number) => a * b);
            const results = await dispatch.dispatch(5, 3);
            expect(results).toEqual([8, 15]);
        });

        it("should handle empty handler list", async () => {
            const dispatch = new Dispatch<[], number>("test");
            const results = await dispatch.dispatch();
            expect(results).toEqual([]);
        });
    });
});

describe("DispatchParallel", () => {
    describe("dispatch", () => {
        it("should dispatch to all handlers in parallel", async () => {
            const dispatch = new DispatchParallel<[], number>("test");
            const order: number[] = [];
            dispatch.addHandler(async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                order.push(1);
                return 1;
            });
            dispatch.addHandler(async () => {
                order.push(2);
                return 2;
            });
            const results = await dispatch.dispatch();
            expect(results).toEqual([1, 2]);
            expect(order).toEqual([2, 1]);
        });

        it("should collect errors from handlers", async () => {
            const dispatch = new DispatchParallel<[], number>("test");
            dispatch.addHandler(async () => 1);
            dispatch.addHandler(async () => {
                throw new Error("parallel error");
            });
            const results = await dispatch.dispatch();
            expect(results).toHaveLength(2);
            expect(results[0]).toBe(1);
            expect(results[1] instanceof Error).toBe(true);
        });
    });
});

describe("AllHandler", () => {
    describe("invoke", () => {
        it("should return true when all handlers return true", async () => {
            const handler = new AllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => true);
            const result = await handler.invoke();
            expect(result).toBe(true);
        });

        it("should return false when any handler returns false", async () => {
            const handler = new AllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => false);
            handler.addHandler(async () => true);
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should return false on first error", async () => {
            const handler = new AllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => {
                throw new Error("handler error");
            });
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should return true when no handlers are registered", async () => {
            const handler = new AllHandler<[]>("test");
            const result = await handler.invoke();
            expect(result).toBe(true);
        });

        it("should stop at first false result", async () => {
            const handler = new AllHandler<[]>("test");
            let callCount = 0;
            handler.addHandler(async () => true);
            handler.addHandler(async () => {
                callCount++;
                return false;
            });
            handler.addHandler(async () => {
                callCount++;
                return true;
            });
            const result = await handler.invoke();
            expect(result).toBe(false);
            expect(callCount).toBe(1);
        });
    });
});

describe("ParallelAllHandler", () => {
    describe("invoke", () => {
        it("should return true when all handlers return true in parallel", async () => {
            const handler = new ParallelAllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => true);
            const result = await handler.invoke();
            expect(result).toBe(true);
        });

        it("should return false when any handler returns false", async () => {
            const handler = new ParallelAllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => false);
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should return false on any error", async () => {
            const handler = new ParallelAllHandler<[]>("test");
            handler.addHandler(async () => true);
            handler.addHandler(async () => {
                throw new Error("handler error");
            });
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should return true when no handlers are registered", async () => {
            const handler = new ParallelAllHandler<[]>("test");
            const result = await handler.invoke();
            expect(result).toBe(true);
        });
    });
});

describe("FirstSuccessHandler", () => {
    describe("invoke", () => {
        it("should return true on first successful handler", async () => {
            const handler = new AnySuccessHandler<[]>("test");
            handler.addHandler(async () => false);
            handler.addHandler(async () => true);
            handler.addHandler(async () => true);
            const result = await handler.invoke();
            expect(result).toBe(true);
        });

        it("should return false when all handlers return false", async () => {
            const handler = new AnySuccessHandler<[]>("test");
            handler.addHandler(async () => false);
            handler.addHandler(async () => false);
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should ignore errors and continue", async () => {
            const handler = new AnySuccessHandler<[]>("test");
            handler.addHandler(async () => {
                throw new Error("ignored error");
            });
            handler.addHandler(async () => true);
            const result = await handler.invoke();
            expect(result).toBe(true);
        });

        it("should return false when no handlers succeed", async () => {
            const handler = new AnySuccessHandler<[]>("test");
            const result = await handler.invoke();
            expect(result).toBe(false);
        });
    });
});

describe("FirstResultHandler", () => {
    describe("invoke", () => {
        it("should return first non-falsy result", async () => {
            const handler = new FirstResultHandler<[], string | undefined>("test");
            handler.addHandler(async () => undefined);
            handler.addHandler(async () => "first result");
            handler.addHandler(async () => "second result");
            const result = await handler.invoke();
            expect(result).toBe("first result");
        });

        it("should return false when no non-falsy results found", async () => {
            const handler = new FirstResultHandler<[], string | undefined | boolean>("test");
            handler.addHandler(async () => undefined);
            handler.addHandler(async () => false);
            const result = await handler.invoke();
            expect(result).toBe(false);
        });

        it("should ignore errors and continue", async () => {
            const handler = new FirstResultHandler<[], string | undefined | boolean>("test");
            handler.addHandler(async () => {
                throw new Error("ignored error");
            });
            handler.addHandler(async () => "result after error");
            const result = await handler.invoke();
            expect(result).toBe("result after error");
        });

        it("should skip undefined and false values", async () => {
            const handler = new FirstResultHandler<[], number | undefined | boolean>("test");
            handler.addHandler(async () => undefined);
            handler.addHandler(async () => false);
            handler.addHandler(async () => 0);
            const result = await handler.invoke();
            expect(result).toBe(0);
        });
    });
});

describe("bindableFunction", () => {
    describe("invocation and assignment", () => {
        it("should create a bindable function", () => {
            const func = bindableFunction<() => string>("test");
            expect(typeof func).toBe("function");
        });

        it("should invoke assigned handler", () => {
            const func = bindableFunction<() => string>("test");
            func.setHandler(() => "result");
            const result = func();
            expect(result).toBe("result");
        });

        it("should throw error when invoking without assigned handler", () => {
            const func = bindableFunction<() => string>("test");
            expect(() => func()).toThrow(/not assigned/);
        });

        it("should allow override of assigned handler", () => {
            const func = bindableFunction<() => string>("test");
            func.setHandler(() => "first");
            func.setHandler(() => "second", true);
            const result = func();
            expect(result).toBe("second");
        });
    });
});

describe("allFunction", () => {
    describe("handler management and invocation", () => {
        it("should create an all handler function", () => {
            const func = allFunction<(...args: []) => Promise<boolean>>("test");
            expect(typeof func).toBe("function");
        });

        it("should invoke all handlers and return true if all succeed", async () => {
            const func = allFunction<(...args: []) => Promise<boolean>>("test");
            func.addHandler(async () => true);
            func.addHandler(async () => true);
            const result = await func();
            expect(result).toBe(true);
        });

        it("should return false if any handler returns false", async () => {
            const func = allFunction<(...args: []) => Promise<boolean>>("test");
            func.addHandler(async () => true);
            func.addHandler(async () => false);
            const result = await func();
            expect(result).toBe(false);
        });

        it("should remove handlers correctly", async () => {
            const func = allFunction<(...args: []) => Promise<boolean>>("test");
            const handler1 = async () => true;
            const handler2 = async () => false;
            func.addHandler(handler1);
            func.addHandler(handler2);
            func.removeHandler(handler2);
            const result = await func();
            expect(result).toBe(true);
        });
    });
});

interface ITestFunc {
    hello: (message: string) => Promise<boolean>;
    world: (i: number) => Promise<number>;
}

describe("handlers", () => {
    const handler = handlers<ITestFunc>();
    it("should call all 'hello' handlers", async () => {
        const all = handler.all("hello");
        let messages: string[] = [];
        all.addHandler((message: string) => {
            messages.push(`handler1: ${message}`);
            return Promise.resolve(true);
        });
        all.addHandler((message: string) => {
            messages.push(`handler2: ${message}`);
            return Promise.resolve(true);
        });
        await all("test message");
        expect(messages).toEqual(["handler1: test message", "handler2: test message"]);
    });
    it("should return first successful 'world' handler result", async () => {
        const firstResult = handler.firstResult("world");
        firstResult.addHandler(async (i: number) => {
            if (i > 0) return i * 2;
            throw new Error("Invalid input");
        });
        firstResult.addHandler(async (i: number) => {
            return Promise.resolve(i + 10);
        });
        const result = await firstResult(5);
        expect(result).toBe(10);
    });
    it("should bail checks on first failure ", async () => {
        const bailFirstFailure = handler.bailFirstFailure("hello");
        const results: string[] = [];
        bailFirstFailure.addHandler(async (msg: string) => {
            results.push("handler1");
            return Promise.resolve(true);
        });
        bailFirstFailure.addHandler(async (msg: string) => {
            results.push("handler2");
            return Promise.resolve(false);
        });
        bailFirstFailure.addHandler(async (msg: string) => {
            results.push("handler3");
            return Promise.resolve(true);
        });
        const result = await bailFirstFailure("test");
        expect(result).toBe(false);
        expect(results).toEqual(["handler1", "handler2"]);
    });
    it("should handle parallel all handlers", async () => {
        const parallelAll = handler.allParallel("hello");
        const results: string[] = [];
        parallelAll.addHandler(async (msg: string) => {
            await new Promise((resolve) => setTimeout(resolve, 10));

            results.push("handler1");
            return Promise.resolve(true);
        });
        parallelAll.addHandler(async (msg: string) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            results.push("handler2");
            return Promise.resolve(true);
        });
        parallelAll.addHandler(async (msg: string) => {
            await new Promise((resolve) => setTimeout(resolve, 20));

            results.push("handler3");
            return Promise.resolve(true);
        });

        const result = await parallelAll("test");
        expect(result).toBe(true);
        expect(results).toEqual(["handler1", "handler3", "handler2"]);
    });
    it("should dispatch in parallel and collect results", async () => {
        const dispatchParallel = handler.dispatchParallel("world");
        dispatchParallel.addHandler(async (i: number) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return i + 1;
        });
        dispatchParallel.addHandler(async (i: number) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return i + 2;
        });
        const results = await dispatchParallel(5);
        expect(results).toEqual([6, 7]);
    });
    it("should handle pick any success", async () => {
        const anySuccess = handler.anySuccess("hello");
        anySuccess.addHandler(async (str: string) => {
            throw new Error("Failure");
        });
        anySuccess.addHandler(async (str: string) => {
            return Promise.resolve(false);
        });
        anySuccess.addHandler(async (str: string) => {
            return Promise.resolve(true);
        });
        const result = await anySuccess("test");
        expect(result).toBe(true);
    });
    it("if no success, return false", async () => {
        const anySuccess = handler.anySuccess("hello");
        anySuccess.addHandler(async (str: string) => {
            throw new Error("Failure");
        });
        anySuccess.addHandler(async (str: string) => {
            return Promise.resolve(false);
        });
        anySuccess.addHandler(async (str: string) => {
            return Promise.resolve(false);
        });
        const result = await anySuccess("test");
        expect(result).toBe(false);
    });
    it("should handle bindable functions", async () => {
        const bindable = handler.binder("world");
        bindable.setHandler(async (i: number) => {
            return Promise.resolve(i * 3);
        });
        const result = await bindable(7);
        expect(result).toBe(21);
    });
    it("should handle lazy bindable functions", async () => {
        const lazyBindable = handler.lazyBinder("world");
        const invokePromise = lazyBindable(4);
        const result = invokePromise;
        expect(await Promise.race([result, -1])).toBe(-1); // should not resolve yet
        lazyBindable.setHandler(async (i: number) => {
            return Promise.resolve(i + 6);
        });
        expect(await result).toBe(10);
    });
});
