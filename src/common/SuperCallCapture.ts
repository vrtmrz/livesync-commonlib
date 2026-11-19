import { promiseWithResolvers } from "octagonal-wheels/promises";

type AsyncMethod = (...args: never[]) => Promise<unknown>;
type Recorder<T> = (value: T) => void;
type RecorderFrame<T> = { recorder: Recorder<T> | null; executing: boolean };

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
 * Use one capture per legacy method.
 */
export class SuperCallCapture<T> {
    private readonly context = createAsyncContext<WeakMap<object, Recorder<T>>>();
    private readonly originals = new WeakMap<object, object>();
    private readonly frames = new WeakMap<object, RecorderFrame<T>[]>();
    private readonly pending = new WeakMap<object, Promise<void>>();

    instrumentReceiver<Key extends PropertyKey>(
        owner: Record<Key, AsyncMethod>,
        method: Key,
        baseMethod: AsyncMethod
    ): void {
        if (this.context) {
            return;
        }
        const original = owner[method];
        if (original === baseMethod || this.originals.has(original)) {
            return;
        }

        let definingObject: object | null = owner;
        while (definingObject && !Object.hasOwn(definingObject, method)) {
            definingObject = Reflect.getPrototypeOf(definingObject);
        }
        const descriptor = definingObject && Object.getOwnPropertyDescriptor(definingObject, method);
        if (!descriptor || descriptor.value !== original) {
            return;
        }

        const capture = this;
        function wrapped(this: typeof owner, ...args: unknown[]): Promise<unknown> {
            const call = () => Reflect.apply(original, this, args);
            // An instrumented ancestor reached through super shares the current invocation.
            if (this[method] !== wrapped) {
                return call();
            }
            // Only calls on the synchronous stack can be identified as re-entrant.
            if (capture.frames.get(this)?.some((frame) => frame.executing)) {
                return capture.runFrame(this, null, call);
            }
            return capture.enqueue(this, null, call);
        }
        if (Reflect.defineProperty(definingObject, method, { ...descriptor, value: wrapped })) {
            this.originals.set(wrapped, original);
        } else if (
            definingObject !== owner &&
            Reflect.defineProperty(owner, method, { configurable: true, writable: true, value: wrapped })
        ) {
            this.originals.set(wrapped, original);
        }
    }

    async invoke<Args extends unknown[], R>(
        owner: object,
        override: (...args: Args) => Promise<R>,
        ...args: NoInfer<Args>
    ): Promise<{ result: R; delegated: { value?: T } }> {
        const delegated: { value?: T } = {};
        const recorder: Recorder<T> = (value) => {
            delegated.value = value;
        };
        if (this.context) {
            const recorders = new WeakMap([[owner, recorder]]);
            const result = await this.context.run(recorders, async () => {
                try {
                    return await Reflect.apply(override, owner, args);
                } finally {
                    recorders.delete(owner);
                }
            });
            return { result, delegated };
        }

        // The typed entry already owns the queue turn. Apply the original method with its receiver and home object.
        const original = (this.originals.get(override) as typeof override | undefined) ?? override;
        const result = await this.enqueue(owner, recorder, () => Reflect.apply(original, owner, args));
        return { result, delegated };
    }

    private async enqueue<R>(owner: object, recorder: Recorder<T> | null, call: () => Promise<R>): Promise<R> {
        const previous = this.pending.get(owner);
        const turn = promiseWithResolvers<void>();
        this.pending.set(owner, turn.promise);
        try {
            if (previous) {
                await previous;
            }
            return await this.runFrame(owner, recorder, call);
        } finally {
            if (this.pending.get(owner) === turn.promise) {
                this.pending.delete(owner);
            }
            turn.resolve();
        }
    }

    private async runFrame<R>(owner: object, recorder: Recorder<T> | null, call: () => Promise<R>): Promise<R> {
        const frames = this.frames.get(owner) ?? [];
        const frame = { recorder, executing: true };
        frames.push(frame);
        this.frames.set(owner, frames);
        try {
            let result: Promise<R>;
            try {
                result = call();
            } finally {
                frame.executing = false;
            }
            return await result;
        } finally {
            frames.splice(frames.indexOf(frame), 1);
            if (frames.length === 0) {
                this.frames.delete(owner);
            }
        }
    }

    takeRecorder(receiver: object): Recorder<T> | undefined {
        if (this.context) {
            const recorders = this.context.getStore();
            const recorder = recorders?.get(receiver);
            recorders?.delete(receiver);
            return recorder;
        }
        const frame = this.frames.get(receiver)?.at(-1);
        const recorder = frame?.recorder;
        if (frame) {
            frame.recorder = null;
        }
        return recorder ?? undefined;
    }
}
