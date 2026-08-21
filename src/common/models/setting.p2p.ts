import { P2PConnectionPaths, P2PMessageSizePresets, type P2PConnectionPath } from "./setting.const";

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
