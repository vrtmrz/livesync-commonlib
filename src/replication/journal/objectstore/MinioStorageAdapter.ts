import {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3,
    type ServiceInputTypes,
} from "@aws-sdk/client-s3";
import { applyMd5BodyChecksumMiddleware } from "@smithy/middleware-apply-body-checksum";
import { Md5 } from "@smithy/md5-js";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import type { FinalizeHandlerArguments, SourceData } from "@smithy/types";
import { promiseWithResolvers } from "octagonal-wheels/promises";

import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type BucketSyncSetting } from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import { bytesEqual, bytesToHex } from "../adaptive/AdaptiveJournalBinary.ts";
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
import {
    classifyJournalStorageRemoteFormatV1,
    type IJournalStorage,
    type JournalStorageRemoteFormatV1,
    type JournalStorageSetting,
} from "./JournalStorageAdapter.ts";
import { parseHeaderValues } from "@lib/common/utils.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { runWithTrackedPhysicalRequest } from "@lib/services/lib/remoteActivity.ts";

const ADAPTIVE_MANIFEST_KEY = "a1~manifest.json";
const ADAPTIVE_PROBE_PREFIX = "a1~probe~";
const ADAPTIVE_PROBE_SENTINEL = `${ADAPTIVE_PROBE_PREFIX}\u007f`;
const ADAPTIVE_CAPABILITIES = new Set([
    "binary-fidelity",
    "byte-range",
    "complete-listing",
    "conditional-create",
    "delete-visibility",
    "read-after-write",
]);

type S3ErrorLike = {
    $metadata?: { httpStatusCode?: number };
    name?: string;
};

function s3Error(error: unknown): S3ErrorLike {
    return typeof error === "object" && error !== null ? (error as S3ErrorLike) : {};
}

function s3Status(error: unknown): number | undefined {
    return s3Error(error).$metadata?.httpStatusCode;
}

function isS3Missing(error: unknown): boolean {
    const value = s3Error(error);
    return s3Status(error) === 404 || value.name === "NoSuchKey" || value.name === "NotFound";
}

function isS3PreconditionFailed(error: unknown): boolean {
    const value = s3Error(error);
    return s3Status(error) === 412 || value.name === "PreconditionFailed";
}

function adaptiveRemoteFailure(error: unknown, mutation: boolean): RemoteFailure {
    const status = s3Status(error);
    if (status === 401) return { category: "authentication", retry: "never" };
    if (status === 403) return { category: "permission", retry: "never" };
    if (status === 429) return { category: "rate-limited", retry: "later" };
    if (mutation && (status === 409 || s3Error(error).name === "ConditionalRequestConflict")) {
        return { category: "unavailable", retry: "later" };
    }
    if (status !== undefined && status >= 500) {
        return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
    }
    if (status === undefined) {
        return { category: "unavailable", retry: mutation ? "verify-first" : "later" };
    }
    return { category: "invalid-response", retry: "never" };
}

function sameS3Connection(left: BucketSyncSetting, right: BucketSyncSetting): boolean {
    return (
        left.accessKey === right.accessKey &&
        left.secretKey === right.secretKey &&
        left.endpoint === right.endpoint &&
        left.bucket === right.bucket &&
        left.region === right.region &&
        left.bucketPrefix === right.bucketPrefix &&
        left.forcePathStyle === right.forcePathStyle &&
        left.useCustomRequestHandler === right.useCustomRequestHandler &&
        left.bucketCustomHeaders === right.bucketCustomHeaders
    );
}

