type Recorder<T> = (value: T) => void;

interface AsyncContext<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
}

function createAsyncContext<T>(): AsyncContext<T> | undefined {
    type AsyncHooks = { AsyncLocalStorage?: new () => AsyncContext<T> };
    const runtime = globalThis as typeof globalThis & {
        require?: (id: string) => AsyncHooks | undefined;
    };

    try {
        // Resolve this at runtime so browser bundles have no Node module dependency.
        const hooks = (runtime.process?.getBuiltinModule?.("node:async_hooks") ??
            runtime.require?.("node:async_hooks")) as AsyncHooks | undefined;
        if (hooks?.AsyncLocalStorage) {
            return new hooks.AsyncLocalStorage();
        }
    } catch {
        // A sandboxed host can expose a loader that rejects Node built-ins.
    }
}

/**
 * Correlate a legacy override with a base method it calls before settling.
 * The base method can record its result after an asynchronous operation.
 */
export class SuperCallCapture<T> {
    private readonly context = createAsyncContext<WeakMap<object, Recorder<T>>>();
    private readonly fallbackRecorders = new WeakMap<object, Recorder<T>>();
    private readonly pending = new WeakMap<object, Promise<unknown>>();

    async invoke<Owner extends object, R>(
        owner: Owner,
        override: (receiver: Owner) => Promise<R>
    ): Promise<{ result: R; delegated: { value?: T } }> {
        const delegated: { value?: T } = {};
        const run = async (recorders: WeakMap<object, Recorder<T>>) => {
            recorders.set(owner, (value) => {
                delegated.value = value;
            });
            try {
                const result = await override(owner);
                return { result, delegated };
            } finally {
                recorders.delete(owner);
            }
        };

        if (this.context) {
            const recorders = new WeakMap<object, Recorder<T>>();
            return this.context.run(recorders, () => run(recorders));
        }

        // Without async context, a receiver can only have one active capture at a time.
        const previous = this.pending.get(owner) ?? Promise.resolve();
        const next = () => run(this.fallbackRecorders);
        const pending = previous.then(next, next);
        this.pending.set(owner, pending);
        try {
            return await pending;
        } finally {
            if (this.pending.get(owner) === pending) {
                this.pending.delete(owner);
            }
        }
    }

    takeRecorder(receiver: object): Recorder<T> | undefined {
        const recorders = this.context ? this.context.getStore() : this.fallbackRecorders;
        const record = recorders?.get(receiver);
        recorders?.delete(receiver);
        return record;
    }
}
