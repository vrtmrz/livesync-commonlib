import { describe, expect, it } from "vitest";
import { ConnectionStringParser } from "./ConnectionString";

describe("ConnectionStringParser CouchDB JWT", () => {
    it("should serialize and parse all JWT fields", () => {
        const uri = ConnectionStringParser.serialize({
            type: "couchdb",
            settings: {
                couchDB_URI: "https://example.com:5984",
                couchDB_USER: "user",
                couchDB_PASSWORD: "pass",
                couchDB_DBNAME: "vault",
                couchDB_CustomHeaders: "x-test:1",
                useJWT: true,
                jwtAlgorithm: "HS256",
                jwtKey: "secret-key",
                jwtKid: "kid-1",
                jwtSub: "device-a",
                jwtExpDuration: 10,
                useRequestAPI: true,
            },
        });

        expect(uri).toContain("useJWT=true");
        expect(uri).toContain("jwtAlg=HS256");
        expect(uri).toContain("jwtKey=secret-key");
        expect(uri).toContain("jwtKid=kid-1");
        expect(uri).toContain("jwtSub=device-a");
        expect(uri).toContain("jwtExp=10");

        const parsed = ConnectionStringParser.parse(uri);
        if (parsed.type !== "couchdb") {
            throw new Error("Expected couchdb type");
        }

        expect(parsed.settings.couchDB_URI).toBe("https://example.com:5984");
        expect(parsed.settings.couchDB_DBNAME).toBe("vault");
        expect(parsed.settings.useJWT).toBe(true);
        expect(parsed.settings.jwtAlgorithm).toBe("HS256");
        expect(parsed.settings.jwtKey).toBe("secret-key");
        expect(parsed.settings.jwtKid).toBe("kid-1");
        expect(parsed.settings.jwtSub).toBe("device-a");
        expect(parsed.settings.jwtExpDuration).toBe(10);
        expect(parsed.settings.useRequestAPI).toBe(true);
    });
});

describe("ConnectionStringParser CouchDB credentials round-trip", () => {
    it("should preserve username and password through serialize/parse", () => {
        const uri = ConnectionStringParser.serialize({
            type: "couchdb",
            settings: {
                couchDB_URI: "https://example.com",
                couchDB_USER: "user-name",
                couchDB_PASSWORD: "p@ss:word!",
                couchDB_DBNAME: "vault",
                couchDB_CustomHeaders: "",
                useJWT: false,
                jwtAlgorithm: "",
                jwtKey: "",
                jwtKid: "",
                jwtSub: "",
                jwtExpDuration: 5,
                useRequestAPI: false,
            },
        });

        expect(uri.startsWith("sls+https://")).toBe(true);

        const parsed = ConnectionStringParser.parse(uri);
        if (parsed.type !== "couchdb") {
            throw new Error("Expected couchdb type");
        }

        expect(parsed.settings.couchDB_URI).toBe("https://example.com");
        expect(parsed.settings.couchDB_USER).toBe("user-name");
        expect(parsed.settings.couchDB_PASSWORD).toBe("p@ss:word!");
        expect(parsed.settings.couchDB_DBNAME).toBe("vault");
    });

    it("should preserve credentials for the http (insecure) variant too", () => {
        const uri = ConnectionStringParser.serialize({
            type: "couchdb",
            settings: {
                couchDB_URI: "http://127.0.0.1:5984",
                couchDB_USER: "admin",
                couchDB_PASSWORD: "secret",
                couchDB_DBNAME: "vault",
                couchDB_CustomHeaders: "",
                useJWT: false,
                jwtAlgorithm: "",
                jwtKey: "",
                jwtKid: "",
                jwtSub: "",
                jwtExpDuration: 5,
                useRequestAPI: false,
            },
        });

        expect(uri.startsWith("sls+http://")).toBe(true);

        const parsed = ConnectionStringParser.parse(uri);
        if (parsed.type !== "couchdb") {
            throw new Error("Expected couchdb type");
        }

        expect(parsed.settings.couchDB_URI).toBe("http://127.0.0.1:5984");
        expect(parsed.settings.couchDB_USER).toBe("admin");
        expect(parsed.settings.couchDB_PASSWORD).toBe("secret");
    });
});

