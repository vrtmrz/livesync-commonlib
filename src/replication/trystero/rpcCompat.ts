const DB_METHODS = new Set(["info", "changes", "revsDiff", "bulkDocs", "bulkGet", "put", "get"]);
const NOTIFICATION_PREFIX = "RPC notification ";

export function toRpcMethodName(method: string): string {
    if (method.includes(".") || method.includes("/")) return method;
    if (DB_METHODS.has(method)) return `db.${method}`;
    return `legacy/${method}`;
}

export function formatRpcProtocolWarning(message: string, notificationMethod?: string): string {
    if (message.startsWith("Invalid payload:")) {
        return "Invalid payload";
    }
    if (message.startsWith(NOTIFICATION_PREFIX)) {
        const methodPrefix = `${NOTIFICATION_PREFIX}${notificationMethod}: `;
        if (notificationMethod !== undefined && message.startsWith(methodPrefix)) {
            return `${methodPrefix}failed`;
        }
        return "RPC notification failed";
    }
    return message;
}
