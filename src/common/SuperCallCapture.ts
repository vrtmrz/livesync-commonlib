type Recorder<T> = (value: T) => void;
type RecorderFrame<T> = { owner: object; name?: string; recorder?: Recorder<T> };

let nextCaptureId = 0;

function methodOwner(owner: object, method: PropertyKey): object | null {
    let current: object | null = owner;
    while (current && !Object.hasOwn(current, method)) {
        current = Reflect.getPrototypeOf(current);
    }
    return current;
}

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
    private readonly context = createAsyncContext<RecorderFrame<T>>();
    private readonly originals = new WeakMap<object, object>();
    private readonly prefix = `__liveSyncSuperCall_${++nextCaptureId}_`;
    private readonly stackFrame = new RegExp(`^ *at (?:async )?(?:Object\\.)?(${this.prefix}\\d+__) \\(`, "m");
    private readonly frames = new Map<string, RecorderFrame<T>>();
    private nextFrameId = 0;
    private synchronousFrame?: RecorderFrame<T>;

    constructor(private readonly method: PropertyKey) {}

    private instrumentReceiver<Args extends unknown[], R>(
        owner: object,
        original: (...args: Args) => Promise<R>
    ): boolean {
        const method = this.method;
        const definingObject = methodOwner(owner, method);
        const descriptor = definingObject && Object.getOwnPropertyDescriptor(definingObject, method);
        if (!descriptor || descriptor.value !== original) {
            return false;
        }

        const capture = this;
        function wrapped(this: object, ...args: Args): Promise<R> {
            const call = () => Reflect.apply(original, this, args);
            // An ancestor reached via super belongs to the current invocation.
            if (Reflect.get(this, method) !== wrapped) {
                const frame = capture.currentFrame();
                return frame?.owner === this && frame.name ? capture.runFrame(frame.name, frame, call) : call();
            }
            return capture.runFrame(`${capture.prefix}0__`, { owner: this }, call);
        }
        if (!Reflect.defineProperty(definingObject, method, { ...descriptor, value: wrapped })) {
            if (definingObject === owner || !Reflect.defineProperty(owner, method, { ...descriptor, value: wrapped })) {
                return false;
            }
        }
        this.originals.set(wrapped, original);
        return true;
    }

    async invoke<Args extends unknown[], R>(
        owner: object,
        override: (...args: Args) => Promise<R>,
        ...args: NoInfer<Args>
    ): Promise<{ result: R; delegated: { value?: T } }> {
        const delegated: { value?: T } = {};
        const frame: RecorderFrame<T> = {
            owner,
            recorder: (value) => {
                delegated.value = value;
            },
        };
        if (this.context) {
            const result = await this.context.run(frame, async () => {
                try {
                    return await Reflect.apply(override, owner, args);
                } finally {
                    frame.recorder = undefined;
                }
            });
            return { result, delegated };
        }

        const original = this.originals.get(override) as typeof override | undefined;
        const call = () => Reflect.apply(original ?? override, owner, args);
        const name = `${this.prefix}${++this.nextFrameId}__`;
        frame.name = name;
        // Install the direct-call boundary after subclass fields have been initialised.
        if (original || this.instrumentReceiver(owner, override)) {
            this.frames.set(name, frame);
        }
        try {
            const result = await this.runFrame(name, frame, call);
            return { result, delegated };
        } finally {
            this.frames.delete(name);
        }
    }

    private runFrame<R>(name: string, frame: RecorderFrame<T>, call: () => Promise<R>): Promise<R> {
        const capture = this;
        // V8 includes named async awaiters in Error.stack. A direct call uses an
        // unregistered name so it shields a re-entrant call from its typed caller.
        return {
            async [name]() {
                return await capture.callSynchronously(frame, call);
            },
        }[name]();
    }

    private callSynchronously<R>(frame: RecorderFrame<T>, call: () => Promise<R>): Promise<R> {
        const previous = this.synchronousFrame;
        this.synchronousFrame = frame;
        try {
            return call();
        } finally {
            this.synchronousFrame = previous;
        }
    }

    private currentFrame(): RecorderFrame<T> | undefined {
        if (this.context) {
            return this.context.getStore();
        }
        if (this.synchronousFrame) {
            return this.synchronousFrame;
        }
        if (this.frames.size === 0) {
            return;
        }
        // Error.stack can be unavailable, truncated, or host-formatted.
        try {
            const stack = new Error().stack;
            const name = typeof stack === "string" ? this.stackFrame.exec(stack)?.[1] : undefined;
            return name ? this.frames.get(name) : undefined;
        } catch {
            // A host stack formatter can throw. Keep the legacy result.
        }
    }

    takeRecorder(receiver: object): Recorder<T> | undefined {
        const frame = this.currentFrame();
        if (frame?.owner !== receiver) {
            return;
        }
        const recorder = frame.recorder;
        frame.recorder = undefined;
        return recorder;
    }
}
