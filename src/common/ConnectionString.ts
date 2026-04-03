import type { CouchDBConnection, BucketSyncSetting, P2PConnectionInfo } from "./models/setting.type";

export type RemoteConfigurationResult =
    | { type: "couchdb"; settings: CouchDBConnection }
    | { type: "s3"; settings: BucketSyncSetting }
    | { type: "p2p"; settings: P2PConnectionInfo }
    | { type: "webdav"; settings: any }; // TODO: Define WebDAV settings

export class ConnectionStringParser {
    /**
     * Restore settings from URI
     */
    static parse(uriString: string): RemoteConfigurationResult {
        const url = new URL(uriString);
        const protocol = url.protocol.replace(":", "");

        switch (protocol) {
            case "sls+http":
            case "sls+https":
                return {
                    type: "couchdb",
                    settings: this.parseCouchDB(url),
                };
            case "sls+s3":
                return {
                    type: "s3",
                    settings: this.parseS3(url),
                };
            case "sls+p2p":
                return {
                    type: "p2p",
                    settings: this.parseP2P(url),
                };
            default:
                throw new Error(`Unsupported protocol: ${protocol}`);
        }
    }

    /**
     * 設定からURIを生成する
     */
    static serialize(config: RemoteConfigurationResult): string {
        switch (config.type) {
            case "couchdb":
                return this.serializeCouchDB(config.settings);
            case "s3":
                return this.serializeS3(config.settings);
            case "p2p":
                return this.serializeP2P(config.settings);
            default:
                throw new Error(`Unsupported type: ${config.type}`);
        }
    }

    private static parseCouchDB(url: URL): CouchDBConnection {
        const originalProtocol = (url.protocol.split("+")[1] || "https").replace(":", "");
        return {
            couchDB_URI: `${originalProtocol}://${url.host}${url.pathname === "/" ? "" : url.pathname}`,
            couchDB_USER: decodeURIComponent(url.username),
            couchDB_PASSWORD: decodeURIComponent(url.password),
            couchDB_DBNAME: url.searchParams.get("db") || "",
            couchDB_CustomHeaders: url.searchParams.get("headers") || "",
            useJWT: url.searchParams.get("useJWT") === "true",
            jwtAlgorithm: (url.searchParams.get("jwtAlg") as any) || "",
            jwtKey: url.searchParams.get("jwtKey") || "",
            jwtKid: url.searchParams.get("jwtKid") || "",
            jwtSub: url.searchParams.get("jwtSub") || "",
            jwtExpDuration: parseInt(url.searchParams.get("jwtExp") || "5"),
            useRequestAPI: url.searchParams.get("useRequestAPI") === "true",
        };
    }

    private static serializeCouchDB(settings: CouchDBConnection): string {
        const url = new URL(settings.couchDB_URI);
        const newUrl = new URL(`sls+${url.protocol.replace(":", "")}://${url.host}${url.pathname}`);
        newUrl.username = encodeURIComponent(settings.couchDB_USER);
        newUrl.password = encodeURIComponent(settings.couchDB_PASSWORD);
        newUrl.searchParams.set("db", settings.couchDB_DBNAME);
        if (settings.couchDB_CustomHeaders) newUrl.searchParams.set("headers", settings.couchDB_CustomHeaders);
        if (settings.useJWT) {
            newUrl.searchParams.set("useJWT", "true");
            newUrl.searchParams.set("jwtAlg", settings.jwtAlgorithm);
            if (settings.jwtKey) newUrl.searchParams.set("jwtKey", settings.jwtKey);
            if (settings.jwtKid) newUrl.searchParams.set("jwtKid", settings.jwtKid);
            if (settings.jwtSub) newUrl.searchParams.set("jwtSub", settings.jwtSub);
            newUrl.searchParams.set("jwtExp", `${settings.jwtExpDuration || 5}`);
        }
        if (settings.useRequestAPI) newUrl.searchParams.set("useRequestAPI", "true");
        return newUrl.toString();
    }

    private static parseS3(url: URL): BucketSyncSetting {
        const endpoint = url.searchParams.get("endpoint") || `https://${url.host}`;
        return {
            accessKey: decodeURIComponent(url.username),
            secretKey: decodeURIComponent(url.password),
            endpoint,
            bucket: url.searchParams.get("bucket") || "",
            region: url.searchParams.get("region") || "auto",
            bucketPrefix: url.searchParams.get("prefix") || "",
            useCustomRequestHandler: url.searchParams.get("useProxy") === "true",
            bucketCustomHeaders: url.searchParams.get("headers") || "",
            forcePathStyle: url.searchParams.get("pathStyle") !== "false",
        };
    }

    private static serializeS3(settings: BucketSyncSetting): string {
        const url = new URL(settings.endpoint);
        const newUrl = new URL(`sls+s3://${url.host}`);
        newUrl.username = encodeURIComponent(settings.accessKey);
        newUrl.password = encodeURIComponent(settings.secretKey);
        newUrl.searchParams.set("endpoint", settings.endpoint);
        newUrl.searchParams.set("bucket", settings.bucket);
        newUrl.searchParams.set("region", settings.region);
        if (settings.bucketPrefix) newUrl.searchParams.set("prefix", settings.bucketPrefix);
        if (settings.bucketCustomHeaders) newUrl.searchParams.set("headers", settings.bucketCustomHeaders);
        if (settings.useCustomRequestHandler) newUrl.searchParams.set("useProxy", "true");
        if (!settings.forcePathStyle) newUrl.searchParams.set("pathStyle", "false");
        return newUrl.toString();
    }

    private static parseP2P(url: URL): P2PConnectionInfo {
        return {
            P2P_Enabled: url.searchParams.get("enabled") !== "false",
            P2P_roomID: decodeURIComponent(url.host),
            P2P_passphrase: decodeURIComponent(url.password),
            P2P_relays: url.searchParams.get("relays") || "",
            P2P_AppID: url.searchParams.get("appId") || "self-hosted-livesync",
            P2P_AutoStart: url.searchParams.get("autoStart") === "true",
            P2P_AutoBroadcast: url.searchParams.get("autoBroadcast") === "true",
            P2P_turnServers: url.searchParams.get("turnServers") || "",
            P2P_turnUsername: url.searchParams.get("turnUser") || "",
            P2P_turnCredential: url.searchParams.get("turnPass") || "",
        };
    }

    private static serializeP2P(settings: P2PConnectionInfo): string {
        const newUrl = new URL(`sls+p2p://${encodeURIComponent(settings.P2P_roomID)}`);
        newUrl.password = encodeURIComponent(settings.P2P_passphrase);
        if (!settings.P2P_Enabled) newUrl.searchParams.set("enabled", "false");
        newUrl.searchParams.set("relays", settings.P2P_relays);
        newUrl.searchParams.set("appId", settings.P2P_AppID);
        if (settings.P2P_AutoStart) newUrl.searchParams.set("autoStart", "true");
        if (settings.P2P_AutoBroadcast) newUrl.searchParams.set("autoBroadcast", "true");
        if (settings.P2P_turnServers) newUrl.searchParams.set("turnServers", settings.P2P_turnServers);
        if (settings.P2P_turnUsername) newUrl.searchParams.set("turnUser", settings.P2P_turnUsername);
        if (settings.P2P_turnCredential) newUrl.searchParams.set("turnPass", settings.P2P_turnCredential);
        return newUrl.toString();
    }
}
