const MARK_OPERATOR = `\u{0001}`;
const MARK_DELETED = `${MARK_OPERATOR}__DELETED`;
const MARK_ISARRAY = `${MARK_OPERATOR}__ARRAY`;
const MARK_SWAPPED = `${MARK_OPERATOR}__SWAP`;

interface ObjectWithID {
    id: string;
}
function unorderedArrayToObject<T extends ObjectWithID>(obj: Array<T>) {
    return obj.map((e) => ({ [e.id]: e })).reduce((p, c) => ({ ...p, ...c }), {});
}
function objectToUnorderedArray<T extends ObjectWithID>(obj: Record<string, T>) {
    const entries = Object.entries(obj);
    if (entries.some((e) => e[0] != e[1]?.id)) throw new Error("Item looks like not unordered array");
    return entries.map((e) => e[1]);
}
function generatePatchUnorderedArray<T extends ObjectWithID>(from: Array<T>, to: Array<T>) {
    if (from.every((e) => typeof e == "object" && "id" in e) && to.every((e) => typeof e == "object" && "id" in e)) {
        const fObj = unorderedArrayToObject(from);
        const tObj = unorderedArrayToObject(to);
        const diff = generatePatchObj(fObj, tObj);
        if (Object.keys(diff).length > 0) {
            return { [MARK_ISARRAY]: diff };
        } else {
            return {};
        }
    }
    return { [MARK_SWAPPED]: to };
}

export function generatePatchObj(
    from: Record<string | number | symbol, unknown>,
    to: Record<string | number | symbol, unknown>
) {
    const entries = Object.entries(from);
    const tempMap = new Map<string | number | symbol, unknown>(entries);
    const ret = {} as Record<string | number | symbol, unknown>;
    const newEntries = Object.entries(to);
    for (const [key, value] of newEntries) {
        if (!tempMap.has(key)) {
            //New
            ret[key] = value;
            tempMap.delete(key);
        } else {
            //Exists
            const v = tempMap.get(key);
            if (typeof v !== typeof value || Array.isArray(v) !== Array.isArray(value)) {
                //if type is not match, replace completely.
                ret[key] = { [MARK_SWAPPED]: value };
            } else {
                if (v === null && value === null) {
                    // NO OP.
                } else if (v === null && value !== null) {
                    ret[key] = { [MARK_SWAPPED]: value };
                } else if (v !== null && value === null) {
                    ret[key] = { [MARK_SWAPPED]: value };
                } else if (
                    typeof v == "object" &&
                    typeof value == "object" &&
                    !Array.isArray(v) &&
                    !Array.isArray(value)
                ) {
                    const wk = generatePatchObj(
                        v as Record<string | number | symbol, unknown>,
                        value as Record<string | number | symbol, unknown>
                    );
                    if (Object.keys(wk).length > 0) ret[key] = wk;
                } else if (
                    typeof v == "object" &&
                    typeof value == "object" &&
                    Array.isArray(v) &&
                    Array.isArray(value)
                ) {
                    const wk = generatePatchUnorderedArray(v, value);
                    if (Object.keys(wk).length > 0) ret[key] = wk;
                } else if (typeof v != "object" && typeof value != "object") {
                    if (JSON.stringify(tempMap.get(key)) !== JSON.stringify(value)) {
                        ret[key] = value;
                    }
                } else {
                    if (JSON.stringify(tempMap.get(key)) !== JSON.stringify(value)) {
                        ret[key] = { [MARK_SWAPPED]: value };
                    }
                }
            }
            tempMap.delete(key);
        }
    }
    //Not used item, means deleted one
    for (const [key] of tempMap) {
        ret[key] = MARK_DELETED;
    }
    return ret;
}

export function applyPatch(
    from: Record<string | number | symbol, unknown>,
    patch: Record<string | number | symbol, unknown>
) {
    const ret = from;
    const patches = Object.entries(patch);
    for (const [key, value] of patches) {
        if (value == MARK_DELETED) {
            delete ret[key];
            continue;
        }
        if (value === null) {
            ret[key] = null;
            continue;
        }
        if (typeof value == "object") {
            if (MARK_SWAPPED in value) {
                ret[key] = (value as Record<string, unknown>)[MARK_SWAPPED];
                continue;
            }
            if (MARK_ISARRAY in value) {
                if (!(key in ret)) ret[key] = [];
                if (!Array.isArray(ret[key])) {
                    throw new Error("Patch target type is mismatched (array to something)");
                }
                const orgArrayObject = unorderedArrayToObject(ret[key] as Array<ObjectWithID>);
                const appliedObject = applyPatch(
                    orgArrayObject,
                    (value as Record<string, unknown>)[MARK_ISARRAY] as Record<string | number | symbol, unknown>
                );
                const appliedArray = objectToUnorderedArray(appliedObject as Record<string, ObjectWithID>);
                ret[key] = [...appliedArray];
            } else {
                if (!(key in ret)) {
                    ret[key] = value;
                    continue;
                }
                ret[key] = applyPatch(
                    ret[key] as Record<string | number | symbol, unknown>,
                    value as Record<string | number | symbol, unknown>
                );
            }
        } else {
            ret[key] = value;
        }
    }
    return ret;
}

export function mergeObject(
    objA: Record<string | number | symbol, unknown> | [unknown],
    objB: Record<string | number | symbol, unknown> | [unknown]
) {
    const newEntries = Object.entries(objB);
    const ret: Record<string | number | symbol, unknown> = { ...(objA as object) };
    if (typeof objA !== typeof objB || Array.isArray(objA) !== Array.isArray(objB)) {
        return objB;
    }

    for (const [key, v] of newEntries) {
        if (key in ret) {
            const value = ret[key];
            if (typeof v !== typeof value || Array.isArray(v) !== Array.isArray(value)) {
                //if type is not match, replace completely.
                ret[key] = v;
            } else {
                if (typeof v == "object" && typeof value == "object" && !Array.isArray(v) && !Array.isArray(value)) {
                    // TODO: Null handling
                    ret[key] = mergeObject(
                        v as Record<string | number | symbol, unknown>,
                        value as Record<string | number | symbol, unknown>
                    );
                } else if (
                    typeof v == "object" &&
                    typeof value == "object" &&
                    Array.isArray(v) &&
                    Array.isArray(value)
                ) {
                    ret[key] = [...new Set([...(v as Array<unknown>), ...(value as Array<unknown>)])];
                } else {
                    ret[key] = v;
                }
            }
        } else {
            ret[key] = v;
        }
    }
    const retSorted = Object.fromEntries(Object.entries(ret).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    if (Array.isArray(objA) && Array.isArray(objB)) {
        return Object.values(retSorted);
    }
    return retSorted;
}

export function flattenObject(
    obj: Record<string | number | symbol, unknown>,
    path: string[] = []
): [string, unknown][] {
    if (typeof obj != "object") return [[path.join("."), obj]];
    if (obj === null) return [[path.join("."), null]];
    if (Array.isArray(obj)) return [[path.join("."), JSON.stringify(obj)]];
    const e = Object.entries(obj);
    const ret = [];
    for (const [key, value] of e) {
        const p = flattenObject(value as Record<string | number | symbol, unknown>, [...path, key]);
        ret.push(...p);
    }
    return ret;
}

export function isSensibleMargeApplicable(path: string) {
    if (path.endsWith(".md")) return true;
    return false;
}
export function isObjectMargeApplicable(path: string) {
    if (path.endsWith(".canvas")) return true;
    if (path.endsWith(".json")) return true;
    return false;
}
