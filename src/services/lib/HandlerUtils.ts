import { promiseWithResolvers } from "octagonal-wheels/promises";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger";

/**
 * A function type that can be used as a handler.
 */
type HandlerFunc<TArg extends any[], TResult> = (...args: TArg) => TResult | Promise<TResult>;

/**
 * A function type that returns a boolean or a Promise of boolean.
 */
type BooleanHandlerFunc<TArg extends any[], U = boolean> = (...args: TArg) => U | Promise<U>;

/**
 * An interface for invokable handlers that can add and remove handler functions.
 */
export interface InvokableHandler<T extends any[], U> {
    /**
     * Invokes the handler with the provided arguments.
     * @param args The arguments to pass to the handler.
     * @returns A Promise that resolves to the result of the handler.
     */
    invoke(...args: T): Promise<U>;
}
/**
 * An interface for invokable boolean handlers that can add and remove handler functions.
 */
type InvokableBooleanHandler<T extends any[]> = InvokableHandler<T, boolean>;
/**
 * A function type that can be used to unregister a handler.
 */
export type UnregisterFunction = () => void;

/**
 * An interface for binder handlers that can assign a single handler function.
 */
export interface BinderHandler<T extends any[], U> {
    assign(callback: HandlerFunc<T, U>, override?: boolean): UnregisterFunction;
}
/**
 * An interface for multi-binder handlers that can add and remove handler functions.
 */
export interface MultiRegisterHandler<T extends any[], U> {
    /**
     * Adds a handler function.
     * Note: The same function only added once.
     * If you want to prevent duplication, please remove the existing handler before adding it again.
     * @param callback The handler function to add.
     * @returns A function to remove the added handler.
     */
    addHandler(callback: BooleanHandlerFunc<T, U>): UnregisterFunction;
    /**
     * Removes a handler function.
     * @param callback The handler function to remove.
     */
    removeHandler(callback: BooleanHandlerFunc<T, U>): void;
    use(callback: BooleanHandlerFunc<T, U>): UnregisterFunction;
}

/**
 * An interface for dispatch handlers that can dispatch events to multiple handlers.
 */
export interface DispatcherHandler<T extends any[], U> {
    dispatch(...args: T): Promise<(Awaited<U> | Error)[]>;
}
/**
 * An interface for dispatch handlers that can add and remove handler functions.
 */
export interface DispatchHandler<T extends any[], U> extends DispatcherHandler<T, U>, MultiRegisterHandler<T, U> {}
/**
 * A binder that allows assigning and invoking a single handler function.
 */
export class Binder<T extends HandlerFunc<any, any>>
    implements BinderHandler<Parameters<T>, ReturnType<T>>, InvokableHandler<Parameters<T>, ReturnType<T>>
{
    private _name: string;
    /**
     * Creates a new Binder instance.
     * @param name  The name of the handler.
     * @param initialCallback An optional initial callback function to assign.
     */
    constructor(name: string, initialCallback?: T) {
        this._name = name;
        if (initialCallback) {
            this._callback = initialCallback;
        }
    }
    private _callback: T | null = null;

    /**
     * Assigns a new handler function.
     * @param callback The new handler function to assign.
     */
    assign(callback: T, override: boolean = false) {
        if (this._callback && !override) {
            throw new Error(`Handler ${this._name} is already assigned.`);
        }
        this._callback = callback;
        return () => {
            this._callback = null;
        };
    }

    /**
     * Invokes the assigned handler function with the provided arguments.
     * @param args  The arguments to pass to the handler function.
     * @returns The result of the handler function.
     */
    invoke(...args: Parameters<T>): ReturnType<T> {
        if (this._callback) {
            return this._callback(...args);
        }
        throw new Error(`Handler ${this._name} is not assigned.`);
    }
}

/**
 * A binder that allows assigning and invoking a single handler function asynchronously.
 * The invocation will wait until a handler is assigned.
 */
export class LazyBinder<T extends HandlerFunc<any, any>>
    implements
        BinderHandler<Parameters<T>, ReturnType<T>>,
        InvokableHandler<Parameters<T>, Promise<Awaited<ReturnType<T>>>>
{
    private _name: string;
    private _callbackPromise = promiseWithResolvers<void>();
    private _callback: T | null = null;

    /**
     * Creates a new LazyBinder instance.
     * @param name  The name of the handler.
     * @param initialCallback An optional initial callback function to assign.
     */
    constructor(name: string, initialCallback?: T) {
        this._name = name;
        if (initialCallback) {
            this._callback = initialCallback;
            this._callbackPromise.resolve();
        }
    }
    assign(callback: T, override: boolean = false) {
        if (this._callback && !override) {
            throw new Error(`Handler ${this._name} is already assigned.`);
        }
        this._callback = callback;
        this._callbackPromise.resolve();
        return () => {
            this._callback = null;
            this._callbackPromise = promiseWithResolvers<void>();
        };
    }

    /**
     *  Invokes the assigned handler function with the provided arguments.
     * @param args The arguments to pass to the handler function.
     * @returns The result of the handler function.
     */
    async invoke(...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
        await this._callbackPromise.promise;
        if (this._callback) {
            return await this._callback(...args);
        }
        // Most likely unreachable (assign by null?)
        throw new Error(`Handler ${this._name} is not assigned.`);
    }
}

