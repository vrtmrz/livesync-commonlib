/**
 * Correlate a legacy override with a base method it calls before settling.
 * The base method can record its result after an asynchronous operation.
 */
export class SuperCallCapture<T> {
    private readonly recorders = new WeakMap<object, ((value: T) => void)[]>();

    async invoke<R>(owner: object, override: () => Promise<R>): Promise<{ result: R; delegated: { value?: T } }> {
        const recorders = this.recorders.get(owner) ?? [];
        const delegated: { value?: T } = {};
        const record = (value: T) => {
            delegated.value = value;
        };
        recorders.push(record);
        this.recorders.set(owner, recorders);
        try {
            const result = await override();
            return { result, delegated };
        } finally {
            const index = recorders.indexOf(record);
            if (index !== -1) {
                recorders.splice(index, 1);
                if (recorders.length === 0) {
                    this.recorders.delete(owner);
                }
            }
        }
    }

    takeRecorder(owner: object): ((value: T) => void) | undefined {
        const recorders = this.recorders.get(owner);
        const record = recorders?.pop();
        if (recorders?.length === 0) {
            this.recorders.delete(owner);
        }
        return record;
    }
}
