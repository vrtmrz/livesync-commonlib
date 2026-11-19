const DB_METHODS = new Set(["info", "changes", "revsDiff", "bulkDocs", "bulkGet", "put", "get"]);
const NOTIFICATION_PREFIX = "RPC notification ";
const MISSING_METHOD_SEPARATOR = ": Method not found: ";
const MAJOR_MISMATCH_REASON = /: RPC major mismatch: local=\d+, remote=[^\s:]+$/;
const RPC_CALLBACK_FAILURE = "Commonlib RPC callback failed";
const CALLBACK_FAILURE_SUFFIX = `: ${RPC_CALLBACK_FAILURE}`;

export function toRpcMethodName(method: string): string {
    if (method.includes(".") || method.includes("/")) return method;
    if (DB_METHODS.has(method)) return `db.${method}`;
    return `legacy/${method}`;
}

export function formatRpcProtocolWarning(message: string): string {
    if (message.startsWith("Invalid payload:")) {
        return "Invalid payload";
    }
    if (message.startsWith(NOTIFICATION_PREFIX)) {
        const failure = message.slice(NOTIFICATION_PREFIX.length);
        const method = notificationWarningMethod(failure);
        return method === undefined ? "RPC notification failed" : `${NOTIFICATION_PREFIX}${method}: failed`;
    }
    return message;
}

export function formatRpcCallbackFailure(method: string): string {
    // Missing-method warnings repeat the method. Use the opposite length parity
    // so a callback warning cannot match that format for any method name.
    const warningLength = method.length + CALLBACK_FAILURE_SUFFIX.length;
    const needsPadding = warningLength % 2 === MISSING_METHOD_SEPARATOR.length % 2;
    return needsPadding ? `${RPC_CALLBACK_FAILURE}.` : RPC_CALLBACK_FAILURE;
}

function notificationWarningMethod(failure: string): string | undefined {
    // Fancy Kit 0.1.0 repeats the method in a missing-method diagnostic.
    const methodLength = (failure.length - MISSING_METHOD_SEPARATOR.length) / 2;
    if (Number.isInteger(methodLength) && methodLength >= 0) {
        const method = failure.slice(0, methodLength);
        if (failure.slice(methodLength) === MISSING_METHOD_SEPARATOR + method) {
            return method;
        }
    }
    const mismatch = failure.match(MAJOR_MISMATCH_REASON);
    if (mismatch) {
        return failure.slice(0, mismatch.index);
    }
    const callbackFailure = failure.endsWith(".") ? failure.slice(0, -1) : failure;
    if (callbackFailure.endsWith(CALLBACK_FAILURE_SUFFIX)) {
        return callbackFailure.slice(0, -CALLBACK_FAILURE_SUFFIX.length);
    }
    return undefined;
}
