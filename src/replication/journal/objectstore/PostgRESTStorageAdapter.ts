import { Logger } from "@lib/common/logger.ts";
import { LOG_LEVEL_VERBOSE, type PostgRESTSyncSetting } from "@lib/common/types.ts";
import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { runWithTrackedPhysicalRequest } from "@lib/services/lib/remoteActivity.ts";
import {
    AdaptiveBatchOperationV1,
    DEFAULT_ADAPTIVE_BATCH_LIMITS_V1,
    decodeBatchResponseV1,
    encodeBatchRequestV1,
} from "../adaptive/AdaptiveJournalBatch.ts";
import {
    base64UrlToBytes,
    bytesEqual,
    bytesToBase64Url,
    decodeUtf8,
    fixedLength,
} from "../adaptive/AdaptiveJournalBinary.ts";
import type {
    AdaptiveChunkGetResultV1,
    AdaptiveChunkPutResultV1,
    AdaptiveJournalChunkStoreV1,
    StoredChunkRecordV1,
} from "../adaptive/AdaptiveJournalChunkStore.ts";
import type {
    AdaptiveJournalCommitSequenceListResultV1,
    AdaptiveJournalWriterListResultV1,
} from "../adaptive/AdaptiveJournalDiscoveryStore.ts";
import type {
    AdaptiveImmutableRecordResultV1,
    AdaptiveImmutableRecordStatusV1,
} from "../adaptive/AdaptiveJournalEventStore.ts";
import { AdaptiveJournalError, sha256 } from "../adaptive/AdaptiveJournalManifest.ts";
import type {
    AdaptiveJournalNativeEventRemoteV1,
    AdaptiveJournalNativeStorageV1,
    AdaptiveJournalNativeStoresV1,
} from "../adaptive/AdaptiveJournalNativeStore.ts";
import type {
    AdaptiveJournalManifestRemoteV1,
    CapabilityVerification,
    ImmutableCreate,
    RemoteFailure,
    RemoteRead,
} from "../adaptive/AdaptiveJournalRepository.ts";
import {
    invalidateJournalStorageRemoteFormatV1,
    type IJournalStorage,
    type JournalStorageRemoteFormatV1,
    type JournalStorageSetting,
} from "./JournalStorageAdapter.ts";
import { parsePostgRESTConnectionURI, type PostgRESTConnection } from "./JournalStorageConnection.ts";

const COMMIT_LIST_PAGE_SIZE = 1_000;
const MAX_SEQUENCE = 0x7fffffffffffffffn;
const BINARY_PROBE = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
const PREFERRED_CHUNK_PUT_REQUEST_BYTES = 32 * 1024 * 1024;
const BATCH_HEADER_BYTES = 20;
const PUT_ENTRY_HEADER_BYTES = 72;

type BinaryResult =
    | { bytes: Uint8Array; status: "ok" }
    | { failure: RemoteFailure; httpStatus?: number; status: "failed" };
type JsonResult = { status: "ok"; value: unknown } | { failure: RemoteFailure; status: "failed" };

function postgrestSettings(settings: JournalStorageSetting): PostgRESTSyncSetting {
    if (!("postgrestActiveConnectionURI" in settings)) throw new Error("PostgREST settings are required");
    return settings;
}

function remoteFailure(status: number | undefined, mutation: boolean): RemoteFailure {
    if (status === undefined) return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
    if (status === 401) return { category: "authentication", retry: "never" };
    if (status === 403) return { category: "permission", retry: "never" };
    if (status === 429) return { category: "rate-limited", retry: "later" };
    if (status >= 500) return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
    return { category: "invalid-response", retry: "never" };
}

function invalidResponse(mutation = false): { failure: RemoteFailure; status: "failed" } {
    return {
        failure: { category: "invalid-response", retry: mutation ? "verify-first" : "never" },
        status: "failed",
    };
}

