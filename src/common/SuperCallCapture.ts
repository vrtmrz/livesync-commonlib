/**
 * Correlate a legacy override with a base method it calls before settling.
 * The base method can record its result after an asynchronous operation.
 */
export class SuperCallCapture<T> {
    private readonly recorders = new WeakMap<object, (value: T) => void>();

    async invoke<Owner extends object, R>(
        owner: Owner,
        override: (receiver: Owner) => Promise<R>
    ): Promise<{ result: R; delegated: { value?: T } }> {
        // Give each invocation its own receiver while forwarding reads and writes to the owner.
        const receiver = new Proxy(owner, {});
        const delegated: { value?: T } = {};
        this.recorders.set(receiver, (value) => {
            delegated.value = value;
        });
        try {
            const result = await override(receiver);
            return { result, delegated };
        } finally {
            this.recorders.delete(receiver);
        }
    }

    takeRecorder(receiver: object): ((value: T) => void) | undefined {
        const record = this.recorders.get(receiver);
        this.recorders.delete(receiver);
        return record;
    }
}
