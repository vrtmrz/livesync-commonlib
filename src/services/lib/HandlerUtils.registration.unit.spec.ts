import { describe, expect, it, vi } from "vitest";
import { Binder, LazyBinder, bindableFunction, lazyBindableFunction } from "./HandlerUtils";

describe.each([
    ["Binder", () => new Binder<(value: string) => string>("registration")],
    ["LazyBinder", () => new LazyBinder<(value: string) => string>("registration")],
] as const)("%s registration ownership", (_name, createBinder) => {
    it.each([false, true])(
        "keeps a replacement when the old registration is removed (same callback: %s)",
        async (sameCallback) => {
            const binder = createBinder();
            const first = vi.fn((value: string) => `first:${value}`);
            const replacement = sameCallback ? first : vi.fn((value: string) => `replacement:${value}`);
            const removeFirst = binder.assign(first);
            const removeReplacement = binder.assign(replacement, true);

            removeFirst();
            const invocation = binder.invoke("value");
            // Observe invocation without awaiting a lazy registration that an incorrect removal has cleared.
            await Promise.resolve();
            expect(replacement).toHaveBeenCalledWith("value");
            await expect(Promise.resolve(invocation)).resolves.toBe(`${sameCallback ? "first" : "replacement"}:value`);
            removeReplacement();
        }
    );

    it("keeps a later assignment when an earlier removal is repeated", async () => {
        const binder = createBinder();
        const removeFirst = binder.assign((value) => value);
        removeFirst();
        const current = vi.fn((value: string) => value);
        binder.assign(current);
        removeFirst();

        const invocation = binder.invoke("current");
        await Promise.resolve();
        expect(current).toHaveBeenCalledWith("current");
        await expect(Promise.resolve(invocation)).resolves.toBe("current");
    });

    it("retains the current registration after rejecting an override", async () => {
        const binder = createBinder();
        const remove = binder.assign((value) => value);
        expect(() => binder.assign(() => "rejected")).toThrow("already assigned");
        await expect(Promise.resolve(binder.invoke("current"))).resolves.toBe("current");
        remove();
        const replacement = vi.fn((value: string) => value);
        binder.assign(replacement);
        await expect(Promise.resolve(binder.invoke("replacement"))).resolves.toBe("replacement");
    });

    it("preserves the callback receiver", async () => {
        const binder = createBinder();
        binder.assign(function (this: unknown, value: string) {
            expect(this).toBe(binder);
            return value;
        });
        await expect(Promise.resolve(binder.invoke("value"))).resolves.toBe("value");
    });
});

describe("LazyBinder waiting registration", () => {
    it("keeps waiting invocations attached when removal is repeated", async () => {
        const binder = new LazyBinder<(value: string) => string>("waiting");
        const remove = binder.assign((value) => value);
        remove();
        const waiting = binder.invoke("waiting");
        remove();
        const current = vi.fn((value: string) => value);
        binder.assign(current);

        await Promise.resolve();
        expect(current).toHaveBeenCalledWith("waiting");
        await expect(waiting).resolves.toBe("waiting");
    });
});

describe("bindable registration functions", () => {
    it.each([
        ["immediate", bindableFunction<() => string>],
        ["lazy", lazyBindableFunction<() => string>],
    ] as const)("returns a registration-specific remover from the %s wrapper", async (_name, createFunction) => {
        const handler = createFunction("wrapped");
        const remove = handler.setHandler(() => "old");
        const current = vi.fn(() => "current");
        handler.setHandler(current, true);
        expect(remove).toBeTypeOf("function");
        remove();
        const result = handler();
        await Promise.resolve();
        expect(current).toHaveBeenCalledOnce();
        await expect(Promise.resolve(result)).resolves.toBe("current");
    });
});