function binaryFailure(result: Extract<BinaryResult, { status: "failed" }>): {
    failure: RemoteFailure;
    status: "failed";
} {
    return { failure: result.failure, status: "failed" };
}

function partitionChunkPuts(chunks: readonly StoredChunkRecordV1[]): readonly StoredChunkRecordV1[][] {
    const batches: StoredChunkRecordV1[][] = [];
    let batch: StoredChunkRecordV1[] = [];
    let batchBytes = BATCH_HEADER_BYTES;
    for (const chunk of chunks) {
        const entryBytes = PUT_ENTRY_HEADER_BYTES + chunk.frame.byteLength;
        if (BATCH_HEADER_BYTES + entryBytes > DEFAULT_ADAPTIVE_BATCH_LIMITS_V1.maxBytes) {
            throw new Error("A Chunk frame exceeds the PostgREST binary request limit");
        }
        if (
            batch.length > 0 &&
            (batch.length >= DEFAULT_ADAPTIVE_BATCH_LIMITS_V1.maxEntries ||
                batchBytes + entryBytes > PREFERRED_CHUNK_PUT_REQUEST_BYTES)
        ) {
            batches.push(batch);
            batch = [];
            batchBytes = BATCH_HEADER_BYTES;
        }
        batch.push(chunk);
        batchBytes += entryBytes;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
}

function connectionIdentity(connection: PostgRESTConnection): string {
    return JSON.stringify({
        endpoint: connection.endpoint.replace(/\/+$/gu, ""),
        schema: connection.schema,
        vaultId: connection.vaultId,
    });
}

function assertClientSafeApiKey(apiKey: string): void {
    if (apiKey.startsWith("sb_secret_")) {
        throw new Error("PostgREST profiles must not contain a Supabase secret API key");
    }
    const parts = apiKey.split(".");
    if (parts.length !== 3) return;
    try {
        const payload = JSON.parse(decodeUtf8(base64UrlToBytes(parts[1]))) as { role?: unknown };
        if (payload.role === "service_role" || payload.role === "supabase_admin") {
            throw new Error("PostgREST profiles must not contain a privileged Supabase JWT");
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes("must not contain")) throw error;
        // A non-JWT API key is still valid for generic PostgREST gateways.
    }
}

async function discardResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Response disposal is best effort after the status has already been observed.
    }
}

