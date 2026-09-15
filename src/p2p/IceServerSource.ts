import { isIceServerSourceConfiguration, isManualIceServerSourceConfiguration } from "@lib/common/models/setting.p2p";

/** ICE servers resolved for one P2P room generation. */
export interface IceServerConfiguration {
    readonly iceServers: readonly RTCIceServer[];
    /** Local Unix timestamp in milliseconds, or `null` for manual configuration. */
    readonly expiresAt: number | null;
}

/** Acquires one temporary ICE server configuration. */
export interface IceServerSource {
    acquire(signal: AbortSignal): Promise<IceServerConfiguration>;
}

/** Constructs a source after validating its persisted, service-specific configuration. */
export type IceServerSourceFactory = (configuration: Readonly<Record<string, unknown>>) => IceServerSource;

/** Closed host-supplied catalogue of supported managed ICE server sources. */
export type IceServerSourceFactoryCatalogue = Readonly<Record<string, IceServerSourceFactory>>;

export type IceServerSourceFailureCode = "configuration" | "authentication" | "unavailable" | "invalid-response";

/** Safe failure which can be shown or logged without exposing source configuration or issued credentials. */
export class IceServerSourceError extends Error {
    override readonly name = "IceServerSourceError";

    constructor(
        readonly code: IceServerSourceFailureCode,
        message: string,
        readonly retryable: boolean
    ) {
        super(message);
    }
}

export const ICE_SERVER_ACQUISITION_TIMEOUT_MS = 30_000;
export const ICE_SERVER_MINIMUM_REMAINING_LIFETIME_MS = 30_000;

const MAX_ICE_SERVER_ENTRIES = 16;
const MAX_ICE_SERVER_URLS = 32;
const MAX_ICE_SERVER_URL_LENGTH = 2_048;
const MAX_ICE_SERVER_CREDENTIAL_LENGTH = 4_096;
const MAX_SOURCE_CONFIGURATION_LENGTH = 65_536;
const MAX_ICE_SERVER_RESPONSE_LENGTH = 65_536;
const SUPPORTED_SOURCE_VERSION = 1;

export type ResolvedIceServerSelection =
    | { readonly kind: "manual"; readonly identity: "manual" }
    | {
          readonly kind: "managed";
          readonly identity: string;
          readonly configuration: Readonly<Record<string, unknown>>;
          readonly factory: IceServerSourceFactory;
      };

function configurationError(message: string): IceServerSourceError {
    return new IceServerSourceError("configuration", message, false);
}

function invalidResponseError(): IceServerSourceError {
    return new IceServerSourceError("invalid-response", "The ICE server source returned an invalid response.", false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfigurationValue(value: unknown, seen: Set<object>): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw configurationError("The ICE server source configuration is invalid.");
        return value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw configurationError("The ICE server source configuration is invalid.");
        seen.add(value);
        const copy = value.map((item) => cloneConfigurationValue(item, seen));
        seen.delete(value);
        return copy;
    }
    if (isRecord(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw configurationError("The ICE server source configuration is invalid.");
        }
        if (seen.has(value)) throw configurationError("The ICE server source configuration is invalid.");
        seen.add(value);
        const copy = Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, cloneConfigurationValue(value[key], seen)])
        );
        seen.delete(value);
        return copy;
    }
    throw configurationError("The ICE server source configuration is invalid.");
}

function cloneSourceConfiguration(configuration: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(configuration)) {
        throw configurationError("The ICE server source configuration is invalid.");
    }
    const copy = cloneConfigurationValue(configuration, new Set<object>()) as Record<string, unknown>;
    const encoded = JSON.stringify(copy);
    if (encoded.length > MAX_SOURCE_CONFIGURATION_LENGTH) {
        throw configurationError("The ICE server source configuration is too large.");
    }
    return Object.freeze(copy);
}

/**
 * Produce a deterministic private identity for the selected source.
 *
 * Callers must keep this value out of logs and diagnostics because it includes
 * every effective source setting, including credentials.
 */
export function getIceServerSourceIdentity(source: unknown): string {
    if (source === undefined) return "manual";
    if (!isIceServerSourceConfiguration(source)) {
        throw configurationError("The selected ICE server source configuration is invalid.");
    }
    const configuration = cloneSourceConfiguration(source.configuration);
    if (isManualIceServerSourceConfiguration(source)) return "manual";
    return JSON.stringify([source.version, source.id, configuration]);
}