describe("ConnectionStringParser P2P", () => {
    it("should serialize and parse P2P settings including enabled and TURN fields", () => {
        const uri = ConnectionStringParser.serialize({
            type: "p2p",
            settings: {
                P2P_Enabled: false,
                P2P_roomID: "room-abc",
                P2P_passphrase: "pass-123",
                P2P_relays: "wss://relay.example",
                P2P_AppID: "self-hosted-livesync",
                P2P_AutoStart: true,
                P2P_AutoBroadcast: true,
                P2P_turnServers: "turn:turn.example:3478",
                P2P_turnUsername: "turn-user",
                P2P_turnCredential: "turn-pass",
            },
        });

        expect(uri).toContain("sls+p2p://");
        expect(uri).toContain("enabled=false");
        expect(uri).toContain("relays=");
        expect(uri).toContain("appId=self-hosted-livesync");
        expect(uri).toContain("autoStart=true");
        expect(uri).toContain("autoBroadcast=true");
        expect(uri).toContain("turnServers=");
        expect(uri).toContain("turnUser=turn-user");
        expect(uri).toContain("turnPass=turn-pass");

        const parsed = ConnectionStringParser.parse(uri);
        if (parsed.type !== "p2p") {
            throw new Error("Expected p2p type");
        }

        expect(parsed.settings.P2P_Enabled).toBe(false);
        expect(parsed.settings.P2P_roomID).toBe("room-abc");
        expect(parsed.settings.P2P_passphrase).toBe("pass-123");
        expect(parsed.settings.P2P_relays).toBe("wss://relay.example");
        expect(parsed.settings.P2P_AppID).toBe("self-hosted-livesync");
        expect(parsed.settings.P2P_AutoStart).toBe(true);
        expect(parsed.settings.P2P_AutoBroadcast).toBe(true);
        expect(parsed.settings.P2P_turnServers).toBe("turn:turn.example:3478");
        expect(parsed.settings.P2P_turnUsername).toBe("turn-user");
        expect(parsed.settings.P2P_turnCredential).toBe("turn-pass");
    });
});

describe("ConnectionStringParser S3", () => {
    it("should serialize and parse all BucketSyncSetting fields", () => {
        const uri = ConnectionStringParser.serialize({
            type: "s3",
            settings: {
                accessKey: "ak",
                secretKey: "sk",
                endpoint: "http://minio.local:9000/custom/path",
                bucket: "my-bucket",
                region: "ap-northeast-1",
                bucketPrefix: "vault/",
                useCustomRequestHandler: true,
                bucketCustomHeaders: "x-amz-meta-test:1",
                forcePathStyle: false,
            },
        });

        expect(uri).toContain("sls+s3://");
        expect(uri).toContain("endpoint=http%3A%2F%2Fminio.local%3A9000%2Fcustom%2Fpath");
        expect(uri).toContain("bucket=my-bucket");
        expect(uri).toContain("region=ap-northeast-1");
        expect(uri).toContain("prefix=vault%2F");
        expect(uri).toContain("headers=x-amz-meta-test%3A1");
        expect(uri).toContain("useProxy=true");
        expect(uri).toContain("pathStyle=false");

        const parsed = ConnectionStringParser.parse(uri);
        if (parsed.type !== "s3") {
            throw new Error("Expected s3 type");
        }

        expect(parsed.settings.accessKey).toBe("ak");
        expect(parsed.settings.secretKey).toBe("sk");
        expect(parsed.settings.endpoint).toBe("http://minio.local:9000/custom/path");
        expect(parsed.settings.bucket).toBe("my-bucket");
        expect(parsed.settings.region).toBe("ap-northeast-1");
        expect(parsed.settings.bucketPrefix).toBe("vault/");
        expect(parsed.settings.useCustomRequestHandler).toBe(true);
        expect(parsed.settings.bucketCustomHeaders).toBe("x-amz-meta-test:1");
        expect(parsed.settings.forcePathStyle).toBe(false);
    });
});
