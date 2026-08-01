/** Host-supplied WebDAV connection fields encoded by the opaque profile URI. */
export interface WebDAVConnection {
    customHeaders: string;
    endpoint: string;
    password: string;
    prefix: string;
    useCustomRequestHandler: boolean;
    username: string;
}

const PROXY_SCHEME = "https";

function parseSlsWebDAVURI(uriString: string): URL {
    const match = /^sls\+webdav:(\/\/.*)$/u.exec(uriString);
    if (!match) throw new Error("Invalid WebDAV connection URI");
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
