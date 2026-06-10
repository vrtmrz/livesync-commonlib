import { LRUCache } from "octagonal-wheels/memory/LRUCache";

export function tryParseJSON<T extends object>(str: string, fallbackValue?: T): T | undefined {
    try {
        return JSON.parse(str) as T;
    } catch {
        return fallbackValue;
    }
}

export function parseHeaderValues(strHeader: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const lines = strHeader.split("\n");
    for (const line of lines) {
        const [key, value] = line.split(":", 2).map((e) => e.trim());
        if (key && value) {
            headers[key] = value;
        }
    }
    return headers;
}

export function memorizeFuncWithLRUCache<T, U>(func: (key: T) => U) {
    const cache = new LRUCache<T, U>(100, 100000, true);
    return (key: T) => {
        const isExists = cache.has(key);
        if (isExists) return cache.get(key);
        const value = func(key);
        cache.set(key, value);
        return value;
    };
}

/**
 *
 * @param exclusion return only not exclusion
 * @returns
 *
 * ["something",false,"aaaaa"].filter(onlyNot(false)) => yields ["something","aaaaaa"]. but, as string[].
 */
export function onlyNot<A, B>(exclusion: B) {
    function _onlyNot(item: A | B): item is Exclude<A, B> {
        if (item === exclusion) return false;
        return true;
    }
    return _onlyNot;
}

const previousValues = new Map<string, unknown>();
export function isDirty(key: string, value: unknown) {
    const prev = previousValues.get(key);
    if (prev === value) return false;
    previousValues.set(key, value);
    return true;
}

export function setAllItems<T>(set: Set<T>, items: T[]) {
    items.forEach((e) => set.add(e));
    return set;
}
