/** An unclaimed value; its identity distinguishes replacements for the same key. */
export interface PendingWork<K, T> {
    readonly key: K;
    readonly value: T;
}

/** Keep only the latest unclaimed value for each key, in replacement order. */
export function createKeyedPendingWork<K, T>(keyOf: (value: T) => K) {
    const pending = new Map<K, PendingWork<K, T>>();
    return {
        add(value: T): void {
            const key = keyOf(value);
            pending.delete(key);
            pending.set(key, { key, value });
        },
        peek(): PendingWork<K, T> | undefined {
            return pending.values().next().value;
        },
        claim(entry: PendingWork<K, T>): boolean {
            if (pending.get(entry.key) !== entry) return false;
            pending.delete(entry.key);
            return true;
        },
        values(): readonly T[] {
            return Array.from(pending.values(), (entry) => entry.value);
        },
        get size(): number {
            return pending.size;
        },
    };
}