/** Resolve and validate one persisted source selection without performing network activity. */
export function resolveIceServerSelection(
    source: unknown,
    catalogue: IceServerSourceFactoryCatalogue = {}
): ResolvedIceServerSelection {
    if (source === undefined) return { kind: "manual", identity: "manual" };
    if (!isIceServerSourceConfiguration(source)) {
        throw configurationError("The selected ICE server source configuration is invalid.");
    }
    if (source.version !== SUPPORTED_SOURCE_VERSION) {
        throw configurationError("The selected ICE server source version is not supported.");
    }
    if (typeof source.id !== "string" || source.id.length === 0) {
        throw configurationError("The selected ICE server source identifier is invalid.");
    }
    const configuration = cloneSourceConfiguration(source.configuration);
    if (isManualIceServerSourceConfiguration(source)) {
        return { kind: "manual", identity: "manual" };
    }
    const factory = Object.prototype.hasOwnProperty.call(catalogue, source.id) ? catalogue[source.id] : undefined;
    if (typeof factory !== "function") {
        throw configurationError("The selected ICE server source is not supported by this host.");
    }
    return {
        kind: "managed",
        identity: getIceServerSourceIdentity({ ...source, configuration }),
        configuration,
        factory,
    };
}

function normaliseUrls(urls: string | string[]): string[] {
    return typeof urls === "string" ? [urls] : urls;
}

function isSupportedIceUrl(url: string): boolean {
    if (url.trim() !== url || /\s/u.test(url)) return false;
    try {
        const parsed = new URL(url);
        return (
            ["stun:", "stuns:", "turn:", "turns:"].includes(parsed.protocol.toLowerCase()) &&
            (parsed.hostname || parsed.pathname).length > 0
        );
    } catch {
        return false;
    }
}

function isTurnUrl(url: string): boolean {
    return /^turns?:/iu.test(url);
}

/** Validate and copy an acquisition result before it crosses into Trystero. */
export function validateIceServerConfiguration(
    value: IceServerConfiguration,
    options: {
        readonly managed: boolean;
        readonly now?: number;
        readonly minimumRemainingLifetimeMs?: number;
    }
): IceServerConfiguration {
    if (!isRecord(value) || !Array.isArray(value.iceServers)) throw invalidResponseError();
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(value);
    } catch {
        throw invalidResponseError();
    }
    if (encoded === undefined || encoded.length > MAX_ICE_SERVER_RESPONSE_LENGTH) throw invalidResponseError();
    if (value.iceServers.length === 0 || value.iceServers.length > MAX_ICE_SERVER_ENTRIES) {
        throw invalidResponseError();
    }

    let totalUrls = 0;
    let hasTurn = false;
    const iceServers = value.iceServers.map((server): RTCIceServer => {
        if (!isRecord(server) || !(typeof server.urls === "string" || Array.isArray(server.urls))) {
            throw invalidResponseError();
        }
        const urls = normaliseUrls(server.urls as string | string[]);
        if (urls.length === 0) throw invalidResponseError();
        totalUrls += urls.length;
        if (totalUrls > MAX_ICE_SERVER_URLS) throw invalidResponseError();

        let entryHasTurn = false;
        for (const url of urls) {
            if (
                typeof url !== "string" ||
                url.length === 0 ||
                url.length > MAX_ICE_SERVER_URL_LENGTH ||
                !isSupportedIceUrl(url)
            ) {
                throw invalidResponseError();
            }
            entryHasTurn ||= isTurnUrl(url);
        }
        hasTurn ||= entryHasTurn;

        let username: string | undefined;
        if (server.username !== undefined) {
            if (typeof server.username !== "string" || server.username.length > MAX_ICE_SERVER_CREDENTIAL_LENGTH) {
                throw invalidResponseError();
            }
            username = server.username;
        }
        let credential: string | undefined;
        if (server.credential !== undefined) {
            if (typeof server.credential !== "string" || server.credential.length > MAX_ICE_SERVER_CREDENTIAL_LENGTH) {
                throw invalidResponseError();
            }
            credential = server.credential;
        }
        if (
            entryHasTurn &&
            (typeof username !== "string" ||
                username.length === 0 ||
                typeof credential !== "string" ||
                credential.length === 0)
        ) {
            throw invalidResponseError();
        }

        return Object.freeze({
            urls: [...urls],
            ...(username === undefined ? {} : { username }),
            ...(credential === undefined ? {} : { credential }),
        });
    });

    if (options.managed && !hasTurn) throw invalidResponseError();
    const expiresAt = value.expiresAt;
    if (options.managed) {
        const now = options.now ?? Date.now();
        const minimumRemainingLifetimeMs =
            options.minimumRemainingLifetimeMs ?? ICE_SERVER_MINIMUM_REMAINING_LIFETIME_MS;
        if (
            !Number.isFinite(now) ||
            !Number.isFinite(minimumRemainingLifetimeMs) ||
            minimumRemainingLifetimeMs < 0 ||
            !Number.isFinite(expiresAt) ||
            (expiresAt as number) <= now + minimumRemainingLifetimeMs
        ) {
            throw invalidResponseError();
        }
    } else if (expiresAt !== null && !Number.isFinite(expiresAt)) {
        throw invalidResponseError();
    }

    return Object.freeze({ iceServers: Object.freeze(iceServers), expiresAt });
}

/** Convert an arbitrary source exception into a credential-safe failure. */
export function toSafeIceServerSourceError(error: unknown): IceServerSourceError {
    if (error instanceof IceServerSourceError) return error;
    return new IceServerSourceError("unavailable", "The ICE server source could not provide credentials.", true);
}
