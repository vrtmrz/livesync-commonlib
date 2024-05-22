
type Observer<T> = (value: T) => void | Promise<void>;
type Interceptor<T> = (value: T) => T;
type StreamSubscriber<T> = (value: T) => void | Promise<void>;

abstract class ReadOnlyObservableStore<T> {
    abstract peek(): T | undefined;
    abstract observe(observer: Observer<T>): () => void;
    abstract unobserve(observer: Observer<T>): void;
}
export class ObservableStore<T> extends ReadOnlyObservableStore<T> {

    protected value: T;
    private observers: Observer<T>[] = [];
    private interceptors: Interceptor<T>[] = [];
    constructor(value: T) {
        super();
        this.value = value;
    }
    set(value: T) {
        if (this.value != value) {
            let v = value;
            if (this.interceptors.length > 0) {
                for (const f of this.interceptors) {
                    v = f(v);
                }
            }
            this.value = v;
            this.invalidate();
        }
    }
    apply(func: (value: T) => T) {
        this.value = func(this.value);
        this.invalidate();
    }
    peek(): T | undefined {
        return this.value;
    }
    invalidate() {
        const value = this.value;
        if (value === undefined) return;
        const watchers = this.observers;
        for (const f of watchers) {
            f(value);
        }
    }
    intercept(interceptor: Interceptor<T>) {
        this.interceptors.push(interceptor);
        return () => this.removeInterceptor(interceptor);
    }
    removeInterceptor(interceptor: Interceptor<T>) {
        this.interceptors = this.interceptors.filter(e => e != interceptor);
    }
    observe(observer: Observer<T>) {
        this.observers.push(observer);
        return () => this.unobserve(observer);
    }
    unobserve(observer: Observer<T>) {
        this.observers = this.observers.filter(e => e != observer);
    }
}
export class StreamStore<T> extends ObservableStore<T[]> {
    private itemInterceptors: Interceptor<T>[] = [];
    private subscribers: StreamSubscriber<T>[] = [];

    constructor(init: T[] | undefined) {
        super(init ?? []);
    }
    push(value: T) {
        let v = value;
        for (const f of this.itemInterceptors) {
            v = f(v);
        }
        for (const f of this.subscribers) {
            f(v);
        }
        this.set([...this.value ?? [], v]);

    }
    pop(): T | undefined {
        const v = [...this.value ?? []];
        const val = v.pop();
        this.set(v);
        return val;
    }
    unshift(value: T) {
        let v = value;
        for (const f of this.itemInterceptors) {
            v = f(v);
        }
        for (const f of this.subscribers) {
            f(v);
        }
        this.set([v, ...this.value ?? []]);
    }
    shift(): T {
        const [val, ...rest] = [...this.value ?? []];
        this.set(rest);
        return val;
    }
    subscribe(subscriber: StreamSubscriber<T>) {
        this.subscribers.push(subscriber);
        return () => this.unsubscribe(subscriber);
    }
    unsubscribe(subscriber: StreamSubscriber<T>) {
        this.subscribers = this.subscribers.filter(e => e != subscriber);
    }

    interceptEach(interceptor: Interceptor<T>) {
        this.itemInterceptors.push(interceptor);
        return () => this.removeEachInterceptor(interceptor);
    }
    removeEachInterceptor(interceptor: Interceptor<T>) {
        this.itemInterceptors = this.itemInterceptors.filter(e => e != interceptor);
    }


}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalStore = new Map<string, ObservableStore<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalStream = new Map<string, StreamStore<any>>();
export function getGlobalStore<T>(name: string, init?: T): ObservableStore<T> {
    if (!globalStore.has(name)) {
        globalStore.set(name, new ObservableStore(init));
    }
    return globalStore.get(name) as ObservableStore<T>;
}
export function swapGlobalStore<T>(name: string, store: ObservableStore<T>): ObservableStore<T> {
    globalStore.set(name, store);
    return globalStore.get(name) as ObservableStore<T>;
}
export function getGlobalStreamStore<T>(name: string, init?: T[]): StreamStore<T> {
    if (!globalStream.has(name)) {
        globalStream.set(name, new StreamStore(init));
    }
    return globalStream.get(name) as StreamStore<T>;
}
export function swapGlobalStreamStore<T>(name: string, store: StreamStore<T>): StreamStore<T> {
    globalStream.set(name, store);
    return globalStream.get(name) as StreamStore<T>;
}
export function useGlobalStore<T>(name: string, onInit: (value: T) => T, init?: T) {
    if (!globalStore.has(name)) {
        globalStore.set(name, new ObservableStore(init));
    }
    globalStore.get(name)!.apply(onInit);
    return globalStore.get(name) as ObservableStore<T>;
}
export function observeStores<T, U>(storeA: ReadOnlyObservableStore<T>, storeB: ReadOnlyObservableStore<U>): ReadOnlyObservableStore<T & U> {
    const value = { ...storeA.peek(), ...storeB.peek() } as (T & U);
    const store = new ObservableStore(value);
    storeA.observe(value => store.apply(e => ({ ...e, ...value })));
    storeB.observe(value => store.apply(e => ({ ...e, ...value })));
    return store
}