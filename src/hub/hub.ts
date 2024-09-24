export type EventMessage<T extends string, U = any> = {
    type: T;
    data: U;
}

export type ExtendEventMessage<TBase extends EventMessage<any>, U> = TBase & { data: U }


export class EventHub extends EventTarget {

    constructor() {
        super();
    }
    listeners = new Map<string, Set<EventListener>>();

    _addEventListener(event: string, callback: EventListener, options?: boolean | AddEventListenerOptions) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(callback);
        return this.addEventListener(event, callback, options);
    }
    _removeEventListener(event: string, callback: EventListener) {
        this.listeners.get(event)?.delete(callback);
        return this.removeEventListener(event, callback);
    }
    on<T>(event: string, callback: (item: T) => void | Promise<void>) {
        const handler: EventListener = (evt: Event) => {
            callback((evt as CustomEvent<T>).detail);
        }
        this._addEventListener(event, handler);
        return () => {
            this._removeEventListener(event, handler);
        }
    }
    once<T>(event: string, callback: (item: T) => void | Promise<void>) {
        const handler: EventListener = (evt: Event) => {
            callback((evt as CustomEvent<T>).detail);
            this._removeEventListener(event, handler);
        }
        this._addEventListener(event, handler, { once: true });
        return () => {
            // Never cares about the off
            this._removeEventListener(event, handler);
        }
    }
    off(event: string) {
        this.listeners.get(event)?.forEach((callback) => {
            this._removeEventListener(event, callback);
        });
    }

    onEvent<T>(event: string, listener: (evt: CustomEvent<T>) => void, options?: boolean | AddEventListenerOptions) {
        const func = (evt: Event) => listener(evt as CustomEvent<T>);
        this._addEventListener(event, func, options);
        return () => {
            this.offEvent(event, func);
        }
    }

    onceEvent<T>(event: string, listener: (evt: CustomEvent<T>) => void, options?: boolean | AddEventListenerOptions) {
        const off = this.onEvent(event, (evt: CustomEvent<T>) => {
            off();
            listener(evt);
        }, options);
    }

    offEvent(event: string, listener: EventListener) {
        this._removeEventListener(event, listener);
    }

    emitEvent<T extends any[]>(event: string, ...args: T) {
        this.dispatchEvent(new CustomEvent(event, { detail: args.length > 1 ? args : args[0] }));
    }
    eventOf<TMsg extends EventMessage<T, U>, T extends string = TMsg["type"], U = TMsg["data"]>(type: T) {
        return {
            on: (callback: (item: TMsg) => void | Promise<void>) => {
                this.on(type, callback);
            },
            once: (callback: (item: TMsg) => void | Promise<void>) => {
                this.once(type, callback);
            },
            off: () => {
                this.off(type);
            },
            emit: (data: TMsg["data"]) => {
                this.emitEvent(type, data);
            }
        }
    }
}

export const eventHub = new EventHub();