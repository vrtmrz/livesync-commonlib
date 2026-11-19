/**
 * Correlate a legacy override with a base method it calls before yielding.
 * The base method can record its result after an asynchronous operation.
 */
export class SuperCallCapture<T> {
    private readonly recorders = new WeakMap<object, (value: T) => void>();

    invoke<R>(owner: object, override: () => R): { result: R; delegated: { value?: T } } {
        const previous = this.recorders.get(owner);
        const delegated: { value?: T } = {};
        this.recorders.set(owner, (value) => {
            delegated.value = value;
        });
        try {
            const result = override();
            return { result, delegated };
        } finally {
            if (previous) {
                this.recorders.set(owner, previous);
            } else {
                this.recorders.delete(owner);
            }
        }
    }

    takeRecorder(owner: object): ((value: T) => void) | undefined {
        const record = this.recorders.get(owner);
        this.recorders.delete(owner);
        return record;
    }
}
