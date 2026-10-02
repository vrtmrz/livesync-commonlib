import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, generatePatchObj, mergeObject } from "./utils.patch";

const marker = "livesyncSyntheticPrototypeMarker";
const propertyNames = ["__proto__", "constructor", "prototype", "proto", "toString"];
const intrinsics = [Object.prototype, Object, Function.prototype, Object.prototype.toString];
let snapshots: { target: object; descriptors: PropertyDescriptorMap; prototype: object | null }[];

function json(value: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value));
}

function payload(key: string) {
    return json({
        [key]:
            key === "constructor"
                ? { [marker]: "synthetic", prototype: { [marker]: "synthetic" } }
                : { [marker]: "synthetic" },
    });
}

function assertIntrinsicsUnchanged() {
    for (const snapshot of snapshots) {
        expect(Object.getOwnPropertyDescriptors(snapshot.target)).toEqual(snapshot.descriptors);
        expect(Object.getPrototypeOf(snapshot.target)).toBe(snapshot.prototype);
    }
}

function assertDataPrototypes(value: unknown) {
    if (value === null || typeof value !== "object") return;
    expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const child of Object.values(value)) assertDataPrototypes(child);
}

beforeEach(() => {
    snapshots = intrinsics.map((target) => ({
        target,
        descriptors: Object.getOwnPropertyDescriptors(target),
        prototype: Object.getPrototypeOf(target),
    }));
});

afterEach(() => {
    // Restore the complete synthetic test changes even when a regression assertion fails.
    for (const snapshot of snapshots) {
        for (const key of Reflect.ownKeys(snapshot.target)) {
            if (!Object.prototype.hasOwnProperty.call(snapshot.descriptors, key))
                Reflect.deleteProperty(snapshot.target, key);
        }
        Object.defineProperties(snapshot.target, snapshot.descriptors);
        Object.setPrototypeOf(snapshot.target, snapshot.prototype);
    }
});

describe("JSON object patches", () => {
    it.each(propertyNames)("generates patches for named properties %s at each object depth", (key) => {
        const target = payload(key);
        const patch = generatePatchObj({}, target);
        const nestedPatch = generatePatchObj({ container: {} }, { container: target });
        assertIntrinsicsUnchanged();
        assertDataPrototypes(patch);
        assertDataPrototypes(nestedPatch);
        expect(Object.prototype.hasOwnProperty.call(patch, key)).toBe(true);
        expect(patch).toEqual(target);
        expect(nestedPatch).toEqual({ container: target });
    });

    it.each(propertyNames)("applies patches for named properties %s", (key) => {
        const patch = payload(key);
        let result: unknown;
        let error: unknown;
        try {
            result = applyPatch({}, patch);
        } catch (caught) {
            error = caught;
        }
        assertIntrinsicsUnchanged();
        expect(error).toBeUndefined();
        assertDataPrototypes(result);
        expect(result).toEqual(patch);
        expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true);
    });

    it.each(propertyNames)("round-trips nested JSON containing %s", (key) => {
        const base = { container: {} };
        const target = { container: payload(key), ordinary: "synthetic" };
        const patch = generatePatchObj(json(base), json(target));
        let result: unknown;
        let error: unknown;
        try {
            result = applyPatch(json(base), patch);
        } catch (caught) {
            error = caught;
        }
        assertIntrinsicsUnchanged();
        expect(error).toBeUndefined();
        assertDataPrototypes(result);
        expect(result).toEqual(target);
    });

    it.each(propertyNames)("retains named properties %s when merging objects", (key) => {
        const source = payload(key);
        const result = mergeObject({ ordinary: "retained" }, source);
        assertIntrinsicsUnchanged();
        assertDataPrototypes(result);
        expect(result).toEqual(json({ ordinary: "retained", ...source }));
        expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true);
    });

    it.each(propertyNames)("updates and deletes existing %s properties", (key) => {
        const base = payload(key);
        const target = json({ [key]: { updated: "synthetic" } });
        const updated = applyPatch(json(base), generatePatchObj(json(base), target));
        expect(updated).toEqual(target);
        const deleted = applyPatch(json(updated), generatePatchObj(json(updated), {}));
        assertIntrinsicsUnchanged();
        assertDataPrototypes(updated);
        assertDataPrototypes(deleted);
        expect(deleted).toEqual({});
    });

    it.each(["__proto__", "constructor", "prototype"])("handles %s as an unordered array item ID", (id) => {
        const base = { items: [] };
        const target = { items: [{ id, nested: payload("__proto__") }] };
        const patch = generatePatchObj(json(base), json(target));
        let result: unknown;
        let error: unknown;
        try {
            result = applyPatch(json(base), patch);
        } catch (caught) {
            error = caught;
        }
        assertIntrinsicsUnchanged();
        expect(error).toBeUndefined();
        assertDataPrototypes(result);
        expect(result).toEqual(target);
    });

    it.each([
        [
            { retained: 1, deleted: 2 },
            { retained: 3, added: 4 },
        ],
        [{ value: null }, { value: payload("__proto__") }],
        [{ value: payload("__proto__") }, { value: null }],
        [{ items: [1, 2] }, { items: [3, 4] }],
        [
            {
                items: [
                    { id: "a", value: 1 },
                    { id: "b", value: 2 },
                ],
            },
            {
                items: [
                    { id: "b", value: 3 },
                    { id: "c", value: 4 },
                ],
            },
        ],
    ])("retains ordinary patch insert, replace, delete, and array behaviour %#", (base, target) => {
        const result = applyPatch(json(base), generatePatchObj(json(base), json(target)));
        assertIntrinsicsUnchanged();
        expect(result).toEqual(target);
    });
});