/**
 * A multi-binder that allows adding and removing multiple handler functions.
 */
export class MultiBinder<T extends HandlerFunc<any, any>> implements MultiRegisterHandler<
    Parameters<T>,
    ReturnType<T>
> {
    protected _name: string;
    /**
     * Creates a new MultiBinder instance.
     * @param name  The name of the handler.
     */
    constructor(name: string) {
        this._name = name;
    }
    protected _callbackMap = new Map<T, [number, number]>();
    protected _isCallbackDirty = false;
    protected _maxUsedPriority = 0;

    /**
     * Adds a handler function.
     * Note: The same function is only added once.
     * @param callback The handler function to add.
     * @param priority The priority of the handler, Do not use floating numbers to prevent confusion.
     * @returns A function to unregister the added handler.
     *
     */
    addHandler(callback: T, priority: number = 0, allowSwap: boolean = false): UnregisterFunction {
        // if (this._callbackMap.has(callback)) {
        //     if (allowSwap) {
        //         this.removeHandler(callback);
        //     } else {
        //         throw new Error(`Handler ${this._name} already has the same callback`);
        //     }
        // }
        this._callbackMap.set(callback, [priority, this._maxUsedPriority++]);
        this._isCallbackDirty = true;
        const unregister = () => {
            this.removeHandler(callback);
            this._isCallbackDirty = true;
        };
        return unregister;
    }

    /**
     * Removes a handler function.
     * @param callback The handler function to remove.
     */
    removeHandler(callback: T) {
        this._callbackMap.delete(callback);
        this._isCallbackDirty = true;
    }

    /**
     * Adds a handler function (alias of addHandler, but more semantic).
     * @param callback
     * @returns
     */
    use(callback: T, priority: number = 0) {
        return this.addHandler(callback, priority);
    }

    _sortedCallbacks: T[] = [];
    protected get _callbacks(): T[] {
        if (this._isCallbackDirty) {
            this._sortedCallbacks = Array.from(this._callbackMap.entries())
                .sort((a, b) => {
                    const [priorityA, registerOrderA] = a[1];
                    const [priorityB, registerOrderB] = b[1];
                    if (priorityA !== priorityB) {
                        return priorityA - priorityB; // Sort by priority first
                    }
                    return registerOrderA - registerOrderB; // If priorities are equal, sort by registration order
                })
                .map((entry) => entry[0]);
            this._isCallbackDirty = false;
        }
        return this._sortedCallbacks;
    }
}

/**
 * A dispatcher that invokes all added handler functions sequentially and collects their results.
 * */
export class Dispatch<T extends any[], U> extends MultiBinder<HandlerFunc<T, U>> implements DispatcherHandler<T, U> {
    /**
     * Dispatches the event to all registered handlers sequentially.
     * @param args The arguments to pass to the handlers.
     * @returns An array of results or errors from each handler.
     */
    async dispatch(...args: T): Promise<(Awaited<U> | Error)[]> {
        const results: (Awaited<U> | Error)[] = [];
        const _callbacks = [...this._callbacks];
        for (const callback of _callbacks) {
            try {
                const result = await Promise.resolve(callback(...args));
                results.push(result);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                results.push(err);
            }
        }
        return results;
    }
}

/**
 * A dispatcher that invokes all added handler functions in parallel and collects their results.
 */
export class DispatchParallel<T extends any[], U>
    extends MultiBinder<HandlerFunc<T, U>>
    implements DispatcherHandler<T, U>
{
    /**
     * Dispatches the event to all registered handlers in parallel.
     * @param args The arguments to pass to the handlers.
     * @returns An array of results or errors from each handler.
     */
    dispatch(...args: T): Promise<(Awaited<U> | Error)[]> {
        const callbacks = [...this._callbacks];
        const promises: Promise<U | Error>[] = callbacks.map(async (callback) => {
            try {
                const result = await Promise.resolve(callback(...args));
                return result;
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                return err;
            }
        });
        const results = Promise.all(promises);
        return results;
    }
}

