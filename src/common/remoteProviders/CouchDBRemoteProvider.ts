import type { JWTAlgorithm } from "@lib/common/models/auth.type.ts";
import { REMOTE_COUCHDB } from "@lib/common/models/setting.const.ts";
import type { CouchDBConnection, RemoteDBSettings } from "@lib/common/models/setting.type.ts";
import type { RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";
import { parseSlsConnectionUri, proxyConnectionUrl, withSlsConnectionScheme } from "./connectionUri.ts";

function pickCouchDBSettings(settings: RemoteDBSettings): CouchDBConnection {
    return {
        couchDB_CustomHeaders: settings.couchDB_CustomHeaders,
        couchDB_DBNAME: settings.couchDB_DBNAME,
        couchDB_PASSWORD: settings.couchDB_PASSWORD,
        couchDB_URI: settings.couchDB_URI,
        couchDB_USER: settings.couchDB_USER,
        jwtAlgorithm: settings.jwtAlgorithm,
        jwtExpDuration: settings.jwtExpDuration,
        jwtKey: settings.jwtKey,
        jwtKid: settings.jwtKid,
        jwtSub: settings.jwtSub,
        useJWT: settings.useJWT,
        useRequestAPI: settings.useRequestAPI,
    };
}

export const couchDBRemoteProvider: RemoteProviderDescriptor<"couchdb", CouchDBConnection> = {
    activationRoles: ["main"],
    family: "couchdb",
    legacyProfileId: "legacy-couchdb",
    legacyProfileName: "CouchDB Remote",
    remoteType: REMOTE_COUCHDB,
    schemes: ["http", "https"],
    type: "couchdb",
    hasConfiguration: (settings) => typeof settings.couchDB_URI === "string" && settings.couchDB_URI.trim() !== "",
    parse(uri) {
        const { scheme, url } = parseSlsConnectionUri(uri);
        return {
            couchDB_URI: `${scheme}://${url.host}${url.pathname === "/" ? "" : url.pathname}`,
            couchDB_USER: decodeURIComponent(url.username),
            couchDB_PASSWORD: decodeURIComponent(url.password),
            couchDB_DBNAME: url.searchParams.get("db") || "",
            couchDB_CustomHeaders: url.searchParams.get("headers") || "",
            useJWT: url.searchParams.get("useJWT") === "true",
            jwtAlgorithm: (url.searchParams.get("jwtAlg") as JWTAlgorithm) || "",
            jwtKey: url.searchParams.get("jwtKey") || "",
            jwtKid: url.searchParams.get("jwtKid") || "",
            jwtSub: url.searchParams.get("jwtSub") || "",
            jwtExpDuration: parseInt(url.searchParams.get("jwtExp") || "5"),
            useRequestAPI: url.searchParams.get("useRequestAPI") === "true",
        };
    },
    pick: pickCouchDBSettings,
    serialise(settings) {
        const endpoint = new URL(settings.couchDB_URI);
        const scheme = endpoint.protocol.replace(":", "");
        const url = proxyConnectionUrl(`${endpoint.host}${endpoint.pathname}`);
        url.username = encodeURIComponent(settings.couchDB_USER);
        url.password = encodeURIComponent(settings.couchDB_PASSWORD);
        url.searchParams.set("db", settings.couchDB_DBNAME);
        if (settings.couchDB_CustomHeaders) url.searchParams.set("headers", settings.couchDB_CustomHeaders);
        if (settings.useJWT) {
            url.searchParams.set("useJWT", "true");
            url.searchParams.set("jwtAlg", settings.jwtAlgorithm);
            if (settings.jwtKey) url.searchParams.set("jwtKey", settings.jwtKey);
            if (settings.jwtKid) url.searchParams.set("jwtKid", settings.jwtKid);
            if (settings.jwtSub) url.searchParams.set("jwtSub", settings.jwtSub);
            url.searchParams.set("jwtExp", `${settings.jwtExpDuration || 5}`);
        }
        if (settings.useRequestAPI) url.searchParams.set("useRequestAPI", "true");
        return withSlsConnectionScheme(url, scheme);
    },
    suggestName(settings) {
        try {
            const host = new URL(settings.couchDB_URI).host;
            return host ? `CouchDB ${host}` : "CouchDB remote";
        } catch {
            return "CouchDB remote";
        }
    },
};
