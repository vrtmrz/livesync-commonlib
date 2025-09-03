import { DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3 } from "@aws-sdk/client-s3";
import { applyMd5BodyChecksumMiddleware } from "@smithy/middleware-apply-body-checksum";
import { Md5 } from "@smithy/md5-js";

import { ConfiguredRetryStrategy } from "@smithy/util-retry";

import {
    DOCID_JOURNAL_SYNC_PARAMETERS,
    E2EEAlgorithms,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type SyncParameters,
} from "../../../common/types.ts";
import { Logger } from "../../../common/logger.ts";
import { JournalSyncAbstract } from "../JournalSyncAbstract.ts";
import { decryptBinary, encryptBinary } from "../../../encryption/e2ee_v2.ts";
import {
    encryptBinary as encryptBinaryHKDF,
    decryptBinary as decryptBinaryHKDF,
} from "octagonal-wheels/encryption/hkdf";
import type { RemoteDBStatus } from "../../LiveSyncAbstractReplicator.ts";
import { promiseWithResolver } from "octagonal-wheels/promises";
import type { SourceData } from "@smithy/types";
import { clearHandlers, createSyncParamsHanderForServer } from "../../SyncParamsHandler.ts";

export class JournalSyncMinio extends JournalSyncAbstract {
    getRemoteKey(): string {
        return this.getHash(this._settings);
    }
    async getReplicationPBKDF2Salt(refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        const server = this.getRemoteKey();
        const manager = createSyncParamsHanderForServer(server, {
            put: (params: SyncParameters) => this.putSyncParameters(params),
            get: () => this.getSyncParameters(),
            create: () => this.getInitialSyncParameters(),
        });
        return await manager.getPBKDF2Salt(refresh);
    }

    isEncryptionPrevented(fileName: string): boolean {
        // Prevent encryption for some files
        if (fileName.endsWith(DOCID_JOURNAL_SYNC_PARAMETERS)) return true;

        return false;
    }

    _instance?: S3;

