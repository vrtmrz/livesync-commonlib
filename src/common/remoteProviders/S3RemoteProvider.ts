import { REMOTE_MINIO } from "@lib/common/models/setting.const.ts";
import type { BucketSyncSetting, RemoteDBSettings } from "@lib/common/models/setting.type.ts";
import type { RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";
import { parseSlsConnectionUri, proxyConnectionUrl, withSlsConnectionScheme } from "./connectionUri.ts";

function pickS3Settings(settings: RemoteDBSettings): BucketSyncSetting {
    return {
        accessKey: settings.accessKey,
        bucket: settings.bucket,
        bucketCustomHeaders: settings.bucketCustomHeaders,
        bucketPrefix: settings.bucketPrefix,
        endpoint: settings.endpoint,
        forcePathStyle: settings.forcePathStyle,
        region: settings.region,
        secretKey: settings.secretKey,
        useCustomRequestHandler: settings.useCustomRequestHandler,
    };
}

export const s3RemoteProvider: RemoteProviderDescriptor<"s3", BucketSyncSetting> = {
    activationRoles: ["main"],
    family: "journal",
    legacyProfileId: "legacy-s3",
    legacyProfileName: "S3 Remote",
    remoteType: REMOTE_MINIO,
    schemes: ["s3"],
    type: "s3",
    hasConfiguration: (settings) => typeof settings.endpoint === "string" && settings.endpoint.trim() !== "",
    parse(uri) {
        const { url } = parseSlsConnectionUri(uri);
        return {
            accessKey: decodeURIComponent(url.username),
            secretKey: decodeURIComponent(url.password),
            endpoint: url.searchParams.get("endpoint") || `https://${url.host}`,
            bucket: url.searchParams.get("bucket") || "",
            region: url.searchParams.get("region") || "auto",
            bucketPrefix: url.searchParams.get("prefix") || "",
            useCustomRequestHandler: url.searchParams.get("useProxy") === "true",
            bucketCustomHeaders: url.searchParams.get("headers") || "",
            forcePathStyle: url.searchParams.get("pathStyle") !== "false",
        };
    },
    pick: pickS3Settings,
    serialise(settings) {
        const endpoint = new URL(settings.endpoint);
        const url = proxyConnectionUrl(endpoint.host);
        url.username = encodeURIComponent(settings.accessKey);
        url.password = encodeURIComponent(settings.secretKey);
        url.searchParams.set("endpoint", settings.endpoint);
        url.searchParams.set("bucket", settings.bucket);
        url.searchParams.set("region", settings.region);
        if (settings.bucketPrefix) url.searchParams.set("prefix", settings.bucketPrefix);
        if (settings.bucketCustomHeaders) url.searchParams.set("headers", settings.bucketCustomHeaders);
        if (settings.useCustomRequestHandler) url.searchParams.set("useProxy", "true");
        if (!settings.forcePathStyle) url.searchParams.set("pathStyle", "false");
        return withSlsConnectionScheme(url, "s3");
    },
    suggestName(settings) {
        const bucket = settings.bucket.trim();
        if (bucket) return `S3 ${bucket}`;
        try {
            const host = new URL(settings.endpoint).host;
            return host ? `S3 ${host}` : "Object Storage remote";
        } catch {
            return "Object Storage remote";
        }
    },
};
