import type { Constructor } from "@lib/common/utils.type";
interface ErrorWithCause extends Error {
    cause?: unknown;
}

function getStatusFromError(error: unknown): number | undefined {
    if (error && typeof error === "object") {
        if ("status" in error && typeof error.status === "number") {
            return error.status;
        }
        if ("cause" in error) {
            return getStatusFromError(error.cause);
        }
    }
    return 500; // Default status code for internal server error if no status found in the cause chain
}

function getMessageFromError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "object" && error !== null) {
        return JSON.stringify(error);
    }
    return String(error);
}
function getErrorCause(error: unknown): unknown {
    if (error && typeof error === "object" && "cause" in error) {
        return (error as { cause?: unknown }).cause;
    }
    return undefined;
}

/**
 * Error class for Self-hosted LiveSync errors.
 * This class extends the base LiveSyncError class and provides additional context for errors related to LiveSync operations.
 * It includes a name property and a cause property to capture the original error.
 * The status property returns the HTTP status code if available, defaulting to 500 for internal server errors.
 * The class also includes static methods to check whether an error is caused by a specific error class.
 */
export class LiveSyncError extends Error implements ErrorWithCause {
    override name = this.constructor.name;
    override cause?: Error | object | string;
    overrideStatus?: number;
    /**
     * Returns the HTTP status code associated with the error, if available.
     * If the error has a status property, it returns that; otherwise, it defaults to 500 (Internal Server Error).
     * @returns {number} The HTTP status code.
     */
    get status(): number {
        if (this.overrideStatus !== undefined) {
            return this.overrideStatus;
        }
        if (this.cause) {
            const status = getStatusFromError(this.cause);
            if (status !== undefined) {
                return status;
            }
        }
        return 500; // Default status code for internal server error
    }
    /**
     * Constructs a new LiveSyncError instance.
     * @param message The error message to be displayed.
     */
    constructor(message: string, options?: { cause?: unknown; status?: number }) {
        super(message);
        if (options?.cause) {
            const actualCause = getErrorCause(options);
            this.cause =
                actualCause instanceof Error
                    ? actualCause
                    : new Error(`Unknown cause: ${getMessageFromError(actualCause)}`);
        }
        if (options?.status !== undefined) {
            this.overrideStatus = options.status;
        }
    }

    /**
     * Determines whether an error is caused by a specific error class.
     * @param error The error to examine.
     * @param errorClass The error class to compare against.
     * @returns True if the error is caused by the specified error class; otherwise, false.
     * @example
     * LiveSyncError.isCausedBy(someSyncParamsFetchError, SyncParamsNotFoundError); // Returns true if the error is caused by SyncParamsNotFoundError; this is usually represented as SyncParamsFetchError at the uppermost layer.
     */
    static isCausedBy<T extends LiveSyncError>(error: unknown, errorClass: Constructor<T>): boolean {
        if (!error) {
            return false;
        }
        if (error instanceof errorClass) {
            return true;
        }
        if (typeof error === "object" && !!error && "cause" in error) {
            const cause = getErrorCause(error);
            if (cause === error) {
                // Avoid infinite loop in case of circular cause reference.
                return false;
            }
            return LiveSyncError.isCausedBy(cause, errorClass);
        }
        return false;
    }
    /**
     * Creates a new instance of the error class from an existing error.
     * @param error The error to wrap.
     * @returns A new instance of the error class with the original error's message and stack trace.
     */
    static fromError<T extends typeof LiveSyncError>(this: T, error: unknown): InstanceType<T> {
        if (error instanceof this) {
            return error as InstanceType<T>;
        }
        const instance = new this(`${this.name}: ${getMessageFromError(error)}`, {
            cause: error,
            status: getStatusFromError(error),
        }) as InstanceType<T>;
        if (error instanceof Error) {
            instance.stack = error.stack;
        } else {
            instance.stack = new Error().stack;
        }
        return instance;
    }
}

export class LiveSyncFatalError extends LiveSyncError {}
