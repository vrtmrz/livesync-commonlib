
declare global {
    interface LSEvents {
        "hello": string;
        "world": undefined;
    }

}

export class EventHub {
    _emitter = new EventTarget();


    emitEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never
    ): void;
    emitEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never,
        data: ET[K]
    ): void;
    emitEvent<ET extends LSEvents, K extends keyof ET>(
        event: K,
        data?: ET[K] extends undefined ? undefined : ET[K]
    ): void {
        this._emitter.dispatchEvent(new CustomEvent(`${event.toString()}`, { detail: data ?? undefined }));
    }

    on<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never,
        callback: (e: Event) => void | Promise<void>
    ): () => void;
    on<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never,
        callback: (e: Event, data: ET[K]) => void | Promise<void>
    ): () => void;
    on<ET extends LSEvents, K extends keyof ET>(
        event: K,
        callback: (e: Event, data?: ET[K]) => void | Promise<void>
    ): () => void {
        const onEvent = (e: Event) => void callback(e, e instanceof CustomEvent ? e.detail as ET[K] : undefined!);
        const key = `${event.toString()}`;
        this._emitter.addEventListener(key, onEvent);
        return () => this._emitter.removeEventListener(key, onEvent);
    }

    onEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never,
        callback: () => any
    ): () => void;
    onEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never,
        callback: (data: ET[K]) => any
    ): () => void;
    onEvent<ET extends LSEvents, K extends keyof ET>(
        event: K,
        callback: (data?: ET[K]) => any
    ): () => void {
        return this.on(event as any, (_: any, data: any) => {
            callback(data);
        });
    }

    once<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never,
        callback: (e: Event) => void
    ): void;
    once<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never,
        callback: (e: Event, data: ET[K]) => void
    ): void;
    once<ET extends LSEvents, K extends keyof ET>(
        event: K,
        callback: (e: Event, data?: ET[K]) => void
    ): void {
        const off = this.on<ET, K>(event as any, (e: Event, data: any) => {
            off();
            callback(e, data);
        });
    }
    onceEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never,
        callback: () => void
    ): void;
    onceEvent<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never,
        callback: (data: ET[K]) => void
    ): void;
    onceEvent<ET extends LSEvents, K extends keyof ET>(
        event: K,
        callback: (data?: ET[K]) => void
    ): void {
        this.once<ET, K>(event as any, callback as any);
    }

    waitFor<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? K : never) : never
    ): Promise<void>;
    waitFor<ET extends LSEvents, K extends keyof ET>(
        event: K extends keyof ET ? (ET[K] extends undefined ? never : K) : never
    ): Promise<ET[K]>;
    waitFor<ET extends LSEvents, K extends keyof ET>(
        event: K
    ): Promise<ET[K] extends undefined ? void : ET[K]> {
        return new Promise<ET[K] extends undefined ? void : ET[K]>(resolve => {
            const off = this.on<ET, K>(event as any, (e: Event, data?: any) => {
                off();
                resolve(data);
            });
        });
    }
}

export const eventHub = new EventHub();