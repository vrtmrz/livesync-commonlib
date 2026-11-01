import { describe, expect, it } from "vitest";
import { createKeyedPendingWork } from "./keyedPendingWork.ts";

type Work = { readonly key: string; readonly value: number };

describe("createKeyedPendingWork", () => {
    it("starts empty and becomes empty after its last entry is claimed", () => {
        const pending = createKeyedPendingWork<Work["key"], Work>((work) => work.key);

        expect(pending.size).toBe(0);
        expect(pending.peek()).toBeUndefined();
        expect(pending.values()).toEqual([]);

        const work = { key: "only", value: 1 };
        pending.add(work);
        const entry = pending.peek();

        expect(entry).toEqual({ key: "only", value: work });
        expect(pending.claim(entry!)).toBe(true);
        expect(pending.size).toBe(0);
        expect(pending.peek()).toBeUndefined();
        expect(pending.values()).toEqual([]);
    });

    it("peeks without removing and preserves insertion order", () => {
        const pending = createKeyedPendingWork<Work["key"], Work>((work) => work.key);
        const first = { key: "first", value: 1 };
        const second = { key: "second", value: 2 };
        const third = { key: "third", value: 3 };

        pending.add(first);
        pending.add(second);
        pending.add(third);

        expect(pending.peek()).toEqual({ key: "first", value: first });
        expect(pending.peek()).toEqual({ key: "first", value: first });
        expect(pending.size).toBe(3);
        expect(pending.values()).toEqual([first, second, third]);
    });

    it("replaces same-key work and moves the replacement to the tail", () => {
        const pending = createKeyedPendingWork<Work["key"], Work>((work) => work.key);
        const first = { key: "first", value: 1 };
        const second = { key: "second", value: 2 };
        const third = { key: "third", value: 3 };
        const replacement = { key: "first", value: 4 };

        pending.add(first);
        pending.add(second);
        pending.add(third);
        pending.add(replacement);

        expect(pending.size).toBe(3);
        expect(pending.values()).toEqual([second, third, replacement]);
        expect(pending.peek()).toEqual({ key: "second", value: second });
    });

    it("rejects stale and copied entries while allowing a current entry to be claimed once", () => {
        const pending = createKeyedPendingWork<Work["key"], Work>((work) => work.key);
        const original = { key: "same", value: 1 };
        const replacement = { key: "same", value: 2 };

        pending.add(original);
        const staleEntry = pending.peek()!;
        pending.add(replacement);

        expect(pending.claim(staleEntry)).toBe(false);
        expect(pending.values()).toEqual([replacement]);

        const currentEntry = pending.peek()!;
        expect(pending.claim({ key: currentEntry.key, value: currentEntry.value })).toBe(false);
        expect(pending.size).toBe(1);
        expect(pending.claim(currentEntry)).toBe(true);
        expect(pending.claim(currentEntry)).toBe(false);
        expect(pending.values()).toEqual([]);
    });

    it("supports falsy and undefined keys and values", () => {
        type FalsyValue = string | number | boolean | undefined;
        const pending = createKeyedPendingWork<FalsyValue, FalsyValue>((value) => value);
        const values: FalsyValue[] = ["", 0, false, undefined];

        for (const value of values) {
            pending.add(value);
        }

        expect(pending.size).toBe(values.length);
        expect(pending.values()).toEqual(values);

        for (const value of values) {
            const entry = pending.peek();
            expect(entry).toEqual({ key: value, value });
            expect(pending.claim(entry!)).toBe(true);
        }

        expect(pending.size).toBe(0);
    });

    it("returns a values snapshot that is independent of later queue changes", () => {
        const pending = createKeyedPendingWork<Work["key"], Work>((work) => work.key);
        const first = { key: "first", value: 1 };
        const second = { key: "second", value: 2 };
        const third = { key: "third", value: 3 };
        const replacement = { key: "first", value: 4 };

        pending.add(first);
        pending.add(second);
        const snapshot = pending.values();

        pending.add(third);
        pending.add(replacement);
        pending.claim(pending.peek()!);

        expect(snapshot).toEqual([first, second]);
        expect(pending.values()).toEqual([third, replacement]);
        expect(pending.values()).not.toBe(snapshot);
    });

    it("keeps distinct pending work without a fixed capacity limit", () => {
        const pending = createKeyedPendingWork<number, { readonly key: number }>((work) => work.key);
        const count = 4096;

        for (let key = 0; key < count; key++) {
            pending.add({ key });
        }

        const values = pending.values();
        expect(pending.size).toBe(count);
        expect(values).toHaveLength(count);
        expect(values[0]).toEqual({ key: 0 });
        expect(values[count - 1]).toEqual({ key: count - 1 });
    });

    it("leaves queue state unchanged when key extraction throws", () => {
        type MaybeInvalidWork = Work | { readonly throws: true };
        const pending = createKeyedPendingWork<string, MaybeInvalidWork>((work) => {
            if ("throws" in work) {
                throw new Error("key extraction failed");
            }
            return work.key;
        });
        const first = { key: "first", value: 1 };
        const second = { key: "second", value: 2 };

        pending.add(first);
        pending.add(second);
        const firstEntry = pending.peek()!;
        const snapshot = pending.values();

        expect(() => pending.add({ throws: true })).toThrow("key extraction failed");
        expect(pending.size).toBe(2);
        expect(pending.peek()).toEqual({ key: "first", value: first });
        expect(pending.values()).toEqual(snapshot);
        expect(pending.claim(firstEntry)).toBe(true);
        expect(pending.values()).toEqual([second]);
    });

    it("keeps separately created queues independent", () => {
        const createPending = () => createKeyedPendingWork<Work["key"], Work>((work) => work.key);
        const firstSource = createPending();
        const secondSource = createPending();
        const firstValue = { key: "shared", value: 1 };
        const replacement = { key: "shared", value: 2 };
        const secondValue = { key: "shared", value: 3 };

        firstSource.add(firstValue);
        secondSource.add(secondValue);
        firstSource.add(replacement);

        expect(firstSource.values()).toEqual([replacement]);
        expect(secondSource.values()).toEqual([secondValue]);
        expect(firstSource.claim(firstSource.peek()!)).toBe(true);
        expect(firstSource.values()).toEqual([]);
        expect(secondSource.peek()).toEqual({ key: "shared", value: secondValue });
        expect(secondSource.size).toBe(1);
    });
});
