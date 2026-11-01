import { describe, expect, it } from "vitest";
import { constructCustomRegExpList, splitCustomRegExpList, timeDeltaToHumanReadable } from "./utils";
import type { CustomRegExpSource, CustomRegExpSourceList } from "./models/shared.type.util";
import { asCopy } from "./utils.object";

describe("timeDeltaToHumanReadable", () => {
    it.each<[number, string]>([
        [0, "0.00s"],
        [999, "1.00s"],
        [60_000, "1.00m"],
        [3_600_000, "1.00h"],
        [86_400_000, "1.00d"],
        [31_536_000_000, "1.00y"],
        [-1_000, "-1.00s"],
        [Number.NaN, "NaNy"],
        [Number.POSITIVE_INFINITY, "∞y"],
    ])("formats %s milliseconds as %s", (delta, expected) => {
        expect(timeDeltaToHumanReadable(delta)).toBe(expected);
    });
});

describe("custom regular-expression list helpers", () => {
    const list = (value: string): CustomRegExpSourceList<"||"> => value as CustomRegExpSourceList<"||">;
    const source = (value: string): CustomRegExpSource => value as CustomRegExpSource;

    it.each<[string, string, string[]]>([
        ["|a|b|", "|", ["a", "b"]],
        ["a||b", "|", ["a", "b"]],
        ["a| |b", "|", ["a", " ", "b"]],
        ["a\\|b|c", "|", ["a\\", "b", "c"]],
        ["", "|", []],
        ["left::::right", "::", ["left", "right"]],
    ])("splits %j on %j into %j", (value, delimiter, expected) => {
        expect(splitCustomRegExpList(list(value), delimiter)).toEqual(expected);
    });

    it("joins every item, including empty strings", () => {
        expect(constructCustomRegExpList([source(""), source("middle"), source("")], "::")).toBe("::middle::");
        expect(constructCustomRegExpList([], "::")).toBe("");
    });
});

describe("asCopy", () => {
    it("creates independent nested objects and arrays", () => {
        const original = { nested: { values: [1, 2] } };
        const copy = asCopy(original);

        expect(copy).toEqual(original);
        expect(copy).not.toBe(original);
        expect(copy.nested).not.toBe(original.nested);
        expect(copy.nested.values).not.toBe(original.nested.values);
    });

    it("uses JSON transformations for dates, undefined properties, NaN, and toJSON", () => {
        const omitted: string | undefined = undefined;
        const original = {
            date: new Date("2024-01-02T03:04:05.000Z"),
            omitted,
            notANumber: Number.NaN,
            custom: { toJSON: () => ({ serialised: true }) },
        };
        const copy = asCopy(original) as unknown as Record<string, unknown>;

        expect(copy).toEqual({
            date: "2024-01-02T03:04:05.000Z",
            notANumber: null,
            custom: { serialised: true },
        });
        expect(Object.hasOwn(copy, "omitted")).toBe(false);
    });

    it("throws when the top-level value serialises to undefined", () => {
        expect(() => asCopy(undefined) as unknown).toThrow();
    });

    it("throws for circular values and BigInt", () => {
        const circular: { self?: unknown } = {};
        circular.self = circular;

        expect(() => asCopy(circular)).toThrow();
        expect(() => asCopy({ value: 1n })).toThrow();
    });
});
