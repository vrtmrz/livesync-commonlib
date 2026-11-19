const DB_METHODS = new Set(["info", "changes", "revsDiff", "bulkDocs", "bulkGet", "put", "get"]);

export function toRpcMethodName(method: string): string {
    if (method.includes(".") || method.includes("/")) return method;
    if (DB_METHODS.has(method)) return `db.${method}`;
    return `legacy/${method}`;
}

export function formatRpcProtocolWarning(message: string): string {
    if (message.startsWith("Invalid payload:")) {
        return "Invalid payload";
    }
    const notificationPrefix = "RPC notification ";
    if (message.startsWith(notificationPrefix)) {
        // RPC 0.1.0 includes the exception text after the notification method.
        const methodEnd = message.indexOf(": ", notificationPrefix.length);
        return methodEnd < 0 ? "RPC notification failed" : `${message.slice(0, methodEnd)}: failed`;
    }
    return message;
}
