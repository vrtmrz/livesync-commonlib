import {
    TweakValuesShouldMatchedTemplate,
    type EncryptionSettings,
    type ObsidianLiveSyncSettings,
    type P2PSyncSetting,
} from "@lib/common/types";
import { configuredIdKey, computeKeyedId } from "@lib/common/idDerivation.ts";
import { assessTweakCompatibility } from "@lib/common/models/tweak.compatibility.ts";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization.ts";
import { getWebCrypto } from "@lib/mods.ts";
import type { P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import { uint8ArrayToHexString } from "@lib/string_and_binary/convert.ts";
import { Logger, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type LOG_LEVEL } from "octagonal-wheels/common/logger";
import { bindContext } from "octagonal-wheels/context";
import { cloneViaJSON } from "octagonal-wheels/encoding/json";
import { sha1 } from "octagonal-wheels/hash/purejs";
import { authenticationFailureDiagnostic, authenticationResultDiagnostic } from "../p2pReplicationDiagnostics";

/** Agreement data contains a passphrase digest and challenge proof, never the ID key. */
export type PeerTweakSettings = Partial<ObsidianLiveSyncSettings> & {
    pathNormalizationVersion: ReturnType<typeof getPathNormalizationVersion>;
    idDerivationVersion: NonNullable<EncryptionSettings["idDerivationVersion"]>;
    idDerivationProof: string;
};

/** Narrow RPC operations on a connection captured before asynchronous validation. */
export interface PeerAgreementConnection {
    requestAuthentication(timeoutMs: number, signal?: AbortSignal): Promise<boolean | undefined>;
    requestTweakSettings(challenge: string, timeoutMs: number, signal?: AbortSignal): Promise<PeerTweakSettings>;
}

export interface PeerAgreementHost {
    peerPlatform(peerId: string): string | undefined;
    connection(peerId: string): PeerAgreementConnection;
}

/** The authentication operation uses only the authentication method on a captured connection. */
interface PeerAuthenticationHost {
    connection(peerId: string): Pick<PeerAgreementConnection, "requestAuthentication">;
}

/**
 * The host owns room binding, database validation, and presentation authority.
 * Snapshot settings describe the room; current settings supply policy and identity
 * metadata at the same stages as the original replicator implementation.
 */
export interface PeerAgreementDependencies {
    host(): PeerAgreementHost | undefined;
    settings(): P2PSyncSetting;
    currentSettings(): P2PSyncSetting;
    platform(): string;
    assertPathIdentity(settings: P2PSyncSetting): Promise<void>;
    /** Resolve through the facade so host overrides and observers remain effective. */
    localTweakSettings(challenge: string): Promise<PeerTweakSettings>;
    reportDiagnostic(input: P2PDiagnosticInput): void;
}

/** Settings and path-identity capabilities used to produce a peer's tweak response. */
export type GetTweakSettingsDependencies = Pick<
    PeerAgreementDependencies,
    "settings" | "currentSettings" | "assertPathIdentity"
>;

/** Host and diagnostic capabilities used to request peer authentication. */
export type RequestAuthenticateDependencies = Pick<PeerAgreementDependencies, "reportDiagnostic"> & {
    host(): PeerAuthenticationHost | undefined;
};

/** Host and local-policy capabilities used to compare peer tweak settings. */
export type CheckTweakValuesDependencies = Pick<PeerAgreementDependencies, "host" | "platform" | "localTweakSettings">;

export interface PeerAgreement {
    getTweakSettings(challenge: string): Promise<PeerTweakSettings>;
    requestAuthenticate(peerId: string, signal?: AbortSignal): Promise<boolean | undefined>;
    checkTweakValues(peerId: string, signal?: AbortSignal, logLevel?: LOG_LEVEL): Promise<boolean>;
}

/** Construct stateless agreement operations without reading the host or starting RPC. */
export function createPeerAgreement(deps: PeerAgreementDependencies): PeerAgreement {
    return {
        getTweakSettings: bindContext(deps, getTweakSettings),
        requestAuthenticate: bindContext(deps, requestAuthenticate),
        checkTweakValues: bindContext(deps, checkTweakValues),
    };
}

/** Retain the existing three-minute comparison window and Base64 SHA-1 wire digest. */
async function hashPassphrase(source: string): Promise<string> {
    const salt = (~~(new Date().getTime() / 1000 / 180)).toString(36);
    const salt2 = await sha1(salt);
    return await sha1(salt2 + source);
}

/**
 * Build the settings response for an opaque challenge (historically named peer ID).
 * Validate current path identity first, then project the room snapshot's matched
 * tweak fields. Read current ID settings separately, preserving that policy stage.
 * The passphrase is hashed and the ID key becomes a challenge-bound proof.
 */
export async function getTweakSettings(
    deps: GetTweakSettingsDependencies,
    challenge: string
): Promise<PeerTweakSettings> {
    const currentSettings = deps.currentSettings();
    const pathNormalizationVersion = getPathNormalizationVersion(currentSettings);
    if (pathNormalizationVersion === 1) {
        await deps.assertPathIdentity(currentSettings);
    }
    const allSettings = cloneViaJSON(deps.settings()) as Partial<ObsidianLiveSyncSettings>;
    for (const key in allSettings) {
        if (key == "encrypt") {
            continue;
        }
        if (key == "passphrase") {
            // Different passphrases produce different chunk IDs, even with otherwise matching tweaks.
            allSettings[key] = await hashPassphrase(allSettings[key] ?? "");
            continue;
        }
        if (!(key in TweakValuesShouldMatchedTemplate)) {
            delete allSettings[key as keyof ObsidianLiveSyncSettings];
        }
    }
    const idSettings = deps.currentSettings() as P2PSyncSetting &
        Partial<Pick<EncryptionSettings, "idDerivationVersion" | "idDerivationKey" | "encrypt" | "usePathObfuscation">>;
    const idDerivationVersion = idSettings.idDerivationVersion ?? 0;
    const idKey = configuredIdKey({ idDerivationVersion, idDerivationKey: idSettings.idDerivationKey ?? "" });
    return {
        ...allSettings,
        pathNormalizationVersion,
        idDerivationVersion,
        idDerivationProof:
            idKey && idSettings.encrypt && idSettings.usePathObfuscation
                ? await computeKeyedId(idKey, "peer-agreement", challenge)
                : "",
    };
}

/**
 * Ask the captured host for admission using the existing 20-second RPC deadline.
 * Preserve its result for the caller's strict acceptance check. Missing hosts and
 * RPC failures return false; failures retain the existing redacted diagnostics.
 */
export async function requestAuthenticate(
    deps: RequestAuthenticateDependencies,
    peerId: string,
    signal?: AbortSignal
): Promise<boolean | undefined> {
    const host = deps.host();
    if (!host) {
        return false;
    }
    try {
        const connection = host.connection(peerId);
        const result = await connection.requestAuthentication(20000, signal);
        deps.reportDiagnostic(authenticationResultDiagnostic(peerId, result));
        return result;
    } catch (error) {
        deps.reportDiagnostic(authenticationFailureDiagnostic(peerId, error, signal));
        Logger("Error while requesting authentication", LOG_LEVEL_VERBOSE);
        Logger(error, LOG_LEVEL_VERBOSE);
        return false;
    }
}

/**
 * Compare peer compatibility within the initiating call's logging authority.
 * Capture the connection before generating the challenge. Path identity is checked
 * before the pseudo-replicator exception; ordinary peers then require matching
 * content and ID settings. Representation-only differences warn and still pass.
 * RPC/local-validation errors propagate; an observed abort after RPC returns false.
 */
export async function checkTweakValues(
    deps: CheckTweakValuesDependencies,
    peerId: string,
    signal?: AbortSignal,
    logLevel: LOG_LEVEL = LOG_LEVEL_NOTICE
): Promise<boolean> {
    const host = deps.host();
    if (!host) {
        Logger("Server is not available", logLevel);
        return false;
    }
    const peerPlatform = host.peerPlatform(peerId);
    if (peerPlatform == null) {
        Logger("Peer is not found", logLevel);
        return false;
    }
    const connection = host.connection(peerId);
    const challengeBytes = new Uint8Array(16);
    (await getWebCrypto()).getRandomValues(challengeBytes);
    const challenge = uint8ArrayToHexString(challengeBytes);
    const tweakValues = await connection.requestTweakSettings(challenge, 5000, signal);
    if (signal?.aborted) {
        return false;
    }
    const thisTweakValues = await deps.localTweakSettings(challenge);
    const localPathNormalizationVersion = getPathNormalizationVersion(thisTweakValues);
    const peerPathNormalizationVersion = getPathNormalizationVersion(tweakValues);
    if (localPathNormalizationVersion !== peerPathNormalizationVersion) {
        Logger("Replication cancelled: The path identity mode does not match this peer.", logLevel);
        return false;
    }
    if (deps.platform() === "pseudo-replicator" || peerPlatform === "pseudo-replicator") {
        return true;
    }
    if (thisTweakValues.passphrase !== tweakValues.passphrase) {
        Logger(
            "Replication cancelled: Passphrase is not matched\nCannot replicate to a remote database until the problem is resolved.",
            logLevel
        );
        return false;
    }
    if (
        thisTweakValues.encrypt !== tweakValues.encrypt ||
        thisTweakValues.usePathObfuscation !== tweakValues.usePathObfuscation
    ) {
        Logger("Replication cancelled: The encryption or path obfuscation settings do not match this peer.", logLevel);
        return false;
    }
    if (
        thisTweakValues.encrypt &&
        thisTweakValues.usePathObfuscation &&
        ((thisTweakValues.idDerivationVersion ?? 0) !== (tweakValues.idDerivationVersion ?? 0) ||
            (thisTweakValues.idDerivationProof ?? "") !== (tweakValues.idDerivationProof ?? ""))
    ) {
        Logger("Replication cancelled: The ID derivation settings do not match this peer.", logLevel);
        return false;
    }
    const tweakAssessment = assessTweakCompatibility(thisTweakValues, tweakValues);
    if (!tweakAssessment.representationDiffers) {
        return true;
    }
    Logger(
        "Some mismatched configuration have been detected... Please check settings for efficient replication.",
        logLevel
    );
    return true;
}
