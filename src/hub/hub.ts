
export class EventHub extends EventTarget {

    constructor() {
        super();
    }

    on<T>(event: string, listener: (evt: CustomEvent<T>) => void, options?: boolean | AddEventListenerOptions) {
        const func = (evt: Event) => listener(evt as CustomEvent<T>);
        this.addEventListener(event, func, options);
        return () => {
            this.off(event, func);
        }
    }

    once<T>(event: string, listener: (evt: CustomEvent<T>) => void, options?: boolean | AddEventListenerOptions) {
        const off = this.on(event, (evt: CustomEvent<T>) => {
            off();
            listener(evt);
        }, options);
    }

    off(event: string, listener: EventListenerOrEventListenerObject) {
        this.removeEventListener(event, listener);
    }

    emit<T extends any[]>(event: string, ...args: T) {
        this.dispatchEvent(new CustomEvent(event, { detail: args.length > 1 ? args : args[0] }));
    }
}

export const eventHub = new EventHub();