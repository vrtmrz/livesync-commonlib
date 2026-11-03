import { uint8ArrayToHexString } from "@lib/string_and_binary/convert.ts";

const processEpoch = Math.floor(Date.now() / 1000);

/** Keep encrypted HTTP responses within the Security Seed which produced them. */
export function createCouchDBHttpCache(
    uri: string,
    getPBKDF2Salt?: () => Promise<Uint8Array<ArrayBuffer>>,
    headersOnly = false
) {
    const databasePath = new URL(uri).pathname.replace(/\/$/, "");
    let previousSalt: Uint8Array<ArrayBuffer> | undefined;
    let namespace: Promise<string> | undefined;

    const getNamespace = async () => {
        const salt = await getPBKDF2Salt!();
        if (!previousSalt || previousSalt.length !== salt.length || previousSalt.some((byte, i) => byte !== salt[i])) {
            previousSalt = salt.slice();
            const epoch = new TextEncoder().encode(`${processEpoch}:`);
            const input = new Uint8Array(epoch.length + previousSalt.length);
            input.set(epoch);
            input.set(previousSalt, epoch.length);
            namespace = crypto.subtle
                .digest("SHA-256", input)
                .then((digest) => uint8ArrayToHexString(new Uint8Array(digest)));
        }
        return namespace!;
    };

    return async (request: string | Request, options?: RequestInit) => {
        const method = (options?.method ?? (typeof request === "string" ? "GET" : request.method)).toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
            return { request, cache: options?.cache };
        }
        if (headersOnly) return { request, cache: "no-store" as const };
        const url = new URL(typeof request === "string" ? request : request.url);
        const relativePath = url.pathname.startsWith(`${databasePath}/`)
            ? decodeURIComponent(url.pathname.slice(databasePath.length + 1))
            : "";
        // Local documents have body-dependent ETags and must bootstrap the Seed without recursion.
        if (getPBKDF2Salt && relativePath && !relativePath.startsWith("_local/")) {
            url.searchParams.set("_livesync_epoch", await getNamespace());
            request = typeof request === "string" ? url.href : new Request(url.href, request);
        }
        // Revalidate every read, while allowing a 304 to reuse a body from the same Seed.
        return { request, cache: "no-cache" as const };
    };
}
