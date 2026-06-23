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

import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type BucketSyncSetting } from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { IJournalStorage } from "./JournalStorageAdapter.ts";
import { parseHeaderValues } from "@lib/common/utils.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";

export class MinioStorageAdapter implements IJournalStorage {
    _instance?: S3;
    _settings: BucketSyncSetting;
    _env: LiveSyncJournalReplicatorEnv;

    constructor(settings: BucketSyncSetting, env: LiveSyncJournalReplicatorEnv) {
        this._settings = settings;
        this._env = env;
    }

    applyNewConfig(settings: BucketSyncSetting): void {
        this._settings = settings;
        this._instance = undefined; // Force recreation
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
            if (await client.send(cmd)) {
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
            const r = await client.send(cmd);
            if (r.Body) {
                return new Uint8Array(await r.Body.transformToByteArray());
            }
        } catch (ex) {
            Logger(`Could not download ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
        return false;
    }

    async listFiles(from: string, limit?: number): Promise<string[]> {
        const client = this._getClient();
        const objects = await client.listObjectsV2({
            Bucket: this._settings.bucket,
            Prefix: this._settings.bucketPrefix,
            StartAfter: `${this._settings.bucketPrefix || ""}${from || ""}`,
            ...(limit ? { MaxKeys: limit } : {}),
        });
        if (!objects.Contents) return [];
        return objects.Contents.filter((e) => e.Key?.startsWith(this._settings.bucketPrefix)).map((e) =>
            e.Key?.substring(this._settings.bucketPrefix.length)
        ) as string[];
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
            const r = await client.send(cmd);
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

    async isAvailable(): Promise<boolean> {
        const client = this._getClient();
        const cmd = new HeadBucketCommand({ Bucket: this._settings.bucket });
        try {
            await client.send(cmd);
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
            const objects = await client.listObjectsV2({ Bucket: this._settings.bucket });
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