/**
 * A base class for boolean handlers that can add and remove handler functions.
 */
export abstract class BooleanHandlerBase<T extends any[], U = boolean>
    extends MultiBinder<BooleanHandlerFunc<T, U>>
    implements InvokableBooleanHandler<T>
{
    abstract invoke(...args: T): Promise<boolean>;
}

/**
 * A handler that invokes all added handler functions sequentially until one returns false.
 */
export class AllHandler<T extends any[]> extends BooleanHandlerBase<T> {
    /**
     * Invoke all handlers sequentially until one returns false.
     * @param args The arguments to pass to the handlers.
     * @returns A Promise that resolves to true if all handlers return true, otherwise false.
     */
    async invoke(...args: T): Promise<boolean> {
        const _callbacks = [...this._callbacks];
        for (const callback of _callbacks) {
            try {
                const result = await Promise.resolve(callback(...args));
                if (result === false) {
                    return false;
                }
            } catch (error) {
                // On error, consider it as failure
                Logger(`AllHandler ${this._name} treated error as failure: ${error}`, LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
                return false;
            }
        }
        return true;
    }
}
/**
 * A handler that invokes all added handler functions in parallel and returns true only if all return true.
 */
export class ParallelAllHandler<T extends any[]> extends BooleanHandlerBase<T> {
    /**
     * Invoke all handlers in parallel
     * @param args The arguments to pass to the handlers.
     * @returns True if all handlers return true, otherwise false.
     */
    async invoke(...args: T): Promise<boolean> {
        const callbacks = [...this._callbacks];
        const promises: Promise<boolean>[] = callbacks.map(async (callback) => {
            try {
                const result = await Promise.resolve(callback(...args));
                return result;
            } catch (error) {
                // On error, consider it as failure
                Logger(`ParallelAllHandler ${this._name} treated error as failure: ${error}`, LOG_LEVEL_VERBOSE);
                return false;
            }
        });
        const results = await Promise.all(promises);
        return results.every((res) => res === true);
    }
}

/**
 * A handler that invokes all added handler functions sequentially until one returns true.
 */
export class AnySuccessHandler<T extends any[]> extends BooleanHandlerBase<T> {
    /**
     * Invokes handlers sequentially until one returns true.
     * @param args The arguments to pass to the handlers.
     * @returns True if any handler returns true, otherwise false.
     */
    async invoke(...args: T): Promise<boolean> {
        const _callbacks = [...this._callbacks];
        for (const callback of _callbacks) {
            try {
                const result = await Promise.resolve(callback(...args));
                if (result === true) {
                    return true;
                }
            } catch (error) {
                // Ignore errors for 'first success' handler
                Logger(`FirstSuccessHandler ${this._name} ignored error: ${error}`, LOG_LEVEL_VERBOSE);
            }
        }
        return false;
    }
}

/**
 * A handler that invokes all added handler functions sequentially until one returns a non-falsy value.
 */
export class FirstResultHandler<T extends any[], U> extends MultiBinder<BooleanHandlerFunc<T, U>> {
    /**
     * Invokes handlers sequentially until one returns a non-falsy value.
     * @param args The arguments to pass to the handlers.
     * @returns The first non-falsy result from the handlers, or false if none found.
     */
    async invoke(...args: T): Promise<U | false> {
        const _callbacks = [...this._callbacks];
        for (const callback of _callbacks) {
            try {
                const result = await Promise.resolve(callback(...args));
                if (result !== undefined && result !== false) {
                    return result;
                }
            } catch (error) {
                Logger(`FirstResultHandler ${this._name} ignored error: ${error}`, LOG_LEVEL_VERBOSE);
            }
        }
        return false;
    }
}

/**
 * A function type that can be used as a handler with assignable functionality.
 */
export interface HandlerFunction<TFunc extends (...args: any[]) => any | Promise<any>> {
    /**
     * Invokes the handler function with the provided arguments.
     */
    (...args: Parameters<TFunc>): ReturnType<TFunc>;

    /**
     * Assigns a new handler function.
     * @param callback The new handler function to assign.
     * @param override Whether to override the existing handler if one is already assigned.
     * @returns A function to unregister the assigned handler.
     */
    setHandler: (callback: TFunc, override?: boolean) => void;
}
/**
 * A function type that can be used as a handler with assignable functionality.
 */
export interface LazyHandlerFunction<TFunc extends (...args: any[]) => any | Promise<any>> {
    /**
     * Invokes the handler function with the provided arguments.
     */
    (...args: Parameters<TFunc>): Promise<Awaited<ReturnType<TFunc>>>;