export class PostgRESTStorageAdapter
    implements IJournalStorage, AdaptiveJournalManifestRemoteV1, AdaptiveJournalNativeStorageV1
{
    readonly adaptiveJournalStorageStrategy = "native" as const;
    readonly kind = "postgrest" as const;
    private capabilityVerifications = new Map<string, Promise<CapabilityVerification>>();
    private _settings: PostgRESTSyncSetting;

    constructor(
        settings: JournalStorageSetting,
        private _env: LiveSyncJournalReplicatorEnv
    ) {
        this._settings = postgrestSettings(settings);
    }

    applyNewConfig(settings: JournalStorageSetting): void {
        const next = postgrestSettings(settings);
        if (next.postgrestActiveConnectionURI !== this._settings.postgrestActiveConnectionURI) {
            this.capabilityVerifications.clear();
            invalidateJournalStorageRemoteFormatV1(this);
        }
        this._settings = next;
    }

    get connection(): PostgRESTConnection {
        const connection = parsePostgRESTConnectionURI(this._settings.postgrestActiveConnectionURI);
        if (!connection.vaultId || !connection.vaultCredential) {
            throw new Error("PostgREST requires a Vault ID and Vault credential");
        }
        assertClientSafeApiKey(connection.apiKey);
        return connection;
    }

    get storageIdentity(): string {
        return `postgrest:${connectionIdentity(this.connection)}`;
    }

    private rpcUrl(functionName: string): string {
        return `${this.connection.endpoint.replace(/\/+$/gu, "")}/rpc/${functionName}`;
    }

    private requestHeaders(init: RequestInit): Record<string, string> {
        const connection = this.connection;
        const headers = new Headers({
            "Accept-Profile": connection.schema,
            "Content-Profile": connection.schema,
            "X-LiveSync-Vault-Credential": connection.vaultCredential,
            "X-LiveSync-Vault-ID": connection.vaultId,
        });
        if (connection.apiKey) headers.set("apikey", connection.apiKey);
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        return Object.fromEntries(headers.entries());
    }

    private async runTrackedRequest<T>(task: () => T | PromiseLike<T>): Promise<T> {
        return await runWithTrackedPhysicalRequest(this._env.services.API, task);
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
                Logger("Could not use native fetch for PostgREST. Falling back to web fetch.", LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        }
        return await this.runTrackedRequest(async () => {
            const response = await this._env.services.API.webCompatFetch(url, requestInit);
            return await consume(response);
        });
    }

    private async jsonRequest(url: string, init: RequestInit, mutation = false): Promise<JsonResult> {
        try {
            return await this.request(
                url,
                { ...init, headers: { Accept: "application/json", ...Object.fromEntries(new Headers(init.headers)) } },
                async (response): Promise<JsonResult> => {
                    if (!response.ok) {
                        await discardResponseBody(response);
                        return { failure: remoteFailure(response.status, mutation), status: "failed" };
                    }
                    try {
                        return { status: "ok", value: await response.json() };
                    } catch {
                        return invalidResponse(mutation);
                    }
                }
            );
        } catch {
            return { failure: remoteFailure(undefined, mutation), status: "failed" };
        }
    }

    private async readBinary(url: string, headers: Record<string, string> = {}): Promise<RemoteRead<Uint8Array>> {
        try {
            return await this.request(
                url,
                {
                    headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache", ...headers },
                    method: "GET",
                },
                async (response): Promise<RemoteRead<Uint8Array>> => {
                    if (response.status === 404) {
                        await discardResponseBody(response);
                        return { status: "missing" };
                    }
                    if (!response.ok) {
                        await discardResponseBody(response);
                        return { failure: remoteFailure(response.status, false), status: "failed" };
                    }
                    return { status: "found", value: new Uint8Array(await response.arrayBuffer()) };
                }
            );
        } catch {
            return { failure: remoteFailure(undefined, false), status: "failed" };
        }
    }

    private adaptiveOnly(): never {
        throw new Error("PostgREST Journal storage supports only the Adaptive format");
    }

    async upload(_key: string, _data: Uint8Array, _mime: string): Promise<boolean> {
        return this.adaptiveOnly();
    }

    async download(_key: string, _ignoreCache = false): Promise<Uint8Array | false> {
        return this.adaptiveOnly();
    }

    async listFiles(_from: string, _limit?: number): Promise<string[]> {
        return this.adaptiveOnly();
    }

    async deleteFiles(_keys: string[]): Promise<boolean> {
        return this.adaptiveOnly();
    }

    async inspectRemoteFormat(): Promise<JournalStorageRemoteFormatV1> {
        const manifest = await this.readManifest();
        if (manifest.status === "failed") {
            throw new AdaptiveJournalError(
                "remote-operation-failed",
                `Could not inspect the Adaptive Journal manifest: ${manifest.failure.category}`
            );
        }
        return manifest.status === "found" ? "adaptive-v1" : "empty";
    }

    async readManifest(): Promise<RemoteRead<Uint8Array>> {
        return await this.readBinary(this.rpcUrl("livesync_adaptive_manifest_get"));
    }

    async createManifest(bytes: Uint8Array): Promise<ImmutableCreate> {
        const result = await this.jsonRequest(
            this.rpcUrl("livesync_adaptive_manifest_create"),
            { body: bytes as BodyInit, headers: { "Content-Type": "application/octet-stream" }, method: "POST" },
            true
        );
        if (result.status === "failed") return result;
        if (result.value === 0) return { status: "created" };
        if (result.value === 1) return { status: "already-exists" };
        return invalidResponse(true);
    }

    private async inspectCapabilities(): Promise<CapabilityVerification & { available?: readonly string[] }> {
        const result = await this.jsonRequest(this.rpcUrl("livesync_adaptive_capabilities"), { method: "GET" });
        if (result.status === "failed") return result;
        const body = Array.isArray(result.value) && result.value.length === 1 ? result.value[0] : result.value;
        if (!body || typeof body !== "object" || Array.isArray(body)) return invalidResponse();
        const record = body as { capabilities?: unknown; format_version?: unknown };
        if (
            record.format_version !== 1 ||
            !Array.isArray(record.capabilities) ||
            !record.capabilities.every((entry): entry is string => typeof entry === "string")
        ) {
            return invalidResponse();
        }
        const echo = await this.binaryRpc("livesync_adaptive_binary_echo", BINARY_PROBE, false);
        if (echo.status === "failed") return binaryFailure(echo);
        return bytesEqual(echo.bytes, BINARY_PROBE)
            ? { available: record.capabilities, status: "verified" }
            : invalidResponse();
    }

    async verifyCapabilities(required: readonly string[]): Promise<CapabilityVerification> {
        const key = [...new Set(required)].sort().join("\u001f");
        let pending = this.capabilityVerifications.get(key);
        if (!pending) {
            pending = (async () => {
                const inspection = await this.inspectCapabilities();
                if (inspection.status === "failed") return inspection;
                const available = new Set(inspection.available ?? []);
                const missing = required.filter((capability) => !available.has(capability));
                return missing.length === 0
                    ? ({ status: "verified" } as const)
                    : ({ missing, status: "unsupported" } as const);
            })();
            this.capabilityVerifications.set(key, pending);
        }
        const result = await pending;
        if (result.status === "failed" && this.capabilityVerifications.get(key) === pending) {
            this.capabilityVerifications.delete(key);
        }
        return result;
    }

    private async binaryRpc(
        functionName: string,
        body: Uint8Array,
        mutation: boolean,
        headers: Record<string, string> = {}
    ): Promise<BinaryResult> {
        try {
            return await this.request(
                this.rpcUrl(functionName),
                {
                    body: body as BodyInit,
                    headers: {
                        Accept: "application/octet-stream",
                        "Content-Type": "application/octet-stream",
                        ...headers,
                    },
                    method: "POST",
                },
                async (response): Promise<BinaryResult> => {
                    if (!response.ok) {
                        await discardResponseBody(response);
                        return {
                            failure: remoteFailure(response.status, mutation),
                            httpStatus: response.status,
                            status: "failed",
                        };
                    }
                    return { bytes: new Uint8Array(await response.arrayBuffer()), status: "ok" };
                }
            );
        } catch {
            return { failure: remoteFailure(undefined, mutation), status: "failed" };
        }
    }

    private repositoryHeaders(repositoryId: Uint8Array): Record<string, string> {
        return { "X-LiveSync-Repository-ID": bytesToBase64Url(fixedLength(repositoryId, 32, "repositoryId")) };
    }

    private createChunkStore(repositoryIdSource: Uint8Array): AdaptiveJournalChunkStoreV1 {
        const repositoryId = fixedLength(repositoryIdSource.slice(), 32, "repositoryId");
        return {
            capabilities: {
                atomicBatchWrite: false,
                nativeMultiKeyLookup: true,
                serverSideImmutableCreate: true,
            },
            getMany: async (keys) => {
                const readBatch = async (batchKeys: readonly Uint8Array[]): Promise<AdaptiveChunkGetResultV1> => {
                    const request = encodeBatchRequestV1({
                        entries: batchKeys.map((key) => ({ key })),
                        operation: AdaptiveBatchOperationV1.Get,
                    });
                    const rpc = await this.binaryRpc(
                        "livesync_adaptive_chunks",
                        request,
                        false,
                        this.repositoryHeaders(repositoryId)
                    );
                    if (rpc.status === "failed") {
                        if (rpc.httpStatus === 413 && batchKeys.length > 1) {
                            const split = Math.ceil(batchKeys.length / 2);
                            const left = await readBatch(batchKeys.slice(0, split));
                            if (left.status === "failed") return left;
                            const right = await readBatch(batchKeys.slice(split));
                            return right.status === "failed"
                                ? right
                                : { chunks: [...left.chunks, ...right.chunks], status: "ok" };
                        }
                        return binaryFailure(rpc);
                    }
                    try {
                        const response = decodeBatchResponseV1(rpc.bytes);
                        if (
                            response.operation !== AdaptiveBatchOperationV1.Get ||
                            response.entries.length !== batchKeys.length
                        ) {
                            return invalidResponse();
                        }
                        const chunks = await Promise.all(
                            response.entries.map(async (entry, index) => {
                                if (entry.status === "missing") return undefined;
                                if (!bytesEqual(await sha256(entry.frame), entry.frameDigest)) {
                                    throw new Error("Chunk frame digest mismatch");
                                }
                                return {
                                    frame: entry.frame,
                                    frameDigest: entry.frameDigest,
                                    key: fixedLength(batchKeys[index], 32, "remote Chunk key").slice(),
                                };
                            })
                        );
                        return { chunks, status: "ok" };
                    } catch {
                        return invalidResponse();
                    }
                };
                return keys.length === 0 ? { chunks: [], status: "ok" } : await readBatch(keys);
            },
            hasMany: async (keys) => {
                if (keys.length === 0) return { availability: [], status: "ok" };
                const request = encodeBatchRequestV1({
                    entries: keys.map((key) => ({ key })),
                    operation: AdaptiveBatchOperationV1.Has,
                });
                const rpc = await this.binaryRpc(
                    "livesync_adaptive_chunks",
                    request,
                    false,
                    this.repositoryHeaders(repositoryId)
                );
                if (rpc.status === "failed") return binaryFailure(rpc);
                try {
                    const response = decodeBatchResponseV1(rpc.bytes);
                    if (
                        response.operation !== AdaptiveBatchOperationV1.Has ||
                        response.entries.length !== keys.length
                    ) {
                        return invalidResponse();
                    }
                    return {
                        availability: response.entries.map(({ status }) => status === "present"),
                        status: "ok",
                    };
                } catch {
                    return invalidResponse();
                }
            },
            putMany: async (chunks) => {
                if (chunks.length === 0) return { results: [], status: "ok" };
                for (const chunk of chunks) {
                    if (!bytesEqual(await sha256(chunk.frame), chunk.frameDigest)) return invalidResponse();
                }
                try {
                    const results: AdaptiveImmutableRecordStatusV1[] = [];
                    const putBatch = async (
                        batch: readonly StoredChunkRecordV1[]
                    ): Promise<AdaptiveChunkPutResultV1> => {
                        const request = encodeBatchRequestV1({
                            entries: batch.map(({ frame, frameDigest, key }) => ({ frame, frameDigest, key })),
                            operation: AdaptiveBatchOperationV1.Put,
                        });
                        const rpc = await this.binaryRpc(
                            "livesync_adaptive_chunks",
                            request,
                            true,
                            this.repositoryHeaders(repositoryId)
                        );
                        if (rpc.status === "failed") {
                            if (rpc.httpStatus === 413 && batch.length > 1) {
                                const split = Math.ceil(batch.length / 2);
                                const left = await putBatch(batch.slice(0, split));
                                if (left.status === "failed") return left;
                                const right = await putBatch(batch.slice(split));
                                return right.status === "failed"
                                    ? right
                                    : { results: [...left.results, ...right.results], status: "ok" };
                            }
                            return binaryFailure(rpc);
                        }
                        const response = decodeBatchResponseV1(rpc.bytes);
                        if (
                            response.operation !== AdaptiveBatchOperationV1.Put ||
                            response.entries.length !== batch.length
                        ) {
                            return invalidResponse(true);
                        }
                        return { results: response.entries.map(({ status }) => status), status: "ok" };
                    };
                    const batches = partitionChunkPuts(chunks);
                    for (const batch of batches) {
                        const response = await putBatch(batch);
                        if (response.status === "failed") return response;
                        results.push(...response.results);
                    }
                    return { results, status: "ok" };
                } catch {
                    return invalidResponse(true);
                }
            },
        };
    }

    private writerHeaders(writerStreamId: Uint8Array): Record<string, string> {
        return {
            "X-LiveSync-Writer-Stream-ID": bytesToBase64Url(fixedLength(writerStreamId, 32, "writerStreamId")),
        };
    }

    private sequenceText(sequence: bigint, allowZero = false): string {
        if (sequence < (allowZero ? 0n : 1n) || sequence > MAX_SEQUENCE) {
            throw new Error("Adaptive Journal writer sequence is outside the supported range");
        }
        return sequence.toString(10);
    }

    private async immutableRpc(
        functionName: "livesync_adaptive_commit_create" | "livesync_adaptive_writer_create",
        repositoryId: Uint8Array,
        body: Uint8Array,
        headers: Record<string, string> = {}
    ): Promise<AdaptiveImmutableRecordResultV1> {
        const response = await this.jsonRequest(
            this.rpcUrl(functionName),
            {
                body: body as BodyInit,
                headers: {
                    "Content-Type": "application/octet-stream",
                    ...this.repositoryHeaders(repositoryId),
                    ...headers,
                },
                method: "POST",
            },
            true
        );
        if (response.status === "failed") return response;
        const statuses: readonly AdaptiveImmutableRecordStatusV1[] = [
            "inserted",
            "exact-existing",
            "validate-existing",
        ];
        return typeof response.value === "number" && statuses[response.value]
            ? { result: statuses[response.value], status: "ok" }
            : invalidResponse(true);
    }

    private async readNativeRecord(
        functionName: "livesync_adaptive_commit_get" | "livesync_adaptive_writer_get",
        repositoryId: Uint8Array,
        writerStreamId: Uint8Array,
        sequence?: bigint
    ): Promise<RemoteRead<Uint8Array>> {
        return await this.readBinary(this.rpcUrl(functionName), {
            ...this.repositoryHeaders(repositoryId),
            ...this.writerHeaders(writerStreamId),
            ...(sequence === undefined ? {} : { "X-LiveSync-Sequence": this.sequenceText(sequence) }),
        });
    }

    private async listWriters(repositoryId: Uint8Array): Promise<AdaptiveJournalWriterListResultV1> {
        const response = await this.jsonRequest(this.rpcUrl("livesync_adaptive_writer_list"), {
            headers: this.repositoryHeaders(repositoryId),
            method: "GET",
        });
        if (response.status === "failed") return response;
        if (!Array.isArray(response.value)) return invalidResponse();
        try {
            return {
                status: "ok",
                writerStreamIds: response.value.map((value) => {
                    if (typeof value !== "string") throw new Error("Writer ID is not text");
                    return fixedLength(base64UrlToBytes(value), 32, "writerStreamId");
                }),
            };
        } catch {
            return invalidResponse();
        }
    }

    private async listCommitPage(
        repositoryId: Uint8Array,
        writerStreamId: Uint8Array,
        afterSequence: bigint
    ): Promise<AdaptiveJournalCommitSequenceListResultV1> {
        const url = new URL(this.rpcUrl("livesync_adaptive_commit_list"));
        url.searchParams.set("after_sequence", this.sequenceText(afterSequence, true));
        url.searchParams.set("max_rows", COMMIT_LIST_PAGE_SIZE.toString(10));
        const response = await this.jsonRequest(url.toString(), {
            headers: { ...this.repositoryHeaders(repositoryId), ...this.writerHeaders(writerStreamId) },
            method: "GET",
        });
        if (response.status === "failed") return response;
        if (!Array.isArray(response.value)) return invalidResponse();
        try {
            const sequences = response.value.map((value) => {
                if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) {
                    throw new Error("Commit sequence is invalid");
                }
                return BigInt(value);
            });
            return { sequences, status: "ok" };
        } catch {
            return invalidResponse();
        }
    }

    private createEventRemote(repositoryIdSource: Uint8Array): AdaptiveJournalNativeEventRemoteV1 {
        const repositoryId = fixedLength(repositoryIdSource.slice(), 32, "repositoryId");
        return {
            commitMetadataBatch: async (envelope) =>
                await this.immutableRpc("livesync_adaptive_commit_create", repositoryId, envelope),
            listCommitSequences: async (writerStreamId, afterSequence) => {
                if (afterSequence < 0n || afterSequence > MAX_SEQUENCE) return invalidResponse();
                const sequences: bigint[] = [];
                let cursor = afterSequence;
                while (true) {
                    const page = await this.listCommitPage(repositoryId, writerStreamId, cursor);
                    if (page.status === "failed") return page;
                    for (const sequence of page.sequences) {
                        if (sequence <= cursor || (sequences.length > 0 && sequence <= sequences.at(-1)!)) {
                            return invalidResponse();
                        }
                        sequences.push(sequence);
                    }
                    if (page.sequences.length < COMMIT_LIST_PAGE_SIZE) return { sequences, status: "ok" };
                    cursor = page.sequences.at(-1)!;
                }
            },
            listWriterStreamIds: async () => await this.listWriters(repositoryId),
            readCommitBundle: async (writerStreamId, sequence) =>
                await this.readNativeRecord("livesync_adaptive_commit_get", repositoryId, writerStreamId, sequence),
            readWriter: async (writerStreamId) =>
                await this.readNativeRecord("livesync_adaptive_writer_get", repositoryId, writerStreamId),
            registerWriter: async (record) =>
                await this.immutableRpc(
                    "livesync_adaptive_writer_create",
                    repositoryId,
                    record.descriptorFrame,
                    this.writerHeaders(record.writerStreamId)
                ),
        };
    }

    createAdaptiveJournalNativeStores(repositoryId: Uint8Array): AdaptiveJournalNativeStoresV1 {
        return {
            chunks: this.createChunkStore(repositoryId),
            events: this.createEventRemote(repositoryId),
        };
    }

    async resetJournalStorage(): Promise<boolean> {
        const response = await this.jsonRequest(
            this.rpcUrl("livesync_adaptive_reset"),
            { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" },
            true
        );
        const reset =
            response.status === "ok" &&
            typeof response.value === "number" &&
            Number.isSafeInteger(response.value) &&
            response.value >= 0;
        if (reset) invalidateJournalStorageRemoteFormatV1(this);
        return reset;
    }

    private async status(): Promise<{ estimatedSize: number } | false> {
        const response = await this.jsonRequest(this.rpcUrl("livesync_adaptive_status"), { method: "GET" });
        if (response.status === "failed") return false;
        const body = Array.isArray(response.value) && response.value.length === 1 ? response.value[0] : response.value;
        const estimatedSize = Number(
            body && typeof body === "object" && !Array.isArray(body)
                ? (body as { estimated_size?: unknown }).estimated_size
                : Number.NaN
        );
        return Number.isFinite(estimatedSize) && estimatedSize >= 0 ? { estimatedSize } : false;
    }

    async isAvailable(): Promise<boolean> {
        return (await this.status()) !== false;
    }

    async getUsage(): Promise<false | RemoteDBStatus> {
        return await this.status();
    }
}
