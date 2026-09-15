import { P2PConnectionPaths, P2PMessageSizePresets, type P2PConnectionPath } from "./setting.const";
import type { IceServerSourceConfiguration, P2PConnectionInfo } from "./setting.type";

const MANUAL_ICE_SERVER_SOURCE_ID = "manual";

type P2PSourceSettings = {
    P2P_iceServerSource?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as IceServerSourceConfiguration);
}

/** Report whether the selected P2P settings require a managed ICE source. */
export function hasManagedP2PIceServerSource(settings: P2PSourceSettings): boolean {
    const source = settings.P2P_iceServerSource;
    if (source === undefined || source === null) return false;
    // Invalid explicit selections must reach source validation rather than use manual credentials.
    return !isIceServerSourceConfiguration(source) || !isManualIceServerSourceConfiguration(source);
}

/**
 * Report whether a P2P profile has a usable manual TURN endpoint or a managed
 * source descriptor. STUN-only profiles remain false.
 */
export function hasP2PTurnConfiguration(
    settings: Partial<Pick<P2PConnectionInfo, "P2P_turnServers" | "P2P_iceServerSource">>
): boolean {
    return (
        hasManagedP2PIceServerSource(settings) ||
        (typeof settings.P2P_turnServers === "string" && hasValidP2PTurnServerUrl(settings.P2P_turnServers))
    );
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