    /**
     * Assigns a new handler function.
     * @param callback The new handler function to assign.
     * @param override Whether to override the existing handler if one is already assigned.
     * @returns A function to unregister the assigned handler.
     */
    setHandler: (callback: TFunc, override?: boolean) => void;
}
/**
 * A function type that can be used as a multiple handler with add/remove functionality.
 */
export interface MultipleHandlerFunction<TFunc extends (...args: any[]) => any | Promise<any>> {
    /**
     * Invokes the handler function with the provided arguments.
     */
    (...args: Parameters<TFunc>): ReturnType<TFunc>;
    /**
     * Adds a handler function.
     * @param callback The handler function to add.
     * @returns A function to remove the added handler.
     */
    addHandler: (callback: TFunc) => () => void;
    /**
     * Removes a handler function.
     * @param callback The handler function to remove.
     * @returns
     */
    removeHandler: (callback: TFunc) => void;
}

/**
 * A function type that can be used as a value-collecting handler with add/remove functionality.
 */
export type CollectorFunction<TFunc extends (...args: any[]) => any | Promise<any>> = (
    ...args: Parameters<TFunc>
) => Promise<Awaited<ReturnType<TFunc>>[number]>;

/**
 * A Handler function type that can have multiple handlers added or removed, and collects their results into an array.
 */
export interface CollectiveHandlerFunction<TFunc extends (...args: any[]) => any[] | Promise<any[]>> {
    /**
     * Invokes the handler function with the provided arguments.
     */
    (...args: Parameters<TFunc>): ReturnType<TFunc>;
    /**
     * Adds a handler function.
     * @param callback The handler function to add.
     * @returns A function to remove the added handler.
     */
    addHandler: (callback: CollectorFunction<TFunc>) => () => void;
    /**
     * Removes a handler function.
     * @param callback The handler function to remove.
     * @returns
     */
    removeHandler: (callback: CollectorFunction<TFunc>) => void;
}

export interface BooleanMultipleHandlerFunction<TFunc extends (...args: any[]) => boolean | Promise<boolean>> {
    /**
     * Invokes the handler function with the provided arguments.
     */
    (...args: Parameters<TFunc>): ReturnType<TFunc>;
    /**
     * Adds a handler function.
     * @param callback The handler function to add.
     * @returns A function to remove the added handler.
     */
    addHandler: (callback: TFunc, priority?: number) => () => void;
    /**
     * Removes a handler function.
     * @param callback The handler function to remove.
     * @returns
     */
    removeHandler: (callback: TFunc) => void;
}
// interface BinderInstance<T extends any[], U> extends InvokableHandler<T, U>, BinderHandler<T, U> { }
export interface MultiBinderInstance<T extends any[], U> extends InvokableHandler<T, U>, MultiRegisterHandler<T, U> {}
export interface BooleanMultiBinderInstance<T extends any[]>
    extends InvokableBooleanHandler<T>, MultiRegisterHandler<T, boolean> {}

function getMultipleBound<T extends BooleanMultiBinderInstance<any>>(
    handler: T
): BooleanMultipleHandlerFunction<T["invoke"]>;
function getMultipleBound<T extends MultiBinderInstance<any, any>>(handler: T): MultipleHandlerFunction<T["invoke"]>;
function getMultipleBound<T extends DispatchHandler<any, any>>(handler: T): CollectiveHandlerFunction<T["dispatch"]>;
function getMultipleBound<T extends MultiBinderInstance<any, any> | DispatchHandler<any, any>>(handler: T) {
    const _handler = "invoke" in handler ? handler.invoke : handler.dispatch;
    const __handler = _handler.bind(handler);
    const func = (...args: Parameters<typeof __handler>): ReturnType<typeof __handler> => {
        return __handler(...args);
    };
    func.addHandler = handler.addHandler.bind(handler);
    func.removeHandler = handler.removeHandler.bind(handler);
    func.use = handler;
    return func as MultipleHandlerFunction<typeof __handler>;
}

export function allFunction<TFunc extends (...args: any[]) => Promise<boolean>>(
    name?: string
): BooleanMultipleHandlerFunction<TFunc> {
    const handler = new AllHandler<Parameters<TFunc>>(name ?? "handleAllFunc");
    return getMultipleBound(handler);
}

export function bailFirstFailureFunction<TFunc extends (...args: any[]) => Promise<boolean>>(
    name?: string
): BooleanMultipleHandlerFunction<TFunc> {
    const handler = new AllHandler<Parameters<TFunc>>(name ?? "bailFirstFailureFunction");
    return getMultipleBound(handler);
}

export function allParallelFunction<TFunc extends (...args: any[]) => Promise<boolean>>(
    name?: string
): BooleanMultipleHandlerFunction<TFunc> {
    const handler = new ParallelAllHandler<Parameters<TFunc>>(name ?? "allParallelFunction");
    return getMultipleBound(handler);
}

export function anySuccessFunction<TFunc extends (...args: any[]) => Promise<boolean>>(
    name?: string
): BooleanMultipleHandlerFunction<TFunc> {
    const handler = new AnySuccessHandler<Parameters<TFunc>>(name ?? "anySuccessFunction");
    return getMultipleBound(handler);
}

export function firstResultFunction<TFunc extends (...args: any[]) => Promise<any>>(
    name?: string
): MultipleHandlerFunction<TFunc> {
    const handler = new FirstResultHandler<Parameters<TFunc>, ReturnType<TFunc>>(name ?? "firstResultFunction");
    return getMultipleBound(handler);
}

export function dispatchParallelFunction<TFunc extends (...args: any[]) => Promise<any[]>>(
    name?: string
): CollectiveHandlerFunction<TFunc> {
    const handler = new DispatchParallel<Parameters<TFunc>, Awaited<ReturnType<TFunc>>[number]>(
        name ?? "dispatchParallelFunction"
    );
    return getMultipleBound(handler);
}
export function bindableFunction<TFunc extends (...args: any[]) => any>(name?: string): HandlerFunction<TFunc> {
    const handler = new Binder<TFunc>(name ?? "bindableFunction");
    const func = (...args: Parameters<TFunc>): ReturnType<TFunc> => {
        return handler.invoke(...args);
    };
    func.setHandler = handler.assign.bind(handler);
    return func;
}
export function lazyBindableFunction<TFunc extends (...args: any[]) => any>(name?: string): LazyHandlerFunction<TFunc> {
    const handler = new LazyBinder<TFunc>(name ?? "lazyBindableFunction");
    const func = async (...args: Parameters<TFunc>): Promise<Awaited<ReturnType<TFunc>>> => {
        return await handler.invoke(...args);
    };
    func.setHandler = handler.assign.bind(handler);
    return func;
}

// === Helpers === (handlers<T> function) ===

type FunctionKeys<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];

