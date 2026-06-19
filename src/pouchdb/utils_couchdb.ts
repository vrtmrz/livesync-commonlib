import { _fetch, compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { writeString } from "@lib/string_and_binary/convert.ts";

export const isValidRemoteCouchDBURI = (uri: string): boolean => {
    if (uri.startsWith("https://")) return true;
    if (uri.startsWith("http://")) return true;
    return false;
};

export function isCloudantURI(uri: string): boolean {
    if (uri.indexOf(".cloudantnosqldb.") !== -1 || uri.indexOf(".cloudant.com") !== -1) return true;
    return false;
}

export function isErrorOfMissingDoc(ex: unknown): boolean {
    return (ex && (ex as { status?: number }).status) == 404;
}

export const _requestToCouchDBFetch = async (
    baseUri: string,
    username: string,
    password: string,
    path?: string,
    body?: unknown,
    method?: string
) => {
    const utf8str = String.fromCharCode.apply(null, [...writeString(`${username}:${password}`)]);
    const encoded = compatGlobal.btoa(utf8str);
    const authHeader = "Basic " + encoded;
    const transformedHeaders: Record<string, string> = {
        authorization: authHeader,
        "content-type": "application/json",
    };
    const uri = `${baseUri}/${path}`;
    const requestParam = {
        url: uri,
        method: method || (body ? "PUT" : "GET"),
        headers: new Headers(transformedHeaders),
        contentType: "application/json",
        body: JSON.stringify(body),
    };
    return await _fetch(uri, requestParam);
};
