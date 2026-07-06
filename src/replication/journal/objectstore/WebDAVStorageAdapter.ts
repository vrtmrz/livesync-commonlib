import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type WebDAVSyncSetting } from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import { parseHeaderValues } from "@lib/common/utils.ts";
import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage, JournalStorageSetting } from "./JournalStorageAdapter.ts";

type WebDAVResponseEntry = {
    href: string;
    contentLength?: number;
    isCollection: boolean;
};

type ParsedWebDAVConnection = {
    endpoint: string;
    username: string;
    password: string;
    prefix: string;
    useCustomRequestHandler: boolean;
    customHeaders: string;
};

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`;

function trimSlashes(value: string): string {
    return value.replace(/^\/+|\/+$/g, "");
}

function normalisePrefix(prefix: string): string {
    const trimmed = trimSlashes(prefix.trim());
    return trimmed ? `${trimmed}/` : "";
}

function encodePath(path: string): string {
    return path
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
}

function decodeHrefPath(href: string): string {
    try {
        const parsed = new URL(href, "http://example.invalid");
        return decodeURIComponent(parsed.pathname);
    } catch {
        return decodeURIComponent(href.split("?")[0]);
    }
}

function responseBlocksFromXml(xml: string): string[] {
    const blocks = xml.match(/<[^:>]*:?response[\s\S]*?<\/[^:>]*:?response>/gi);
    return blocks ?? [];
}

function firstTagText(block: string, tagName: string): string {
    const pattern = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, "i");
    const match = block.match(pattern);
    return match?.[1]?.trim() ?? "";
}

function parseWebDAVResponses(xml: string): WebDAVResponseEntry[] {
    return responseBlocksFromXml(xml).map((block) => {
        const href = firstTagText(block, "href");
        const contentLengthText = firstTagText(block, "getcontentlength");
        const contentLength = contentLengthText ? Number.parseInt(contentLengthText, 10) : undefined;
        return {
            href,
            contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
            isCollection: /<[^:>]*:?collection\b/i.test(block),
        };
    });
}

function parseSlsWebDAVUri(uriString: string): ParsedWebDAVConnection {
    const match = uriString.match(/^sls\+webdav:(.*)$/);
    if (!match) {
        throw new Error(`Invalid WebDAV URI: ${uriString}`);
    }
    const url = new URL(`https:${match[1]}`);
    const scheme = url.searchParams.get("insecure") === "true" ? "http" : "https";
    return {
        endpoint: `${scheme}://${url.host}${url.pathname === "/" ? "" : url.pathname}`,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        prefix: url.searchParams.get("prefix") || "",
        useCustomRequestHandler: url.searchParams.get("useProxy") === "true",
        customHeaders: url.searchParams.get("headers") || "",
    };
}

export class WebDAVStorageAdapter implements IJournalStorage {
    _settings: WebDAVSyncSetting;
    _env: LiveSyncJournalReplicatorEnv;

    constructor(settings: JournalStorageSetting, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings as WebDAVSyncSetting;
        this._env = env;
    }

    applyNewConfig(settings: JournalStorageSetting): void {
        this._settings = settings as WebDAVSyncSetting;
    }

    get customHeaders(): Record<string, string> {
        return this.connection.customHeaders.length == 0 ? {} : parseHeaderValues(this.connection.customHeaders);
    }

    get authHeader(): Record<string, string> {
        if (!this.connection.username && !this.connection.password) {
            return {};
        }
        return {
            Authorization: `Basic ${btoa(`${this.connection.username}:${this.connection.password}`)}`,
        };
    }

    get connection(): ParsedWebDAVConnection {
        return parseSlsWebDAVUri(this._settings.webDAVactiveConnectionURI);
    }

    get baseUrl(): URL {
        const endpoint = this.connection.endpoint.replace(/\/+$/g, "");
        return new URL(`${endpoint}/`);
    }

    get prefix(): string {
        return normalisePrefix(this.connection.prefix);
    }

    get endpointPath(): string {
        return trimSlashes(this.baseUrl.pathname);
    }

    get rootPath(): string {
        return trimSlashes(`${this.endpointPath}/${this.prefix}`);
    }

    makeUrl(key = ""): string {
        const path = encodePath(`${this.rootPath}${key ? `/${key}` : ""}`);
        const url = new URL(this.baseUrl.toString());
        url.pathname = `/${path}`;
        return url.toString();
    }