export class MinioStorageAdapter
    implements IJournalStorage, AdaptiveJournalManifestRemoteV1, AdaptiveJournalObjectRemoteV1
{
    readonly kind = "s3" as const;
    _instance?: S3;
    _settings: BucketSyncSetting;
    _env: LiveSyncJournalReplicatorEnv;
    private capabilityVerifications = new Map<string, Promise<CapabilityVerification>>();

    constructor(settings: JournalStorageSetting, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings as BucketSyncSetting;
        this._env = env;
    }

    private async runTrackedRequest<T>(task: () => T | PromiseLike<T>): Promise<T> {
        return await runWithTrackedPhysicalRequest(this._env.services.API, task);
    }

    applyNewConfig(settings: JournalStorageSetting): void {
        const next = settings as BucketSyncSetting;
        if (!sameS3Connection(this._settings, next)) {
            this._instance = undefined;
            this.capabilityVerifications.clear();
        }
        this._settings = next;
    }

    get storageIdentity(): string {
        const endpoint = this._settings.endpoint.replace(/\/+$/gu, "");
        return `s3:${JSON.stringify({
            bucket: this._settings.bucket,
            endpoint,
            prefix: this._settings.bucketPrefix,
            region: this._settings.region,
        })}`;
    }

    get customHeaders(): [string, string][] {
        return this._settings.bucketCustomHeaders.length == 0
            ? []
            : Object.entries(parseHeaderValues(this._settings.bucketCustomHeaders));
    }

    _getClient(): S3 {
        if (this._instance) return this._instance;

        const ep = this._settings.endpoint
            ? {
                  endpoint: this._settings.endpoint,
                  forcePathStyle: this._settings.forcePathStyle,
              }
            : {};

        this._instance = new S3({
            region: this._settings.region,
            ...ep,
            credentials: {
                accessKeyId: this._settings.accessKey,
                secretAccessKey: this._settings.secretKey,
            },
            maxAttempts: 4,
            retryStrategy: new ConfiguredRetryStrategy(4, (attempt: number) => 100 + attempt * 1000),
            requestHandler: this._settings.useCustomRequestHandler
                ? this._env.services.API.getCustomFetchHandler()
                : undefined,
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        });

        const bucketCustomHeaders = this.customHeaders;
        this._instance.middlewareStack.add(
            (next, context) => (args: FinalizeHandlerArguments<ServiceInputTypes>) => {
                bucketCustomHeaders.forEach(([key, value]) => {
                    if (key && value) {
                        (args.request as { headers: Record<string, string> }).headers[key] = value;
                    }
                });
                return next(args);
            },
            {
                name: "addBucketCustomHeadersMiddleware",
                step: "finalizeRequest",
                priority: "low",
            }
        );

        const arrayBufferToBase64Sync = (buffer: ArrayBufferLike) => {
            return btoa(String.fromCharCode(...new Uint8Array(buffer)));
        };

        this._instance.middlewareStack.add(
            applyMd5BodyChecksumMiddleware({
                md5: Md5,
                base64Encoder: (data: Uint8Array) => arrayBufferToBase64Sync(data.buffer),
                streamHasher: (hashConstructor, stream) => {
                    const result = promiseWithResolvers<Uint8Array>();
                    const hash = new hashConstructor();
                    stream.on("data", (chunk: SourceData) => {
                        hash.update(chunk);
                    });
                    stream.on("end", () => {
                        result.resolve(hash.digest());
                    });
                    return result.promise;
                },
            }),
            {
                step: "build",
                name: "applyMd5BodyChecksumMiddlewareForDeleteObjects",
            }
        );

        return this._instance;
    }

    async upload(key: string, data: Uint8Array, mime: string): Promise<boolean> {
        try {
            const client = this._getClient();
            const cmd = new PutObjectCommand({
                Bucket: this._settings.bucket,
                Key: `${this._settings.bucketPrefix}${key}`,
                Body: data,
                ContentType: mime,
            });
            if (await this.runTrackedRequest(() => client.send(cmd))) {
                return true;
            }
        } catch (ex) {
            Logger(`Could not upload ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
        return false;
    }

    async download(key: string, ignoreCache: boolean = false): Promise<Uint8Array | false> {
        const client = this._getClient();
        const cmd = new GetObjectCommand({
            Bucket: this._settings.bucket,
            Key: `${this._settings.bucketPrefix}${key}`,
            ...(ignoreCache ? { ResponseCacheControl: "no-cache" } : {}),
        });

        try {
            return await this.runTrackedRequest(async () => {
                const r = await client.send(cmd);
                if (r.Body) {
                    return new Uint8Array(await r.Body.transformToByteArray());
                }
                return false;
            });
        } catch (ex) {
            Logger(`Could not download ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
        return false;
    }

    async listFiles(from: string, limit?: number): Promise<string[]> {
        return await this.listObjectKeys("", from, limit);
    }

    private async listObjectKeys(prefix: string, from = "", limit?: number): Promise<string[]> {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
            throw new RangeError("S3 Journal listing limit must be a non-negative safe integer");
        }
        if (limit === 0) return [];
        const client = this._getClient();
        const rootPrefix = this._settings.bucketPrefix;
        const objectPrefix = `${rootPrefix}${prefix}`;
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
            const remaining = limit === undefined ? undefined : limit - keys.length;
            const objects = await this.runTrackedRequest(() =>
                client.listObjectsV2({
                    Bucket: this._settings.bucket,
                    Prefix: objectPrefix,
                    ...(continuationToken
                        ? { ContinuationToken: continuationToken }
                        : { StartAfter: `${rootPrefix}${from}` }),
                    ...(remaining === undefined ? {} : { MaxKeys: Math.min(remaining, 1000) }),
                })
            );
            for (const object of objects.Contents ?? []) {
                const objectKey = object.Key;
                if (!objectKey?.startsWith(rootPrefix)) continue;
                const key = objectKey.substring(rootPrefix.length);
                if (!key.startsWith(prefix) || (from && key <= from)) continue;
                keys.push(key);
                if (limit !== undefined && keys.length >= limit) break;
            }
            if ((limit !== undefined && keys.length >= limit) || !objects.IsTruncated) break;
            const next = objects.NextContinuationToken;
            if (!next || next === continuationToken) {
                throw new Error("S3 Journal listing did not advance its continuation token");
            }
            continuationToken = next;
        } while (true);
        return keys.sort();
    }

    private async firstObjectKeyIgnoringCapabilityProbes(prefix: string, from = ""): Promise<string | undefined> {
        const first = (await this.listObjectKeys(prefix, from, 1))[0];
        if (!first?.startsWith(ADAPTIVE_PROBE_PREFIX)) return first;
        return (await this.listObjectKeys(prefix, ADAPTIVE_PROBE_SENTINEL, 1))[0];
    }

    async inspectRemoteFormat(): Promise<JournalStorageRemoteFormatV1> {
        const first = await this.firstObjectKeyIgnoringCapabilityProbes("");
        if (first === undefined) return "empty";
        const firstIsAdaptive = first.startsWith("a1~");
        const hasAdaptive = firstIsAdaptive || (await this.firstObjectKeyIgnoringCapabilityProbes("a1~")) !== undefined;
        const hasOpaqueBeforeAdaptive = !firstIsAdaptive;
        const hasOpaqueAfterAdaptive = firstIsAdaptive && (await this.listObjectKeys("", "a1~\u007f", 1)).length > 0;
        return classifyJournalStorageRemoteFormatV1(hasAdaptive, hasOpaqueBeforeAdaptive || hasOpaqueAfterAdaptive);
    }

    async deleteFiles(keys: string[]): Promise<boolean> {
        if (keys.length === 0) return true;
        const client = this._getClient();
        try {
            const cmd = new DeleteObjectsCommand({
                Bucket: this._settings.bucket,
                Delete: {
                    Objects: keys.map((e) => ({ Key: `${this._settings.bucketPrefix}${e}` })),
                },
            });
            const r = await this.runTrackedRequest(() => client.send(cmd));
            const { Deleted, Errors } = r;
            const deleteCount = Deleted?.length || 0;
            const errorCount = Errors?.length || 0;
            Logger(
                `${deleteCount} items deleted.${errorCount !== 0 ? ` (${errorCount} items failed to delete)` : ""}`,
                LOG_LEVEL_VERBOSE,
                "reset-bucket"
            );
            return errorCount === 0;
        } catch (ex) {
            Logger(`WARNING! Could not delete files.`, LOG_LEVEL_NOTICE, "reset-bucket");
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async resetJournalStorage(): Promise<boolean> {
        let previousKeys: string | undefined;
        while (true) {
            const keys = await this.listFiles("", 1000);
            if (keys.length === 0) return true;
            const currentKeys = keys.join("\u001f");
            if (previousKeys !== undefined && currentKeys === previousKeys) return false;
            previousKeys = currentKeys;
            if (!(await this.deleteFiles(keys))) return false;
        }
    }

    private validateAdaptiveObjectKey(key: string): void {
        if (!/^a1~[A-Za-z0-9._~-]+$/u.test(key)) {
            throw new TypeError("Adaptive Journal S3 object keys must use the flat ASCII a1 namespace");
        }
    }

    async readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>> {
        this.validateAdaptiveObjectKey(key);
        let rangeHeader: string | undefined;
        if (range) {
            if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
                throw new RangeError("Adaptive Journal byte-range offset must be a non-negative safe integer");
            }
            if (!Number.isSafeInteger(range.length) || range.length < 1) {
                throw new RangeError("Adaptive Journal byte-range length must be a positive safe integer");
            }
            const end = range.offset + range.length - 1;
            if (!Number.isSafeInteger(end)) throw new RangeError("Adaptive Journal byte range exceeds safe integers");
            rangeHeader = `bytes=${range.offset}-${end}`;
        }
        const client = this._getClient();
        const command = new GetObjectCommand({
            Bucket: this._settings.bucket,
            Key: `${this._settings.bucketPrefix}${key}`,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
        });
        try {
            const response = await this.runTrackedRequest(() => client.send(command));
            if (!response.Body) {
                return { status: "failed", failure: { category: "invalid-response", retry: "never" } };
            }
            const value = new Uint8Array(await response.Body.transformToByteArray());
            if (range) {
                const end = range.offset + range.length - 1;
                const expectedContentRange = new RegExp(`^bytes ${range.offset}-${end}/[0-9]+$`, "u");
                if (
                    response.$metadata.httpStatusCode !== 206 ||
                    value.byteLength !== range.length ||
                    !response.ContentRange ||
                    !expectedContentRange.test(response.ContentRange)
                ) {
                    return { status: "failed", failure: { category: "invalid-response", retry: "never" } };
                }
            }
            return {
                ...(response.ETag ? { identity: response.ETag } : {}),
                status: "found",
                value,
            };
        } catch (error) {
            if (isS3Missing(error)) return { status: "missing" };
            return { status: "failed", failure: adaptiveRemoteFailure(error, false) };
        }
    }

    async createAdaptiveObject(key: string, bytes: Uint8Array, mime: string): Promise<ImmutableCreate> {
        this.validateAdaptiveObjectKey(key);
        const client = this._getClient();
        const command = new PutObjectCommand({
            Body: bytes,
            Bucket: this._settings.bucket,
            ContentType: mime,
            IfNoneMatch: "*",
            Key: `${this._settings.bucketPrefix}${key}`,
        });
        try {
            const response = await this.runTrackedRequest(() => client.send(command));
            return {
                ...(response.ETag ? { identity: response.ETag } : {}),
                status: "created",
            };
        } catch (error) {
            if (isS3PreconditionFailed(error)) return { status: "already-exists" };
            return { status: "failed", failure: adaptiveRemoteFailure(error, true) };
        }
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        this.validateAdaptiveObjectKey(prefix);
        try {
            return { status: "ok", keys: await this.listObjectKeys(prefix) };
        } catch (error) {
            return { status: "failed", failure: adaptiveRemoteFailure(error, false) };
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
        const unsupported = required.filter((capability) => !ADAPTIVE_CAPABILITIES.has(capability));
        if (unsupported.length > 0) return { status: "unsupported", missing: unsupported };

        const key = this.makeCapabilityProbeKey();
        const body = new Uint8Array([0x00, 0xff, 0x41, 0x80, 0x0a, 0x7f]);
        const replacement = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11]);
        const missing = new Set<string>();
        let ownsProbe = false;
        let failure: RemoteFailure | undefined;

        const created = await this.createAdaptiveObject(key, body, "application/octet-stream");
        if (created.status === "created") {
            ownsProbe = true;
        } else if (created.status === "failed") {
            if (created.failure.retry === "verify-first") {
                const verification = await this.readAdaptiveObject(key);
                ownsProbe = verification.status === "found" && bytesEqual(verification.value, body);
            }
            if (!ownsProbe) failure = created.failure;
        } else {
            missing.add("conditional-create");
        }

        if (!failure && ownsProbe) {
            const read = await this.readAdaptiveObject(key);
            if (read.status === "failed") failure = read.failure;
            else if (read.status !== "found" || !bytesEqual(read.value, body)) {
                missing.add("binary-fidelity");
                missing.add("read-after-write");
            }

            const listing = await this.listAdaptiveObjects(key);
            if (listing.status === "failed") failure ??= listing.failure;
            else if (!listing.keys.includes(key)) missing.add("complete-listing");

            const second = await this.createAdaptiveObject(key, replacement, "application/octet-stream");
            if (second.status === "failed") failure ??= second.failure;
            else if (second.status !== "already-exists") missing.add("conditional-create");

            const retained = await this.readAdaptiveObject(key);
            if (retained.status === "failed") failure ??= retained.failure;
            else if (retained.status !== "found" || !bytesEqual(retained.value, body)) {
                missing.add("conditional-create");
            }

            if (required.includes("byte-range")) {
                const ranged = await this.readAdaptiveObject(key, { length: 3, offset: 1 });
                if (ranged.status === "failed") {
                    if (ranged.failure.category === "invalid-response") missing.add("byte-range");
                    else failure ??= ranged.failure;
                } else if (ranged.status !== "found" || !bytesEqual(ranged.value, body.slice(1, 4))) {
                    missing.add("byte-range");
                }
            }
        }

        if (ownsProbe) {
            if (!(await this.deleteFiles([key]))) {
                failure ??= { category: "unavailable", retry: "later" };
            } else {
                const deleted = await this.readAdaptiveObject(key);
                if (deleted.status === "failed") failure ??= deleted.failure;
                else if (deleted.status !== "missing") missing.add("delete-visibility");
            }
        }

        if (failure) return { status: "failed", failure };
        if (!ownsProbe) return { status: "unsupported", missing: [...missing] };
        if (missing.size > 0) return { status: "unsupported", missing: [...missing] };
        return { status: "verified" };
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
        const client = this._getClient();
        const cmd = new HeadBucketCommand({ Bucket: this._settings.bucket });
        try {
            await this.runTrackedRequest(() => client.send(cmd));
            return true;
        } catch (ex) {
            Logger(`Could not connect to the remote bucket`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async getUsage(): Promise<false | RemoteDBStatus> {
        const client = this._getClient();
        try {
            const objects = await this.runTrackedRequest(() => client.listObjectsV2({ Bucket: this._settings.bucket }));
            if (!objects.Contents) return {};
            return {
                estimatedSize: objects.Contents.reduce((acc, e) => acc + (e.Size || 0), 0),
            };
        } catch (ex) {
            Logger(`Could not get status of the remote bucket`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
}
