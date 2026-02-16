// The middleware should be composable, meaning that we can have multiple middlewares for the same target function, and they will be executed in order of priority.
// Each middleware can choose to short-circuit the chain by not calling next(), or it can call next() to pass control to the next middleware in the chain.
// If no middleware short-circuits the chain, the final function will be called.
// Function to invoke:
//    isTargetFile(file: string | UXFileInfoStub)
// requires middlewares like:
//    _isTargetFileByFileNameDuplication(ctx: MiddlewareContext, file: string | UXFileInfoStub) : Promise<boolean> ;
//    _isTargetFileByLocalDatabase(ctx: MiddlewareContext, file: string | UXFileInfoStub) : Promise<boolean> ;
//
// Example usage:
//    composable<xxx>().useMiddleware("isTargetFile").use(10, this._isTargetFileByFileNameDuplication.bind(this));
//    isTargetFile = composable<TargetFileFunc>().useMiddleware("isTargetFile").use(10, this._isTargetFileByFileNameDuplication.bind(this));
// Please refer to the unit test file for more examples of usage and expected behaviour/

export interface MiddlewareContext<TResult> {
    next: () => Promise<TResult>;
    state: Record<string, any>;
}

type TargetFunc<TArgs extends any[], TResult> = (...args: TArgs) => Promise<TResult>;
type MiddlewareFunc<TArgs extends any[], TResult> = (
    ctx: MiddlewareContext<TResult>,
    ...args: TArgs
) => Promise<TResult>;

export class MiddlewareManager<TArgs extends any[], TResult> {
    private middlewares: { func: MiddlewareFunc<TArgs, TResult>; priority: number; index: number }[] = [];
    // Middleware is executed in order of priority (lower numbers run first).
    // If two middlewares have the same priority, they are executed in the order they were added.
    // Note: I do not expect to have a large number of middlewares, If so, we should optimise the sorting and execution logic.
    private _indexCounter = 0;
    private _isMiddlewareDirty = true;

    use(priority: number, func: MiddlewareFunc<TArgs, TResult>) {
        const step = { func, priority, index: this._indexCounter++ };
        this.middlewares.push(step);
        this._isMiddlewareDirty = true;
        return () => {
            const idx = this.middlewares.indexOf(step);
            if (idx !== -1) {
                this.middlewares.splice(idx, 1);
                this._isMiddlewareDirty = true;
            }
        };
    }
    setFinal(func: TargetFunc<TArgs, TResult>) {
        this.onStepRunOut = func;
    }

    private sortMiddlewares() {
        const sorted = [...this.middlewares];
        sorted.sort((a, b) => {
            if (a.priority === b.priority) {
                return a.index - b.index; // If priorities are equal, sort by the order they were added
            }
            return a.priority - b.priority; // Otherwise, sort by priority (ascending, i.e, lower numbers run first)
        });
        return sorted;
    }
    protected onStepRunOut: (...args: TArgs) => Promise<TResult> = () => {
        throw new Error(
            "MiddlewareManager: No final function set. Please call setFinal() to set the final function to run when all middlewares have been executed."
        );
    };

    private composed: TargetFunc<TArgs, TResult> = () => {
        throw new Error("MiddlewareManager: compose must be called before using the composed function.");
    };

    private compose(): void {
        if (!this._isMiddlewareDirty) {
            return;
        }
        const sortedMiddlewares = this.sortMiddlewares();
        const composed = (...args: TArgs): Promise<TResult> => {
            const state: Record<string, any> = {}; // state for each execution
            let index = -1;
            const dispatch = async (i: number): Promise<TResult> => {
                if (i <= index) throw new Error("next() called multiple times");
                index = i;

                const item = sortedMiddlewares[i];

                // Default behavior when reaching the end of the chain (here, we return false to indicate it's not a target)
                if (!item) return await Promise.resolve(this.onStepRunOut(...args));

                const ctx: MiddlewareContext<TResult> = {
                    next: () => dispatch(i + 1),
                    state,
                };

                // This may throw an error, but we let it propagate to the caller, as it's likely a critical issue that should be handled by the caller.
                return await Promise.resolve(item.func(ctx, ...args));
            };
            return dispatch(0);
        };
        this.composed = composed;
        this._isMiddlewareDirty = false;
    }
    invoke(...args: TArgs): Promise<TResult> {
        if (this._isMiddlewareDirty) {
            this.compose();
        }
        return this.composed(...args);
    }
}

type FunctionKeys<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];

export function middlewares<T extends Record<keyof T, (...args: any[]) => any>>() {
    return {
        useMiddleware<K extends FunctionKeys<T>>(key: K) {
            const manager = new MiddlewareManager<Parameters<T[K]>, Awaited<ReturnType<T[K]>>>();
            return {
                use: (priority: number, func: MiddlewareFunc<Parameters<T[K]>, Awaited<ReturnType<T[K]>>>) => {
                    return manager.use(priority, func);
                },
                invoke: (...args: Parameters<T[K]>) => {
                    return manager.invoke(...args);
                },
                setFinal: (func: TargetFunc<Parameters<T[K]>, Awaited<ReturnType<T[K]>>>) => {
                    manager.setFinal(func);
                },
            };
        },
    };
}
