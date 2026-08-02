import { resolveJournalProtocolOptionsV1 } from "@lib/common/models/journalProtocol.ts";
import { REMOTE_POSTGREST } from "@lib/common/models/setting.const.ts";
import type { PostgRESTSyncSetting, RemoteDBSettings } from "@lib/common/models/setting.type.ts";
import {
    applyJournalProtocolOptionsV1,
    parseJournalProtocolOptionsV1,
    removeJournalProtocolOptionsV1,
} from "./JournalRemoteProvider.ts";
import type { RemoteProviderDescriptor } from "./RemoteProviderRegistry.ts";
import { parseSlsConnectionUri, withSlsConnectionScheme } from "./connectionUri.ts";

function resolvePostgRESTProtocol(settings: Partial<PostgRESTSyncSetting>) {
    const protocol = resolveJournalProtocolOptionsV1({
        expectedRepositoryId: settings.expectedRepositoryId,
        journalFormat: settings.journalFormat ?? "adaptive-v1",
        packReadPolicy: settings.packReadPolicy ?? "whole-pack",
    });
    if (protocol.journalFormat !== "adaptive-v1") {
        throw new Error("PostgREST Journal connections require the Adaptive format");
    }
    if (protocol.packReadPolicy !== "whole-pack") {
        throw new Error("PostgREST native Chunk storage does not support object Pack range reads");
    }
    return protocol;
}

function pickPostgRESTSettings(settings: RemoteDBSettings): PostgRESTSyncSetting {
    return {
        postgrestActiveConnectionURI: settings.postgrestActiveConnectionURI,
        expectedRepositoryId: settings.expectedRepositoryId ?? "",
        journalFormat: "adaptive-v1",
        packReadPolicy: "whole-pack",
    };
}

export const postgRESTRemoteProvider: RemoteProviderDescriptor<"postgrest", PostgRESTSyncSetting> = {
    activationRoles: ["main"],
    family: "journal",
    legacyProfileId: "legacy-postgrest",
    legacyProfileName: "PostgREST Remote",
    remoteType: REMOTE_POSTGREST,
    schemes: ["postgrest"],
    type: "postgrest",
    hasConfiguration: (settings) =>
        typeof settings.postgrestActiveConnectionURI === "string" &&
        settings.postgrestActiveConnectionURI.trim() !== "",
    parse(uri) {
        const { url } = parseSlsConnectionUri(uri);
        const protocol = parseJournalProtocolOptionsV1(url, {
            journalFormat: "adaptive-v1",
            packReadPolicy: "whole-pack",
        });
        resolvePostgRESTProtocol(protocol);
        removeJournalProtocolOptionsV1(url);
        return {
            postgrestActiveConnectionURI: withSlsConnectionScheme(url, "postgrest"),
            ...protocol,
        };
    },
    pick: pickPostgRESTSettings,
    serialise(settings) {
        let parsed: ReturnType<typeof parseSlsConnectionUri>;
        try {
            parsed = parseSlsConnectionUri(settings.postgrestActiveConnectionURI);
        } catch {
            throw new Error("Invalid PostgREST connection URI");
        }
        const { scheme, url } = parsed;
        if (scheme !== "postgrest") {
            throw new Error("Invalid PostgREST connection URI");
        }
        const protocol = resolvePostgRESTProtocol(settings);
        applyJournalProtocolOptionsV1(url, protocol);
        return withSlsConnectionScheme(url, "postgrest");
    },
    suggestName(settings) {
        try {
            const { url } = parseSlsConnectionUri(settings.postgrestActiveConnectionURI);
            return url.host ? `PostgREST ${url.host}` : "PostgREST remote";
        } catch {
            return "PostgREST remote";
        }
    },
};