    async request(url: string, init: RequestInit): Promise<Response> {
        const headers = {
            ...this.authHeader,
            ...this.customHeaders,
            ...(init.headers as Record<string, string> | undefined),
        };
        const requestInit = { ...init, headers };
        if (this.connection.useCustomRequestHandler) {
            try {
                return await this._env.services.API.nativeFetch(url, requestInit);
            } catch (ex) {
                Logger(`Could not use native fetch for WebDAV. Falling back to web fetch.`, LOG_LEVEL_VERBOSE);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }
        return await this._env.services.API.webCompatFetch(url, requestInit);
    }

    async ensureCollection(path = this.prefix): Promise<boolean> {
        if (!path) return true;
        const parts = path.split("/").filter((part) => part.length > 0);
        let current = this.endpointPath;
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const url = new URL(this.baseUrl.toString());
            url.pathname = `/${encodePath(current)}`;
            const response = await this.request(url.toString(), { method: "MKCOL" });
            if (response.ok || response.status === 405 || response.status === 301 || response.status === 302) {
                continue;
            }
            Logger(`Could not create WebDAV collection ${current}: ${response.status}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }

    async upload(key: string, data: Uint8Array, mime: string): Promise<boolean> {
        try {
            if (!(await this.ensureCollection())) return false;
            const response = await this.request(this.makeUrl(key), {
                method: "PUT",
                body: data as unknown as BodyInit,
                headers: {
                    "Content-Type": mime,
                },
            });
            return response.ok;
        } catch (ex) {
            Logger(`Could not upload ${key} to WebDAV`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async download(key: string, ignoreCache: boolean = false): Promise<Uint8Array | false> {
        try {
            const response = await this.request(this.makeUrl(key), {
                method: "GET",
                headers: ignoreCache ? { "Cache-Control": "no-cache" } : {},
            });
            if (!response.ok) {
                return false;
            }
            return new Uint8Array(await response.arrayBuffer());
        } catch (ex) {
            Logger(`Could not download ${key} from WebDAV`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async propfind(): Promise<WebDAVResponseEntry[]> {
        const response = await this.request(this.makeUrl(), {
            method: "PROPFIND",
            body: PROPFIND_BODY,
            headers: {
                Depth: "1",
                "Content-Type": "application/xml; charset=utf-8",
            },
        });
        if (!response.ok && response.status !== 207) {
            throw new Error(`WebDAV PROPFIND failed: ${response.status}`);
        }
        return parseWebDAVResponses(await response.text());
    }

    keyFromHref(href: string): string | false {
        const root = `/${this.rootPath}`.replace(/\/+$/g, "/");
        const path = decodeHrefPath(href).replace(/\/+$/g, "");
        const rootWithoutTrailingSlash = root.replace(/\/+$/g, "");
        if (path === rootWithoutTrailingSlash) return false;
        if (!path.startsWith(root)) return false;
        const key = path.substring(root.length).replace(/^\/+/g, "");
        return key ? key : false;
    }

    async listFiles(from: string, limit?: number): Promise<string[]> {
        if (!(await this.ensureCollection())) return [];
        const entries = await this.propfind();
        const files = entries
            .filter((entry) => !entry.isCollection)
            .map((entry) => this.keyFromHref(entry.href))
            .filter((key): key is string => key !== false)
            .filter((key) => !from || key > from)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return limit ? files.slice(0, limit) : files;
    }

    async deleteFiles(keys: string[]): Promise<boolean> {
        let ok = true;
        for (const key of keys) {
            try {
                const response = await this.request(this.makeUrl(key), { method: "DELETE" });
                if (!response.ok && response.status !== 404) {
                    ok = false;
                    Logger(`Could not delete WebDAV file ${key}: ${response.status}`, LOG_LEVEL_VERBOSE);
                }
            } catch (ex) {
                ok = false;
                Logger(`Could not delete WebDAV file ${key}`, LOG_LEVEL_VERBOSE);
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
        }
        return ok;
    }

    async isAvailable(): Promise<boolean> {
        try {
            if (!(await this.ensureCollection())) return false;
            await this.propfind();
            return true;
        } catch (ex) {
            Logger(`Could not connect to the WebDAV collection`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async getUsage(): Promise<false | RemoteDBStatus> {
        try {
            const entries = await this.propfind();
            return {
                estimatedSize: entries.reduce((acc, entry) => acc + (entry.contentLength || 0), 0),
            };
        } catch (ex) {
            Logger(`Could not get status of the WebDAV collection`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
}
