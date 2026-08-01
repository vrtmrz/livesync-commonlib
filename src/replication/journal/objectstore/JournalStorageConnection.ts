/** Host-supplied WebDAV connection fields encoded by the opaque profile URI. */
export interface WebDAVConnection {
    customHeaders: string;
    endpoint: string;
    password: string;
    prefix: string;
    useCustomRequestHandler: boolean;
    username: string;
}

/** Client-safe PostgREST fields encoded by the opaque profile URI. */
export interface PostgRESTConnection {
    apiKey: string;
    endpoint: string;
    schema: string;
    useCustomRequestHandler: boolean;
    vaultCredential: string;
    vaultId: string;
}

const PROXY_SCHEME = "https";

function parseSlsWebDAVURI(uriString: string): URL {
    const match = /^sls\+webdav:(\/\/.*)$/u.exec(uriString);
    if (!match) throw new Error("Invalid WebDAV connection URI");
    return new URL(`${PROXY_SCHEME}:${match[1]}`);
}

function parseSlsPostgRESTURI(uriString: string): URL {
    const match = /^sls\+postgrest:(\/\/.*)$/u.exec(uriString);
    if (!match) throw new Error("Invalid PostgREST connection URI");
    return new URL(`${PROXY_SCHEME}:${match[1]}`);
}

function endpointFromConnectionURL(url: URL): string {
    const scheme = url.searchParams.get("insecure") === "true" ? "http" : "https";
    return `${scheme}://${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

/** Parses an opaque WebDAV Journal connection URI without performing a network request. */
export function parseWebDAVConnectionURI(uriString: string): WebDAVConnection {
    const url = parseSlsWebDAVURI(uriString);
    return {
        customHeaders: url.searchParams.get("headers") || "",
        endpoint: endpointFromConnectionURL(url),
        password: decodeURIComponent(url.password),
        prefix: url.searchParams.get("prefix") || "",
        useCustomRequestHandler: url.searchParams.get("useProxy") === "true",
        username: decodeURIComponent(url.username),
    };
}

/** Serialises WebDAV Journal connection fields for profile persistence. */
export function serialiseWebDAVConnectionURI(connection: WebDAVConnection): string {
    let endpoint: URL;
    try {
        endpoint = new URL(connection.endpoint);
    } catch {
        throw new Error("Invalid WebDAV endpoint");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("WebDAV endpoint must use HTTP or HTTPS");
    }
    if (endpoint.username || endpoint.password) {
        throw new Error("WebDAV endpoint must not include credentials");
    }
    if (endpoint.search || endpoint.hash) {
        throw new Error("WebDAV endpoint must not include a query or fragment");
    }

    const url = new URL(`${PROXY_SCHEME}://${endpoint.host}${endpoint.pathname}`);
    url.username = connection.username;
    url.password = connection.password;
    if (endpoint.protocol === "http:") url.searchParams.set("insecure", "true");
    if (connection.prefix) url.searchParams.set("prefix", connection.prefix);
    if (connection.customHeaders) url.searchParams.set("headers", connection.customHeaders);
    if (connection.useCustomRequestHandler) url.searchParams.set("useProxy", "true");
    const serialised = url.toString();
    return `sls+webdav:${serialised.slice(`${PROXY_SCHEME}:`.length)}`;
}

/** Parses an Adaptive-only PostgREST connection URI without performing a network request. */
export function parsePostgRESTConnectionURI(uriString: string): PostgRESTConnection {
    const url = parseSlsPostgRESTURI(uriString);
    const schema = url.searchParams.get("schema") || "livesync_api";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error("Invalid PostgREST schema name");
    return {
        apiKey: url.searchParams.get("apiKey") || "",
        endpoint: endpointFromConnectionURL(url),
        schema,
        useCustomRequestHandler: url.searchParams.get("useProxy") === "true",
        vaultCredential: decodeURIComponent(url.password),
        vaultId: decodeURIComponent(url.username),
    };
}

/** Serialises client-safe PostgREST connection fields for profile persistence. */
export function serialisePostgRESTConnectionURI(connection: PostgRESTConnection): string {
    const endpoint = new URL(connection.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("PostgREST endpoint must use HTTP or HTTPS");
    }
    if (endpoint.username || endpoint.password) {
        throw new Error("PostgREST endpoint must not contain database credentials");
    }
    if (endpoint.search || endpoint.hash) {
        throw new Error("PostgREST endpoint must not include a query or fragment");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(connection.schema)) {
        throw new Error("Invalid PostgREST schema name");
    }

    const url = new URL(`${PROXY_SCHEME}://${endpoint.host}${endpoint.pathname}`);
    url.username = connection.vaultId;
    url.password = connection.vaultCredential;
    if (endpoint.protocol === "http:") url.searchParams.set("insecure", "true");
    if (connection.schema !== "livesync_api") url.searchParams.set("schema", connection.schema);
    if (connection.apiKey) url.searchParams.set("apiKey", connection.apiKey);
    if (connection.useCustomRequestHandler) url.searchParams.set("useProxy", "true");
    const serialised = url.toString();
    return `sls+postgrest:${serialised.slice(`${PROXY_SCHEME}:`.length)}`;
}
