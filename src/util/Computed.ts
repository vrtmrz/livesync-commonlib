/**
 * A class that computes a value based on provided arguments and caches the result.
 * The computation is only re-evaluated when the arguments change or when a forced update is requested.
 * Mostly similar to "Refiner", but simpler implementation.
 */
export class Computed<T extends any[], U> {
    /**
     * Previous arguments used for computation.
     */
    private _previousArgs: T | null = null;

    /**
     * Previous result of the computation.
     */
    private _previousResult: U | null = null;

    /**
     * Function to compute the value based on provided arguments.
     */
    private _func: (...args: T) => Promise<U> | U;

    /**
     * Function to determine if a forced update is needed.
     * @param args - Current arguments.
     * @param previousArgs - Previous arguments.
     * @param previousResult - Previous result.
     * @returns {Promise<boolean> | boolean} True if a forced update is needed, false otherwise. (in that case, the difference of args is still checked)
     */
    private _shouldForceUpdate: (
        args: T,
        previousArgs: T | null,
        previousResult: U | null
    ) => Promise<boolean> | boolean;

    /**
     * Creates an instance of Computed.
     * @param params - Parameters for the Computed instance.
     * @param params.evaluation - Function to compute the value.
     * @param params.shouldUpdate - Optional function to determine if a forced update is needed.
     */
    constructor(params: {
        evaluation: (...args: T) => Promise<U> | U;
        shouldUpdate?: (args: T, previousArgs: T | null, previousResult: U | null) => Promise<boolean> | boolean;
    }) {
        this._func = params.evaluation;
        this._shouldForceUpdate = params.shouldUpdate || (() => false);
    }
    /**
     * Updates the computed value if necessary.
     * @param args - The current arguments.
     * @returns {Promise<boolean>} True if the value was updated, false otherwise.
     */
    async updateValue(...args: T): Promise<boolean> {
        const forceUpdate = await this._shouldForceUpdate(args, this._previousArgs, this._previousResult);
        if (!forceUpdate) {
            if (this._previousArgs && this._areArgsEqual(args, this._previousArgs)) {
                return false;
            }
        }
        try {
            this._previousResult = await this._func(...args);
        } finally {
            this._previousArgs = args;
        }
        return true;
    }
    /**
     * Updates the computed value and returns the instance.
     * (Convenience method)
     * @param args - The current arguments.
     * @returns {Promise<this>} The Computed instance.
     */
    async update(...args: T): Promise<this> {
        if (await this.updateValue(...args)) {
            // updated
        }
        return this;
    }
    /**
     * Gets the current computed value.
     * @returns {U} The computed value.
     */
    get value(): U {
        return this._previousResult as U;
    }

    /**
     * Checks if two sets of arguments are equal.
     * @param args1 - The first set of arguments.
     * @param args2 - The second set of arguments.
     * @returns {boolean} True if the arguments are equal, false otherwise.
     */
    private _areArgsEqual(args1: T, args2: T): boolean {
        return JSON.stringify(args1) === JSON.stringify(args2);
    }
}
