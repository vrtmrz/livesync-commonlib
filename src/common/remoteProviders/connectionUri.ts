const PROXY_SCHEME = "https";

export function parseSlsConnectionUri(uri: string): { scheme: string; url: URL } {
    const match = /^sls\+([^:]+):(.*)$/u.exec(uri);
    if (!match) throw new Error(`Unsupported URI: ${uri}`);
    return {
        scheme: match[1],
        url: new URL(`${PROXY_SCHEME}:${match[2]}`),
    };
}

export function withSlsConnectionScheme(url: URL, scheme: string): string {
    const serialised = url.toString();
    return `sls+${scheme}:${serialised.slice(PROXY_SCHEME.length + 1)}`;
}

export function proxyConnectionUrl(authorityAndPath: string): URL {
    return new URL(`${PROXY_SCHEME}://${authorityAndPath}`);
}