    _getClient(): S3 {
        if (this._instance) return this._instance;
        const ep = this.endpoint
            ? {
                  endpoint: this.endpoint,
                  forcePathStyle: this.forcePathStyle,
              }
            : {};

        this._instance = new S3({
            region: this.region,
            ...ep,
            credentials: {
                accessKeyId: this.id,
                secretAccessKey: this.key,
            },
            maxAttempts: 4,
            retryStrategy: new ConfiguredRetryStrategy(4, (attempt: number) => 100 + attempt * 1000),
            requestHandler: this.useCustomRequestHandler ? this.env.$$customFetchHandler() : undefined,
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        });
        const bucketCustomHeaders = this.customHeaders;
        this._instance.middlewareStack.add(
            (next, context) => (args: any) => {
                bucketCustomHeaders.forEach(([key, value]) => {
                    if (key && value) {
                        args.request.headers[key] = value;
                    }
                });
                return next(args);
            },
            {
                name: "addBucketCustomHeadersMiddleware",
                step: "build",
            }
        );
        const arrayBufferToBase64Sync = (buffer: ArrayBufferLike) => {
            return btoa(String.fromCharCode(...new Uint8Array(buffer)));
        };

        this._instance.middlewareStack.add(
            applyMd5BodyChecksumMiddleware({
                md5: Md5,
                base64Encoder: (data: Uint8Array) => arrayBufferToBase64Sync(data.buffer),
                streamHasher: (hashConstructor, stream: any) => {
                    const result = promiseWithResolver<Uint8Array>();
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
        clearHandlers();
        return this._instance;
    }

    async resetBucket() {
        const client = this._getClient();
        let files = [] as string[];
        let deleteCount = 0;
        let errorCount = 0;
        try {
            do {
                files = await this.listFiles("", 100);
                if (files.length == 0) {
                    break;
                }
                const cmd = new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: {
                        Objects: files.map((e) => ({ Key: `${this.prefix}${e}` })),
                    },
                });
                const r = await client.send(cmd);
                const { Deleted, Errors } = r;
                deleteCount += Deleted?.length || 0;
                errorCount += Errors?.length || 0;
                Logger(
                    `${deleteCount} items has been deleted!${errorCount != 0 ? ` (${errorCount} items failed to delete)` : ""}`,
                    LOG_LEVEL_NOTICE,
                    "reset-bucket"
                );
            } while (files.length != 0);
            clearHandlers();
        } catch (ex) {
            Logger(
                `WARNING! Could not delete files. you should try it once or remake the bucket manually`,
                LOG_LEVEL_NOTICE,
                "reset-bucket"
            );
            Logger(ex, LOG_LEVEL_VERBOSE);
        }

        const journals = await this._getRemoteJournals();
        if (journals.length == 0) {
            Logger("Nothing to delete!", LOG_LEVEL_NOTICE);
            return true;
        }
        const cmd = new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
                Objects: journals.map((e) => ({ Key: e })),
            },
        });
        const r = await client.send(cmd);
        Logger(`${r?.Deleted?.length || 0} items has been deleted!`, LOG_LEVEL_NOTICE);
        await this.resetCheckpointInfo();
        return true;
    }

    async uploadJson(key: string, body: any) {
        try {
            return await this.uploadFile(key, new Blob([JSON.stringify(body)]), "application/json");
        } catch (ex) {
            Logger(`Could not upload json ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async downloadJson<T>(key: string): Promise<T | false> {
        try {
            const ret = await this.downloadFile(key, true);
            if (!ret) return false;
            return JSON.parse(new TextDecoder().decode(ret)) as T;
        } catch (ex) {
            Logger(`Could not download json ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async uploadFile(key: string, blob: Blob, mime: string) {
        try {
            let u = new Uint8Array(await blob.arrayBuffer());
            const set = this.env.getSettings();
            if (set.encrypt && set.passphrase != "" && !this.isEncryptionPrevented(key)) {
                if (set.E2EEAlgorithm === E2EEAlgorithms.V2) {
                    const salt = await this.getReplicationPBKDF2Salt();
                    u = await encryptBinaryHKDF(u, set.passphrase, salt);
                } else {
                    u = await encryptBinary(u, set.passphrase, set.useDynamicIterationCount);
                }
            }
            const client = this._getClient();
            const cmd = new PutObjectCommand({
                Bucket: this.bucket,
                Key: `${this.prefix}${key}`,
                Body: u,
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
    async downloadFile(key: string, ignoreCache = false): Promise<Uint8Array | false> {
        const client = this._getClient();
        const cmd = new GetObjectCommand({
            Bucket: this.bucket,
            Key: `${this.prefix}${key}`,
            ...(ignoreCache ? { ResponseCacheControl: "no-cache" } : {}),
        });
        const r = await client.send(cmd);
        const set = this.env.getSettings();
        try {
            if (r.Body) {
                let u = new Uint8Array(await r.Body.transformToByteArray());
                if (set.encrypt && set.passphrase != "" && !this.isEncryptionPrevented(key)) {
                    if (set.E2EEAlgorithm === E2EEAlgorithms.V2) {
                        const salt = await this.getReplicationPBKDF2Salt();
                        u = await decryptBinaryHKDF(u, set.passphrase, salt);
                    } else if (set.E2EEAlgorithm === E2EEAlgorithms.V1) {
                        try {
                            const salt = await this.getReplicationPBKDF2Salt();
                            u = await decryptBinaryHKDF(u, set.passphrase, salt);
                        } catch (ex) {
                            // If throws here, completely failed to decrypt
                            Logger(`Could not decrypt ${key} in v2`, LOG_LEVEL_VERBOSE);
                            Logger(ex, LOG_LEVEL_VERBOSE);
                            u = new Uint8Array(await decryptBinary(u, set.passphrase, set.useDynamicIterationCount));
                        }
                    } else if (set.E2EEAlgorithm === E2EEAlgorithms.ForceV1) {
                        u = new Uint8Array(await decryptBinary(u, set.passphrase, set.useDynamicIterationCount));
                    }
                }
                return u;
            }
        } catch (ex) {
            Logger(`Could not download ${key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
        return false;
    }
    async listFiles(from: string, limit?: number) {
        const client = this._getClient();
        const objects = await client.listObjectsV2({
            Bucket: this.bucket,
            Prefix: this.prefix,
            StartAfter: `${this.prefix || ""}${from || ""}`,
            ...(limit ? { MaxKeys: limit } : {}),
        });
        if (!objects.Contents) return [];
        return objects.Contents.filter((e) => e.Key?.startsWith(this.prefix)).map((e) =>
            e.Key?.substring(this.prefix.length)
        ) as string[];
    }

    async isAvailable(): Promise<boolean> {
        const client = this._getClient();
        const cmd = new HeadBucketCommand({ Bucket: this.bucket });
        try {
            await client.send(cmd);
            return true;
        } catch (ex: any) {
            Logger(`Could not connected to the remote bucket`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async getUsage(): Promise<false | RemoteDBStatus> {
        const client = this._getClient();
        try {
            const objects = await client.listObjectsV2({ Bucket: this.bucket });
            if (!objects.Contents) return {};
            return {
                estimatedSize: objects.Contents.reduce((acc, e) => acc + (e.Size || 0), 0),
            };
        } catch (ex: any) {
            Logger(`Could not get status of the remote bucket`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
}
