const DB_METHODS = new Set(["info", "changes", "revsDiff", "bulkDocs", "bulkGet", "put", "get"]);

export function toRpcMethodName(method: string): string {
    if (method.includes(".") || method.includes("/")) return method;
    if (DB_METHODS.has(method)) return `db.${method}`;
    return `legacy/${method}`;
}