export function handlers<T extends Record<keyof T, ((...args: any[]) => any) | any>>() {
    return {
        /**
         * Create a handler that invokes all added handler functions sequentially until one returns false.
         * @param name
         * @returns
         */
        all<K extends FunctionKeys<T>>(name: K): BooleanMultipleHandlerFunction<T[K]> {
            return allFunction<T[K]>(String(name));
        },
        /**
         * Create a handler that invokes all added handler functions in parallel and returns true only if all return true.
         * @param name
         * @returns
         */
        allParallel<K extends FunctionKeys<T>>(name: K): BooleanMultipleHandlerFunction<T[K]> {
            return allParallelFunction<T[K]>(String(name));
        },
        /**
         * Create a handler that invokes all added handler functions sequentially until one returns false.
         * @param name
         * @returns
         */
        bailFirstFailure<K extends FunctionKeys<T>>(name: K): BooleanMultipleHandlerFunction<T[K]> {
            return bailFirstFailureFunction<T[K]>(String(name));
        },
        /**
         * Create a handler that invokes all added handler functions sequentially until one returns true.
         * @param name
         * @returns
         */
        anySuccess<K extends FunctionKeys<T>>(name: K): BooleanMultipleHandlerFunction<T[K]> {
            return anySuccessFunction<T[K]>(String(name));
        },
        /**
         * Create a handler that invokes all added handler functions sequentially until one returns a non-falsy value.
         * @param name
         * @returns
         */
        firstResult<K extends FunctionKeys<T>>(name: K): MultipleHandlerFunction<T[K]> {
            return firstResultFunction<T[K]>(String(name));
        },
        /**
         * Create a handler that invokes all added handler functions in parallel.
         * @param name
         * @returns
         */
        dispatchParallel<K extends FunctionKeys<T>>(name: K): CollectiveHandlerFunction<T[K]> {
            return dispatchParallelFunction<T[K]>(String(name));
        },
        /**
         * Create a binder handler that can assign a single handler function.
         * @param name
         * @returns
         */
        binder<K extends FunctionKeys<T>>(name: K): HandlerFunction<T[K]> {
            return bindableFunction<T[K]>(String(name));
        },
        lazyBinder<K extends FunctionKeys<T>>(name: K): LazyHandlerFunction<T[K]> {
            return lazyBindableFunction<T[K]>(String(name));
        },
    };
}
