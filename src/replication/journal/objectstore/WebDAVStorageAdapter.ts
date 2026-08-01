import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { Logger } from "@lib/common/logger.ts";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type WebDAVSyncSetting } from "@lib/common/types.ts";
import { parseHeaderValues } from "@lib/common/utils.ts";
import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { bytesToHex } from "../adaptive/AdaptiveJournalBinary.ts";
import { probeAdaptiveJournalObjectCapabilitiesV1 } from "../adaptive/AdaptiveJournalObjectCapabilityProbe.ts";
import type {
    AdaptiveJournalManifestRemoteV1,
    CapabilityVerification,
    ImmutableCreate,
    RemoteFailure,
    RemoteRead,
} from "../adaptive/AdaptiveJournalRepository.ts";
import type {
    AdaptiveJournalByteRangeV1,
    AdaptiveJournalObjectListV1,
    AdaptiveJournalObjectRemoteV1,
} from "../adaptive/AdaptiveJournalObjectStore.ts";
import { runWithTrackedPhysicalRequest } from "@lib/services/lib/remoteActivity.ts";
import {
    classifyJournalStorageRemoteFormatV1,
    invalidateJournalStorageRemoteFormatV1,
    type IJournalStorage,
    type JournalStorageRemoteFormatV1,
    type JournalStorageSetting,
} from "./JournalStorageAdapter.ts";
import { parseWebDAVConnectionURI, type WebDAVConnection } from "./JournalStorageConnection.ts";

const ADAPTIVE_MANIFEST_KEY = "a1~manifest.json";
const ADAPTIVE_PROBE_PREFIX = "a1~probe~";

const PROPFIND_LIST_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

const PROPFIND_USAGE_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:quota-used-bytes/>
    <d:quota-available-bytes/>
  </d:prop>
