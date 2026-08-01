import { REMOTE_WEBDAV } from "@lib/common/models/setting.const.ts";
import type { RemoteDBSettings, WebDAVSyncSetting } from "@lib/common/models/setting.type.ts";
import {
    applyJournalProtocolOptionsV1,
    parseJournalProtocolOptionsV1,
    removeJournalProtocolOptionsV1,
} from "./JournalRemoteProvider.ts";
import type { RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";
import { parseSlsConnectionUri, withSlsConnectionScheme } from "./connectionUri.ts";

function pickWebDAVSettings(settings: RemoteDBSettings): WebDAVSyncSetting {
    return {
        webDAVactiveConnectionURI: settings.webDAVactiveConnectionURI,
        expectedRepositoryId: settings.expectedRepositoryId,
        journalFormat: settings.journalFormat,
        packReadPolicy: settings.packReadPolicy,
    };
}

export const webDAVRemoteProvider: RemoteProviderDescriptor<"webdav", WebDAVSyncSetting> = {
    activationRoles: ["main"],
    family: "journal",
    legacyProfileId: "legacy-webdav",
    legacyProfileName: "WebDAV Remote",
    remoteType: REMOTE_WEBDAV,
    schemes: ["webdav"],
    type: "webdav",
    hasConfiguration: (settings) =>
        typeof settings.webDAVactiveConnectionURI === "string" && settings.webDAVactiveConnectionURI.trim() !== "",
    parse(uri) {
        const { url } = parseSlsConnectionUri(uri);
        const protocol = parseJournalProtocolOptionsV1(url);
        removeJournalProtocolOptionsV1(url);
        return {
            webDAVactiveConnectionURI: withSlsConnectionScheme(url, "webdav"),
            ...protocol,
        };
    },
    pick: pickWebDAVSettings,
    serialise(settings) {
        const { scheme, url } = parseSlsConnectionUri(settings.webDAVactiveConnectionURI);
        if (scheme !== "webdav") {
            throw new Error("Invalid WebDAV connection URI");
        }
        applyJournalProtocolOptionsV1(url, settings);
        return withSlsConnectionScheme(url, "webdav");
    },
    suggestName(settings) {
        try {
            const { url } = parseSlsConnectionUri(settings.webDAVactiveConnectionURI);
            return url.host ? `WebDAV ${url.host}` : "WebDAV remote";
        } catch {
            return "WebDAV remote";
        }
    },
};
