import { P2PConnectionPaths, P2PMessageSizePresets, type P2PConnectionPath } from "./setting.const";
import type { IceServerSourceConfiguration, P2PConnectionInfo } from "./setting.type";

const MANUAL_ICE_SERVER_SOURCE_ID = "manual";
const P2P_URI_PREFIX = "sls+p2p://";

type P2PSourceSettings = {
    P2P_iceServerSource?: unknown;
    encryptedP2PIceServerSource?: unknown;
    remoteConfigurations?: Record<string, { uri?: unknown } | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasManagedP2PSourceInURI(uri: unknown): boolean {
    if (typeof uri !== "string" || !uri.startsWith(P2P_URI_PREFIX)) return false;
    const queryStart = uri.indexOf("?");
    if (queryStart < 0) return false;
    const query = uri.slice(queryStart + 1).split("#", 1)[0];
    return new URLSearchParams(query).has("source");
}

/**
 * Check the common envelope without interpreting service-specific fields.
 * Unknown source identifiers and versions deliberately pass this check so
 * that hosts can preserve them and report an explicit unsupported source.
 */
export function isIceServerSourceConfiguration(value: unknown): value is IceServerSourceConfiguration {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === "string" &&
        value.id.trim().length > 0 &&
        typeof value.version === "number" &&
        Number.isSafeInteger(value.version) &&
        value.version >= 0 &&
        isRecord(value.configuration)
    );
}

/** A manual descriptor is recognised only at the version reserved for it. */
export function isManualIceServerSourceConfiguration(value: IceServerSourceConfiguration): boolean {
    return value.version === 1 && value.id.trim().toLowerCase() === MANUAL_ICE_SERVER_SOURCE_ID;
}

/** Clone a source descriptor before it crosses a settings ownership boundary. */
export function cloneIceServerSourceConfiguration(
    value: IceServerSourceConfiguration | undefined
): IceServerSourceConfiguration | undefined {
    if (!value) return undefined;

    const cloneConfigurationValue = (configurationValue: unknown): unknown => {
        if (Array.isArray(configurationValue)) return configurationValue.map(cloneConfigurationValue);
        if (isRecord(configurationValue)) {
            return Object.fromEntries(
                Object.entries(configurationValue).map(([key, nestedValue]) => [
                    key,
                    cloneConfigurationValue(nestedValue),
                ])
            );
        }
        return configurationValue;
    };

    return {
        version: value.version,
        id: value.id,
        configuration: cloneConfigurationValue(value.configuration) as Record<string, unknown>,
    };
}

/**
 * Report whether settings contain a managed ICE source.
 *
 * The optional remote configuration scan is intentional: inactive P2P
 * profiles also contain source credentials which reports must redact. A saved
 * encrypted top-level source is considered managed until it is decrypted, so
 * callers cannot silently treat an unavailable profile as manual.
 */
export function hasManagedP2PIceServerSource(settings: P2PSourceSettings): boolean {
    if (typeof settings.encryptedP2PIceServerSource === "string" && settings.encryptedP2PIceServerSource !== "") {
        return true;
    }

    const source = settings.P2P_iceServerSource;
    if (isIceServerSourceConfiguration(source)) {
        if (!isManualIceServerSourceConfiguration(source)) return true;
    } else if (source !== undefined && source !== null) {
        // Preserve an invalid non-manual value as managed for safety. The
        // source catalogue will reject it explicitly instead of selecting
        // manual TURN fields as a fallback.
        return true;
    }

    for (const configuration of Object.values(settings.remoteConfigurations ?? {})) {
        if (hasManagedP2PSourceInURI(configuration?.uri)) return true;
    }
    return false;
}

/**
 * Report whether a P2P profile has a usable manual TURN endpoint or a managed
 * source descriptor. STUN-only profiles remain false.
 */
export function hasP2PTurnConfiguration(
    settings: Partial<
        Pick<P2PConnectionInfo, "P2P_turnServers" | "P2P_iceServerSource" | "encryptedP2PIceServerSource">
    >
): boolean {
    // Deliberately project only the selected P2P source. A full settings
    // object may also contain inactive managed profiles, which do not provide
    // TURN configuration for the currently selected transport.
    if (
        hasManagedP2PIceServerSource({
            P2P_iceServerSource: settings.P2P_iceServerSource,
            encryptedP2PIceServerSource: settings.encryptedP2PIceServerSource,
        })
    ) {
        return true;
    }
    return typeof settings.P2P_turnServers === "string" && hasValidP2PTurnServerUrl(settings.P2P_turnServers);
}

/**
 * Return a safe outgoing RPC wire-payload bound for Trystero.
 *
 * Existing profiles can omit this value. Invalid, excessively small, and
 * excessively large values retain the established 15,360-byte behaviour.
 */
export function normaliseP2PMaxWirePayloadBytes(value: unknown): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < P2PMessageSizePresets.MaximumCompatibility ||
        value > P2PMessageSizePresets.Standard
    ) {
        return P2PMessageSizePresets.Standard;
    }
    return value;
}

/** Return a recognised P2P connection path, defaulting legacy values to automatic selection. */
export function normaliseP2PConnectionPath(value: unknown): P2PConnectionPath {
    return value === P2PConnectionPaths.Relay ? P2PConnectionPaths.Relay : P2PConnectionPaths.Automatic;
}

/** Split the stored comma-separated signalling relay list without changing its entries. */
export function splitP2PRelayUrls(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Split the stored comma-separated TURN server list without changing its entries. */
export function splitP2PTurnServerUrls(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/**
 * Report whether a value is a minimally valid TURN or TURN-over-TLS URL.
 *
 * Full allocation validation remains the responsibility of WebRTC. This
 * check only prevents relay-only mode when no TURN endpoint can be attempted.
 */
export function isValidP2PTurnServerUrl(value: string): boolean {
    const candidate = value.trim();
    if (!candidate || /\s/.test(candidate)) return false;
    try {
        const parsed = new URL(candidate);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol !== "turn:" && protocol !== "turns:") return false;
        return (parsed.hostname || parsed.pathname).length > 0;
    } catch {
        return false;
    }
}

/** Report whether a stored TURN server list contains at least one usable TURN URL. */
export function hasValidP2PTurnServerUrl(value: string): boolean {
    return splitP2PTurnServerUrls(value).some(isValidP2PTurnServerUrl);
}