</d:propfind>`;

interface WebDAVResponseEntry {
    contentLength?: number;
    href: string;
    isCollection: boolean;
    quotaAvailableBytes?: number;
    quotaUsedBytes?: number;
}

interface WebDAVBytesResponse {
    contentRange?: string;
    etag?: string;
    ok: boolean;
    status: number;
    value?: Uint8Array;
}

interface WebDAVStatusResponse {
    etag?: string;
    ok: boolean;
    status: number;
}

class WebDAVHTTPError extends Error {
    constructor(readonly status: number) {
        super(`WebDAV request failed with HTTP ${status}`);
        this.name = "WebDAVHTTPError";
    }
}

class WebDAVInvalidResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebDAVInvalidResponseError";
    }
}

function trimSlashes(value: string): string {
    return value.replace(/^\/+|\/+$/gu, "");
}

function normalisePrefix(prefix: string): string {
    const parts = prefix
        .trim()
        .split("/")
        .filter((part) => part.length > 0);
    if (parts.some((part) => part === "." || part === "..")) {
        throw new TypeError("WebDAV Journal prefix must not contain dot path segments");
    }
    return parts.length > 0 ? `${parts.join("/")}/` : "";
}

function encodePath(path: string): string {
    return path
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
}

function decodeXmlText(value: string): string {
    return value.replace(/&(?:#([0-9]+)|#x([0-9a-f]+)|amp|apos|gt|lt|quot);/giu, (entity, decimal, hex) => {
        if (decimal || hex) {
            const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
            const validXmlCharacter =
                codePoint === 0x09 ||
                codePoint === 0x0a ||
                codePoint === 0x0d ||
                (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
                (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
                (codePoint >= 0x10000 && codePoint <= 0x10ffff);
            if (!validXmlCharacter) {
                throw new WebDAVInvalidResponseError("WebDAV listing contains an invalid XML character reference");
            }
            return String.fromCodePoint(codePoint);
        }
        switch (entity.toLowerCase()) {
            case "&amp;":
                return "&";
            case "&apos;":
                return "'";
            case "&gt;":
                return ">";
            case "&lt;":
                return "<";
            case "&quot;":
                return '"';
            default:
                return entity;
        }
    });
}

function decodeHrefPath(href: string): string {
    const decodedHref = decodeXmlText(href);
    try {
        const parsed = new URL(decodedHref, "http://example.invalid");
        return decodeURIComponent(parsed.pathname);
    } catch {
        try {
            return decodeURIComponent(decodedHref.split("?")[0]);
        } catch {
            throw new WebDAVInvalidResponseError("WebDAV listing contains an invalid encoded href");
        }
    }
}

function responseBlocksFromXml(xml: string): string[] {
    return xml.match(/<[^:>]*:?response\b[\s\S]*?<\/[^:>]*:?response>/giu) ?? [];
}

function firstTagText(block: string, tagName: string): string {
    const pattern = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, "iu");
    return pattern.exec(block)?.[1]?.trim() ?? "";
}

function optionalNonNegativeInteger(value: string): number | undefined {
    if (!/^[0-9]+$/u.test(value)) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseWebDAVResponses(xml: string): WebDAVResponseEntry[] {
    const blocks = responseBlocksFromXml(xml);
    if (blocks.length === 0) throw new WebDAVInvalidResponseError("WebDAV PROPFIND returned no response entries");
    return blocks.map((block) => {
        const href = firstTagText(block, "href");
        if (!href) throw new WebDAVInvalidResponseError("WebDAV PROPFIND response omitted href");
        return {
            href,
            isCollection: /<[^:>]*:?collection\b/iu.test(block),
            contentLength: optionalNonNegativeInteger(firstTagText(block, "getcontentlength")),
            quotaAvailableBytes: optionalNonNegativeInteger(firstTagText(block, "quota-available-bytes")),
            quotaUsedBytes: optionalNonNegativeInteger(firstTagText(block, "quota-used-bytes")),
        };
    });
}

function utf8Base64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const blockSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
    }
    return btoa(binary);
}

function sameWebDAVConnection(left: WebDAVSyncSetting, right: WebDAVSyncSetting): boolean {
    try {
        const a = parseWebDAVConnectionURI(left.webDAVactiveConnectionURI);
        const b = parseWebDAVConnectionURI(right.webDAVactiveConnectionURI);
        return (
            a.endpoint === b.endpoint &&
            a.username === b.username &&
            a.password === b.password &&
            normalisePrefix(a.prefix) === normalisePrefix(b.prefix) &&
            a.useCustomRequestHandler === b.useCustomRequestHandler &&
            a.customHeaders === b.customHeaders
        );
    } catch {
        return left.webDAVactiveConnectionURI === right.webDAVactiveConnectionURI;
    }
}

function statusFailure(status: number, mutation: boolean): RemoteFailure {
    if (status === 401) return { category: "authentication", retry: "never" };
    if (status === 403) return { category: "permission", retry: "never" };
    if (status === 408 || status === 423 || status === 429) {
        return { category: status === 429 ? "rate-limited" : "unavailable", retry: "later" };
    }
    if (status === 409) return { category: "unavailable", retry: "later" };
    if (status >= 500) return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
    return { category: "invalid-response", retry: "never" };
}

function webDAVRemoteFailure(error: unknown, mutation: boolean): RemoteFailure {
    if (error instanceof WebDAVHTTPError) return statusFailure(error.status, mutation);
    if (error instanceof WebDAVInvalidResponseError) return { category: "invalid-response", retry: "never" };
    return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
}

async function discardResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Response disposal is best effort after the status has already been observed.
    }
}

export class WebDAVStorageAdapter
    implements IJournalStorage, AdaptiveJournalManifestRemoteV1, AdaptiveJournalObjectRemoteV1
{
    readonly kind = "webdav" as const;
    _settings: WebDAVSyncSetting;
    _env: LiveSyncJournalReplicatorEnv;
    private adaptiveListingSnapshot?: Promise<AdaptiveJournalObjectListV1>;
    private capabilityVerifications = new Map<string, Promise<CapabilityVerification>>();
    private collectionReady?: Promise<void>;
    private receivePhaseDepth = 0;

    constructor(settings: JournalStorageSetting, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings as WebDAVSyncSetting;
        this._env = env;
    }

    applyNewConfig(settings: JournalStorageSetting): void {
        const next = settings as WebDAVSyncSetting;
        if (!sameWebDAVConnection(this._settings, next)) {
            this.adaptiveListingSnapshot = undefined;
            this.capabilityVerifications.clear();
            this.collectionReady = undefined;
            invalidateJournalStorageRemoteFormatV1(this);
        }
        this._settings = next;
    }

    get connection(): WebDAVConnection {
        return parseWebDAVConnectionURI(this._settings.webDAVactiveConnectionURI);
    }

    get storageIdentity(): string {
        const connection = this.connection;
        return `webdav:${JSON.stringify({
            endpoint: connection.endpoint.replace(/\/+$/gu, ""),
            prefix: normalisePrefix(connection.prefix),
            username: connection.username,
        })}`;
    }

    get baseUrl(): URL {
        return new URL(`${this.connection.endpoint.replace(/\/+$/gu, "")}/`);
    }

    get endpointPath(): string {
        try {
            return trimSlashes(decodeURIComponent(this.baseUrl.pathname));
        } catch {
            throw new TypeError("WebDAV endpoint path contains invalid percent-encoding");
        }
    }

    get prefix(): string {
        return normalisePrefix(this.connection.prefix);
    }

    get rootPath(): string {
        return trimSlashes(`${this.endpointPath}/${this.prefix}`);
    }

    get authHeader(): Record<string, string> {
        const { username, password } = this.connection;
        if (!username && !password) return {};
        return { Authorization: `Basic ${utf8Base64(`${username}:${password}`)}` };
    }

    get customHeaders(): Record<string, string> {
        const value = this.connection.customHeaders;
        return value.length === 0 ? {} : parseHeaderValues(value);
    }

    makeUrl(key = ""): string {
        if (key.includes("/") || key === "." || key === "..") {
            throw new TypeError("WebDAV Journal object keys must be flat names without dot path segments");
        }
        const path = encodePath(`${this.rootPath}${key ? `/${key}` : ""}`);
        const url = new URL(this.baseUrl.toString());
        url.pathname = `/${path}${key || !path ? "" : "/"}`;
        return url.toString();
    }

    private async runTrackedRequest<T>(task: () => T | PromiseLike<T>): Promise<T> {
        return await runWithTrackedPhysicalRequest(this._env.services.API, task);
    }

    private requestHeaders(init: RequestInit): Record<string, string> {
        const headers = new Headers(this.authHeader);
        for (const [key, value] of Object.entries(this.customHeaders)) headers.set(key, value);
        const supplied = new Headers(init.headers);
        supplied.forEach((value, key) => headers.set(key, value));
        return Object.fromEntries(headers.entries());
    }

    private async request<T>(
        url: string,
        init: RequestInit,
        consume: (response: Response) => T | Promise<T>
    ): Promise<T> {
        const requestInit = { ...init, headers: this.requestHeaders(init) };
        if (this.connection.useCustomRequestHandler) {
            let receivedResponse = false;
            try {
                return await this.runTrackedRequest(async () => {
                    const response = await this._env.services.API.nativeFetch(url, requestInit);
                    receivedResponse = true;
                    return await consume(response);
                });
            } catch (error) {
                if (receivedResponse) throw error;
                Logger("Could not use native fetch for WebDAV. Falling back to web fetch.", LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        }
        return await this.runTrackedRequest(async () => {
            const response = await this._env.services.API.webCompatFetch(url, requestInit);
            return await consume(response);
        });
    }

    private async requestStatus(url: string, init: RequestInit): Promise<WebDAVStatusResponse> {
        return await this.request(url, init, async (response) => {
            await discardResponseBody(response);
            return {
                etag: response.headers.get("etag") ?? undefined,
                ok: response.ok,
                status: response.status,
            };
        });
    }

    private async requestBytes(url: string, init: RequestInit): Promise<WebDAVBytesResponse> {
        return await this.request(url, init, async (response) => {
            const value = response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
            if (!response.ok) await discardResponseBody(response);
            return {
                contentRange: response.headers.get("content-range") ?? undefined,
                etag: response.headers.get("etag") ?? undefined,
                ok: response.ok,
                status: response.status,
                ...(value ? { value } : {}),
            };
        });
    }

    private async ensureCollectionUncached(): Promise<void> {
        if (!this.prefix) return;
        const parts = this.prefix.split("/").filter((part) => part.length > 0);
        let current = this.endpointPath;
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const url = new URL(this.baseUrl.toString());
            url.pathname = `/${encodePath(current)}`;
            const response = await this.requestStatus(url.toString(), { method: "MKCOL" });
            if (response.ok || response.status === 405) continue;
            throw new WebDAVHTTPError(response.status);
        }
    }

    private async ensureCollection(): Promise<void> {
        let ready = this.collectionReady;
        if (!ready) {
            ready = this.ensureCollectionUncached();
            this.collectionReady = ready;
        }
        try {
            await ready;
        } catch (error) {
            if (this.collectionReady === ready) this.collectionReady = undefined;
            throw error;
        }
    }

    private async propfind(includeUsage: boolean): Promise<WebDAVResponseEntry[]> {
        await this.ensureCollection();
        return await this.request(
            this.makeUrl(),
            {
                body: includeUsage ? PROPFIND_USAGE_BODY : PROPFIND_LIST_BODY,
                headers: {
                    Depth: "1",
                    "Content-Type": "application/xml; charset=utf-8",
                },
                method: "PROPFIND",
            },
            async (response) => {
                if (!response.ok) {
                    await discardResponseBody(response);
                    throw new WebDAVHTTPError(response.status);
                }
                return parseWebDAVResponses(await response.text());
            }
        );
    }

    keyFromHref(href: string): string | false {
        const rootWithoutTrailingSlash = this.rootPath ? `/${this.rootPath}` : "";
        const root = `${rootWithoutTrailingSlash}/`;
        const path = decodeHrefPath(href).replace(/\/+$/gu, "");
        if (path === rootWithoutTrailingSlash) return false;
        if (!path.startsWith(root)) return false;
        const key = path.substring(root.length).replace(/^\/+/gu, "");
        return key || false;
    }

    private async listedFiles(includeUsage = false): Promise<{
        entries: WebDAVResponseEntry[];
        keys: string[];
    }> {
        const entries = await this.propfind(includeUsage);
        const keys = entries
            .filter((entry) => !entry.isCollection)
            .map((entry) => this.keyFromHref(entry.href))
            .filter((key): key is string => key !== false)
            .sort();
        return { entries, keys };
    }

    async upload(key: string, data: Uint8Array, mime: string): Promise<boolean> {
        try {
            await this.ensureCollection();
            const response = await this.requestStatus(this.makeUrl(key), {
                body: data as unknown as BodyInit,
                headers: { "Content-Type": mime },
                method: "PUT",
            });
            return response.ok;
        } catch (error) {
            Logger(`Could not upload ${key} to WebDAV`);
            Logger(error, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async download(key: string, ignoreCache = false): Promise<Uint8Array | false> {
        try {
            const response = await this.requestBytes(this.makeUrl(key), {
                headers: ignoreCache ? { "Cache-Control": "no-cache" } : {},
                method: "GET",
            });
            return response.ok && response.value ? response.value : false;
        } catch (error) {
            Logger(`Could not download ${key} from WebDAV`);
            Logger(error, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async listFiles(from: string, limit?: number): Promise<string[]> {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
            throw new RangeError("WebDAV Journal listing limit must be a non-negative safe integer");
        }
        if (limit === 0) return [];
        const { keys } = await this.listedFiles();
        const filtered = keys.filter((key) => !from || key > from);
        return limit === undefined ? filtered : filtered.slice(0, limit);
    }

    async deleteFiles(keys: string[]): Promise<boolean> {
        let ok = true;
        for (const key of keys) {
            try {
                const response = await this.requestStatus(this.makeUrl(key), { method: "DELETE" });
                if (!response.ok && response.status !== 404 && response.status !== 410) {
                    ok = false;
                    Logger(`Could not delete WebDAV object ${key}: ${response.status}`, LOG_LEVEL_VERBOSE);
                }
            } catch (error) {
                ok = false;
                Logger(`Could not delete WebDAV object ${key}`, LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        }
        return ok;
    }

    async resetJournalStorage(): Promise<boolean> {
        let previousKeys: string | undefined;
        while (true) {
            const keys = await this.listFiles("");
            if (keys.length === 0) {
                invalidateJournalStorageRemoteFormatV1(this);
                return true;
            }
            const currentKeys = keys.join("\u001f");
            if (previousKeys !== undefined && currentKeys === previousKeys) return false;
            previousKeys = currentKeys;
            if (!(await this.deleteFiles(keys))) return false;
        }
    }

    async inspectRemoteFormat(): Promise<JournalStorageRemoteFormatV1> {
        const { keys } = await this.listedFiles();
        const repositoryKeys = keys.filter((key) => !key.startsWith(ADAPTIVE_PROBE_PREFIX));
        return classifyJournalStorageRemoteFormatV1(
            repositoryKeys.some((key) => key.startsWith("a1~")),
            repositoryKeys.some((key) => !key.startsWith("a1~"))
        );
    }

    private validateAdaptiveObjectKey(key: string): void {
        if (!/^a1~[A-Za-z0-9._~-]+$/u.test(key)) {
            throw new TypeError("Adaptive Journal WebDAV object keys must use the flat ASCII a1 namespace");
        }
    }

    private validateRange(range: AdaptiveJournalByteRangeV1): { end: number; header: string } {
        if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
            throw new RangeError("Adaptive Journal byte-range offset must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(range.length) || range.length < 1) {
            throw new RangeError("Adaptive Journal byte-range length must be a positive safe integer");
        }
        const end = range.offset + range.length - 1;
        if (!Number.isSafeInteger(end)) throw new RangeError("Adaptive Journal byte range exceeds safe integers");
        return { end, header: `bytes=${range.offset}-${end}` };
    }

    async readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>> {
        this.validateAdaptiveObjectKey(key);
        const validatedRange = range ? this.validateRange(range) : undefined;
        try {
            await this.ensureCollection();
            const response = await this.requestBytes(this.makeUrl(key), {
                headers: validatedRange ? { Range: validatedRange.header } : {},
                method: "GET",
            });
            if (response.status === 404 || response.status === 410) return { status: "missing" };
            if (!response.ok || !response.value) {
                return { status: "failed", failure: statusFailure(response.status, false) };
            }
            if (range) {
                const expectedContentRange = new RegExp(`^bytes ${range.offset}-${validatedRange!.end}/[0-9]+$`, "u");
                if (
                    response.status !== 206 ||
                    response.value.byteLength !== range.length ||
                    !response.contentRange ||
                    !expectedContentRange.test(response.contentRange)
                ) {
                    return { status: "failed", failure: { category: "invalid-response", retry: "never" } };
                }
            }
            return {
                ...(response.etag ? { identity: response.etag } : {}),
                status: "found",
                value: response.value,
            };
        } catch (error) {
            return { status: "failed", failure: webDAVRemoteFailure(error, false) };
        }
    }

    async createAdaptiveObject(key: string, bytes: Uint8Array, mime: string): Promise<ImmutableCreate> {
        this.validateAdaptiveObjectKey(key);
        try {
            await this.ensureCollection();
            const response = await this.requestStatus(this.makeUrl(key), {
                body: bytes as unknown as BodyInit,
                headers: {
                    "Content-Type": mime,
                    "If-None-Match": "*",
                },
                method: "PUT",
            });
            if (response.status === 412) return { status: "already-exists" };
            if (!response.ok) return { status: "failed", failure: statusFailure(response.status, true) };
            return { ...(response.etag ? { identity: response.etag } : {}), status: "created" };
        } catch (error) {
            return { status: "failed", failure: webDAVRemoteFailure(error, true) };
        }
    }

    private async listAllAdaptiveObjects(): Promise<AdaptiveJournalObjectListV1> {
        try {
            const { keys } = await this.listedFiles();
            return { keys: keys.filter((key) => key.startsWith("a1~")), status: "ok" };
        } catch (error) {
            return { status: "failed", failure: webDAVRemoteFailure(error, false) };
        }
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        this.validateAdaptiveObjectKey(prefix);
        const listed = await (this.adaptiveListingSnapshot ?? this.listAllAdaptiveObjects());
        return listed.status === "failed"
            ? listed
            : { keys: listed.keys.filter((key) => key.startsWith(prefix)), status: "ok" };
    }

    async runAdaptiveJournalReceivePhase<T>(task: () => Promise<T>): Promise<T> {
        if (this.receivePhaseDepth === 0) this.adaptiveListingSnapshot = this.listAllAdaptiveObjects();
        this.receivePhaseDepth += 1;
        try {
            return await task();
        } finally {
            this.receivePhaseDepth -= 1;
            if (this.receivePhaseDepth === 0) this.adaptiveListingSnapshot = undefined;
        }
    }

    async readManifest(): Promise<RemoteRead<Uint8Array>> {
        return await this.readAdaptiveObject(ADAPTIVE_MANIFEST_KEY);
    }

    async createManifest(bytes: Uint8Array): Promise<ImmutableCreate> {
        return await this.createAdaptiveObject(ADAPTIVE_MANIFEST_KEY, bytes, "application/json");
    }

    private makeCapabilityProbeKey(): string {
        const random = new Uint8Array(16);
        compatGlobal.crypto.getRandomValues(random);
        return `${ADAPTIVE_PROBE_PREFIX}${bytesToHex(random)}.bin`;
    }

    private async probeCapabilities(required: readonly string[]): Promise<CapabilityVerification> {
        return await probeAdaptiveJournalObjectCapabilitiesV1({
            makeProbeKey: () => this.makeCapabilityProbeKey(),
            remote: this,
            removeProbe: async (key) => await this.deleteFiles([key]),
            required,
        });
    }

    async verifyCapabilities(required: readonly string[]): Promise<CapabilityVerification> {
        const key = [...new Set(required)].sort().join("\u001f");
        let verification = this.capabilityVerifications.get(key);
        if (!verification) {
            verification = this.probeCapabilities([...new Set(required)]);
            this.capabilityVerifications.set(key, verification);
        }
        try {
            const result = await verification;
            if (result.status === "failed" && this.capabilityVerifications.get(key) === verification) {
                this.capabilityVerifications.delete(key);
            }
            return result;
        } catch (error) {
            if (this.capabilityVerifications.get(key) === verification) this.capabilityVerifications.delete(key);
            throw error;
        }
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.ensureCollection();
            await this.propfind(false);
            return true;
        } catch (error) {
            Logger("Could not connect to the WebDAV collection", LOG_LEVEL_NOTICE);
            Logger(error, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async getUsage(): Promise<false | RemoteDBStatus> {
        try {
            const { entries } = await this.listedFiles(true);
            const root = entries.find((entry) => entry.isCollection && this.keyFromHref(entry.href) === false);
            return {
                estimatedSize: entries.reduce(
                    (total, entry) => total + (entry.isCollection ? 0 : (entry.contentLength ?? 0)),
                    0
                ),
                ...(root?.quotaAvailableBytes === undefined
                    ? {}
                    : { webDAVQuotaAvailableBytes: root.quotaAvailableBytes }),
                ...(root?.quotaUsedBytes === undefined ? {} : { webDAVQuotaUsedBytes: root.quotaUsedBytes }),
            };
        } catch (error) {
            Logger("Could not get status of the WebDAV collection", LOG_LEVEL_NOTICE);
            Logger(error, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
}
