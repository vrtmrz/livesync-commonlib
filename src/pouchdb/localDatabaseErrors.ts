const localDatabaseIOMethods = [
    "allDocs",
    "bulkDocs",
    "bulkGet",
    "changes",
    "compact",
    "createIndex",
    "deleteIndex",
    "find",
    "get",
    "getAttachment",
    "info",
    "post",
    "put",
    "putAttachment",
    "remove",
    "removeAttachment",
    "revsDiff",
    "viewCleanup",
    "query",
] as const;

type LocalDatabaseErrorObserver = (error: unknown) => unknown;

/** Match the browser storage error by its public name, including across realms. */
export function isInvalidStateError(error: unknown): boolean {
    const pending = [error];
    const seen = new Set<object>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === null || (typeof current !== "object" && typeof current !== "function")) {
            continue;
        }
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        try {
            if ("name" in current && (current as { name?: unknown }).name === "InvalidStateError") {
                return true;
            }
            if ("cause" in current) {
                pending.push((current as { cause?: unknown }).cause);
            }
        } catch {
            // Ignore hostile getters and inspect the other causes already queued.
        }
    }
    return false;
}

/** Observe failures from one local Pouch instance without replacing its public results. */
export function observeLocalDatabaseErrors<T extends object>(
    database: T,
    onInvalidStateError: LocalDatabaseErrorObserver
): T {
    const methods = database as unknown as Record<string, unknown>;
    for (const methodName of localDatabaseIOMethods) {
        const method = methods[methodName];
        if (typeof method !== "function") {
            continue;
        }
        methods[methodName] = function (this: unknown, ...args: unknown[]): unknown {
            let reported = false;
            const reportOnce = (error: unknown) => {
                if (reported || !isInvalidStateError(error)) {
                    return;
                }
                reported = true;
                try {
                    const observation = onInvalidStateError(error);
                    if (observation !== undefined && observation !== null) {
                        void Promise.resolve(observation).catch((): void => {});
                    }
                } catch {
                    // Error reporting must not replace the database result or failure.
                }
            };

            const callbackIndex = args.length - 1;
            const callback = args[callbackIndex];
            // query(mapFunction) serialises that function; it is not an error-first callback.
            if (typeof callback === "function" && (methodName !== "query" || callbackIndex > 0)) {
                args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
                    reportOnce(callbackArgs[0]);
                    return Reflect.apply(callback, this, callbackArgs);
                };
            }

            let result: unknown;
            try {
                result = Reflect.apply(method, this, args);
            } catch (error) {
                reportOnce(error);
                throw error;
            }

            if (methodName === "changes") {
                attachChangesErrorObserver(result, reportOnce);
            }
            observeRejectedResult(result, reportOnce);
            return result;
        };
    }
    return database;
}

function attachChangesErrorObserver(result: unknown, report: (error: unknown) => void): void {
    if (result === null || (typeof result !== "object" && typeof result !== "function")) {
        return;
    }
    try {
        const on = (result as { on?: unknown }).on;
        if (typeof on === "function") {
            Reflect.apply(on, result, ["error", report]);
        }
    } catch {
        // Keep the original changes object and its event/cancellation behaviour.
    }
}

function observeRejectedResult(result: unknown, report: (error: unknown) => void): void {
    if (result === null || (typeof result !== "object" && typeof result !== "function")) {
        return;
    }
    try {
        if (typeof (result as { then?: unknown }).then !== "function") {
            return;
        }
        void Promise.resolve(result)
            .then(undefined, report)
            .catch((): void => {});
    } catch (error) {
        report(error);
    }
}
