// Reactive and less-computing expression evaluator
// Inspired from Vue

let context: ReactiveInstance<any> | undefined;
export type ReactiveChangeHandler<T> = (instance: ReactiveInstance<T>) => unknown;

export type ReactiveValue<T> = {
    readonly value: T;
    onChanged: (handler: ReactiveChangeHandler<T>) => void;
    offChanged: (handler: ReactiveChangeHandler<T>) => void;
}
export type ReactiveSource<T> = {
    value: T;
    onChanged: (handler: ReactiveChangeHandler<T>) => void;
    offChanged: (handler: ReactiveChangeHandler<T>) => void;
}

export type ReactiveInstance<T> = {
    readonly value: T;
    markDirty(): void;
}

export function reactiveSource<T>(initialValue: T): ReactiveSource<T> {
    return _reactive({ initialValue });
}
export function reactive<T>(expression: (prev?: T) => T, initialValue?: T): ReactiveValue<T> {
    return _reactive({ expression, initialValue });
}
type reactiveParams<T> = {
    expression: (prev?: T) => T,
    initialValue?: T
} | {
    expression?: (prev?: T) => T,
    initialValue: T
}

function isObjectChanged(a: any, b: any): boolean {
    if (typeof a !== typeof b) {
        return true;
    }
    if (typeof a === "object") {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        return keys.map(key => isObjectChanged(a?.[key], b?.[key])).some(e => e == true);
    } else {
        return a !== b;
    }
}
function _reactive<T>({ expression, initialValue }: reactiveParams<T>): ReactiveValue<T> {
    let value: T;
    let _isDirty = false;

    const callbacks = new Set<((value: ReactiveInstance<T>) => unknown)>;
    const instance = {
        depends: new Set<ReactiveInstance<unknown>>(),

        evalCount: 0,
        readCount: 0,
        markDirty() {
            _isDirty = true;
            instance.markDependedDirty();
            callbacks.forEach(e => e(instance));
        },
        markClean() {
            _isDirty = false;
        },
        markDependedDirty() {
            instance.depends.forEach(e => e.markDirty())
        },
        get value(): T {
            if (context) {
                instance.depends.add(context);
            }
            if (!expression) {
                return value;
            }
            if (_isDirty) {
                const oldValue = value;
                const newValue = expression();
                if (isObjectChanged(oldValue, newValue)) {
                    value = newValue;
                    instance.markClean();
                    instance.markDependedDirty();
                }
            }
            return value;
        },
        set value(newValue: T) {
            if (isObjectChanged(value, newValue)) {
                value = newValue;
                instance.markDirty();
            }
        },
        onChanged(handler: ReactiveChangeHandler<T>) {
            callbacks.add(handler);
        },
        offChanged(handler: ReactiveChangeHandler<T>) {
            callbacks.delete(handler);
        }
    }

    value = initialize();

    function initialize(): T {
        // Set self to the global variable for tracking the dependency while evaluating the expression
        const previousContext = context;
        context = instance;
        const r = expression ? expression(initialValue) : initialValue;
        context = previousContext;
        return r;
    }

    return instance;
}
