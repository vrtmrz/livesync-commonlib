import type {
    BucketSyncSetting,
    CouchDBConnection,
    P2PConnectionInfo,
    WebDAVSyncSetting,
} from "@lib/common/models/setting.type.ts";
import { couchDBRemoteProvider } from "./CouchDBRemoteProvider.ts";
import { p2pRemoteProvider } from "./P2PRemoteProvider.ts";
import { RemoteProviderRegistry } from "./RemoteProviderRegistry.ts";
import { s3RemoteProvider } from "./S3RemoteProvider.ts";
import { webDAVRemoteProvider } from "./WebDAVRemoteProvider.ts";

export type BuiltInRemoteConfiguration =
    | { type: "couchdb"; settings: CouchDBConnection }
    | { type: "s3"; settings: BucketSyncSetting }
    | { type: "p2p"; settings: P2PConnectionInfo }
    | { type: "webdav"; settings: WebDAVSyncSetting };

export const builtInRemoteProviderDescriptors = [
    couchDBRemoteProvider,
    s3RemoteProvider,
    p2pRemoteProvider,
    webDAVRemoteProvider,
] as const;

export function createBuiltInRemoteProviderRegistry(): RemoteProviderRegistry<BuiltInRemoteConfiguration> {
    return new RemoteProviderRegistry<BuiltInRemoteConfiguration>(builtInRemoteProviderDescriptors);
}

export const defaultRemoteProviderRegistry = createBuiltInRemoteProviderRegistry().freeze();
