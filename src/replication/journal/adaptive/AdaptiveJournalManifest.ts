import { getWebCrypto } from "@lib/mods.ts";

import {
    base64UrlToBytes,
    bytesEqual,
    bytesToBase64Url,
    canonicalJsonBytes,
    concatBytes,
    decodeUtf8,
    fixedLength,
    u16be,
    u32be,
    utf8Bytes,
} from "./AdaptiveJournalBinary.ts";

export type AdaptiveJournalErrorCode =
    | "batch-limit-exceeded"
    | "commit-limit-exceeded"
    | "encryption-mode-mismatch"
    | "invalid-batch-envelope"
    | "invalid-catalogue-record"
    | "invalid-commit-envelope"
    | "invalid-commit-record"
    | "invalid-manifest"
    | "invalid-metadata-payload"
    | "invalid-pack"
    | "invalid-record-frame"
    | "invalid-writer-descriptor"
    | "manifest-authentication-failed"
    | "metadata-payload-limit-exceeded"
    | "non-canonical-manifest"
    | "pack-limit-exceeded"
    | "pending-commit-mismatch"
    | "pending-writer-descriptor-mismatch"
    | "record-decompression-failed"
    | "record-integrity-failed"
    | "record-limit-exceeded"
    | "remote-operation-failed"
    | "repository-already-exists"
    | "repository-id-mismatch"
    | "repository-missing"
    | "required-capability-missing"
    | "pending-initialisation-mismatch"
    | "unexpected-batch-direction"
    | "unsupported-batch-operation"
    | "unsupported-batch-version"
    | "unsupported-commit-version"
    | "unsupported-record-codec"
    | "unsupported-record-kind"
    | "unsupported-record-version"
    | "writer-sequence-mismatch";

export class AdaptiveJournalError extends Error {
    constructor(
        readonly code: AdaptiveJournalErrorCode,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = "AdaptiveJournalError";
    }
}

export type AdaptiveJournalEncryption = "encrypted" | "unencrypted";

export type AdaptiveJournalRoleV1 =
    | "manifest-auth"
    | "chunk-identity"
    | "chunk-record"
    | "metadata-record"
    | "commit-record"
    | "writer-record"
    | "writer-name";

export const ADAPTIVE_JOURNAL_ROLES_V1: readonly AdaptiveJournalRoleV1[] = [
    "manifest-auth",
    "chunk-identity",
    "chunk-record",
    "metadata-record",
    "commit-record",
    "writer-record",
    "writer-name",
];

export const ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 = [
    "binary-fidelity",
    "complete-listing",
    "conditional-create",
    "delete-visibility",
    "read-after-write",
] as const;

export const ADAPTIVE_JOURNAL_NATIVE_REQUIRED_CAPABILITIES_V1 = [
    ...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
    "native-batch-chunk-cas",
    "server-side-immutable-cas",
    "transactional-metadata-commit",
    "writer-discovery",
    "commit-discovery",
    "transactional-vault-reset",
] as const;

export interface AdaptiveJournalManifestV1 {
    chunkKeyMode: "hmac-sha256" | "repository-scoped-sha256";
    cipherSuite: "aes-256-gcm" | "none";
    format: "adaptive-journal";
    formatVersion: 1;
    manifestAuth: string;
    objectLayout: "commit-bundle-v1";
    passwordKdf: {
        iterations: 310000;
        name: "pbkdf2-hmac-sha256";
        outputBytes: 32;
    };
    recordKdf: "hkdf-sha256";
    repositoryId: string;
    requiredCapabilities: typeof ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1;
    securitySeed: string;
}

export interface AdaptiveJournalKeySetV1 {
    readonly encryption: AdaptiveJournalEncryption;
    readonly repositoryId: Uint8Array;
    readonly roleKeys?: ReadonlyMap<AdaptiveJournalRoleV1, Uint8Array>;
}

export interface AdaptiveJournalManifestCandidateV1 {
    bytes: Uint8Array;
    digest: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    manifest: AdaptiveJournalManifestV1;
}

export interface CreateAdaptiveJournalManifestV1Options {
    encryption: AdaptiveJournalEncryption;
    passphrase?: string;
    repositoryId?: Uint8Array;
    securitySeed?: Uint8Array;
}

export interface VerifyAdaptiveJournalManifestV1Options {
    expectedEncryption: AdaptiveJournalEncryption;
    expectedRepositoryId?: string;
    passphrase: string;
}

const MANIFEST_PASSWORD_KDF = {
    iterations: 310000,
    name: "pbkdf2-hmac-sha256",
    outputBytes: 32,
} as const;

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(bytes)));
}

export async function hmacSha256(keyBytes: Uint8Array, bytes: Uint8Array): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const key = await crypto.subtle.importKey("raw", owned(keyBytes), { hash: "SHA-256", name: "HMAC" }, false, [
        "sign",
    ]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, owned(bytes)));
}

export async function hkdfSha256(
    inputKey: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    outputBytes = 32
): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const key = await crypto.subtle.importKey("raw", owned(inputKey), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { hash: "SHA-256", info: owned(info), name: "HKDF", salt: owned(salt) },
        key,
        outputBytes * 8
    );
    return new Uint8Array(bits);
}

async function pbkdf2MasterKey(passphrase: string, securitySeed: Uint8Array): Promise<Uint8Array> {
    if (passphrase.length === 0) {
        throw new AdaptiveJournalError(
            "invalid-manifest",
            "Encrypted Adaptive Journal repositories require a passphrase"
        );
    }
    const crypto = await getWebCrypto();
    const passphraseKey = await crypto.subtle.importKey("raw", owned(utf8Bytes(passphrase)), "PBKDF2", false, [
        "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
        {
            hash: "SHA-256",
            iterations: MANIFEST_PASSWORD_KDF.iterations,
            name: "PBKDF2",
            salt: owned(securitySeed),
        },
        passphraseKey,
        MANIFEST_PASSWORD_KDF.outputBytes * 8
    );
    return new Uint8Array(bits);
}

async function deriveKeySet(
    encryption: AdaptiveJournalEncryption,
    repositoryId: Uint8Array,
    securitySeed: Uint8Array,
    passphrase: string
): Promise<AdaptiveJournalKeySetV1> {
    fixedLength(repositoryId, 32, "repositoryId");
    fixedLength(securitySeed, 32, "securitySeed");
    if (encryption === "unencrypted") {
        return { encryption, repositoryId: repositoryId.slice() };
    }
    const masterKey = await pbkdf2MasterKey(passphrase, securitySeed);
    const entries = await Promise.all(
        ADAPTIVE_JOURNAL_ROLES_V1.map(async (role) => {
            const roleKey = await hkdfSha256(
                masterKey,
                repositoryId,
                utf8Bytes(`livesync/adaptive-journal/v1/${role}`)
            );
            return [role, roleKey] as const;
        })
    );
    masterKey.fill(0);
    return {
        encryption,
        repositoryId: repositoryId.slice(),
        roleKeys: new Map(entries),
    };
}

export function adaptiveJournalRoleKeyV1(keys: AdaptiveJournalKeySetV1, role: AdaptiveJournalRoleV1): Uint8Array {
    const roleKey = keys.roleKeys?.get(role);
    if (keys.encryption !== "encrypted" || !roleKey) {
        throw new AdaptiveJournalError("encryption-mode-mismatch", `The ${role} role key is unavailable`);
    }
    return roleKey;
}

function manifestWithoutAuth(manifest: AdaptiveJournalManifestV1): Omit<AdaptiveJournalManifestV1, "manifestAuth"> {
    const { manifestAuth: _manifestAuth, ...unsigned } = manifest;
    return unsigned;
}

async function calculateManifestAuth(
    manifest: AdaptiveJournalManifestV1,
    keys: AdaptiveJournalKeySetV1
): Promise<Uint8Array> {
    const bytes = canonicalJsonBytes(manifestWithoutAuth(manifest));
    if (keys.encryption === "encrypted") {
        return await hmacSha256(adaptiveJournalRoleKeyV1(keys, "manifest-auth"), bytes);
    }
    return await sha256(bytes);
}

async function random32(): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytes;
}

/** Generates a non-secret repository identity before any remote object is written. */
export async function generateAdaptiveJournalRepositoryIdV1(): Promise<string> {
    return bytesToBase64Url(await random32());
}

function createManifestObject(
    encryption: AdaptiveJournalEncryption,
    repositoryId: Uint8Array,
    securitySeed: Uint8Array,
    manifestAuth: string
): AdaptiveJournalManifestV1 {
    return {
        chunkKeyMode: encryption === "encrypted" ? "hmac-sha256" : "repository-scoped-sha256",
        cipherSuite: encryption === "encrypted" ? "aes-256-gcm" : "none",
        format: "adaptive-journal",
        formatVersion: 1,
        manifestAuth,
        objectLayout: "commit-bundle-v1",
        passwordKdf: MANIFEST_PASSWORD_KDF,
        recordKdf: "hkdf-sha256",
        repositoryId: bytesToBase64Url(repositoryId),
        requiredCapabilities: ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
        securitySeed: bytesToBase64Url(securitySeed),
    };
}

export async function createAdaptiveJournalManifestV1(
    options: CreateAdaptiveJournalManifestV1Options
): Promise<AdaptiveJournalManifestCandidateV1> {
    const repositoryId = options.repositoryId?.slice() ?? (await random32());
    const securitySeed = options.securitySeed?.slice() ?? (await random32());
    fixedLength(repositoryId, 32, "repositoryId");
    fixedLength(securitySeed, 32, "securitySeed");
    const keys = await deriveKeySet(options.encryption, repositoryId, securitySeed, options.passphrase ?? "");
    const unsignedManifest = createManifestObject(options.encryption, repositoryId, securitySeed, "");
    const manifestAuth = await calculateManifestAuth(unsignedManifest, keys);
    const manifest = createManifestObject(
        options.encryption,
        repositoryId,
        securitySeed,
        bytesToBase64Url(manifestAuth)
    );
    const bytes = canonicalJsonBytes(manifest);
    return { bytes, digest: await sha256(bytes), keys, manifest };
}

function invalidManifest(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-manifest", message, cause === undefined ? undefined : { cause });
}

function parseManifestShape(value: unknown): AdaptiveJournalManifestV1 {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalidManifest("Manifest must be an object");
    const manifest = value as Record<string, unknown>;
    if (manifest.format === "adaptive-journal" && manifest.formatVersion === 1 && manifest.objectLayout === undefined) {
        throw invalidManifest("This Adaptive Journal uses the superseded object layout; the remote must be rebuilt");
    }
    const expectedKeys = [
        "chunkKeyMode",
        "cipherSuite",
        "format",
        "formatVersion",
        "manifestAuth",
        "objectLayout",
        "passwordKdf",
        "recordKdf",
        "repositoryId",
        "requiredCapabilities",
        "securitySeed",
    ];
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)) {
        throw invalidManifest("Manifest fields do not match Adaptive Journal v1");
    }
    if (manifest.format !== "adaptive-journal" || manifest.formatVersion !== 1) {
        throw invalidManifest("Manifest format is not Adaptive Journal v1");
    }
    if (manifest.objectLayout !== "commit-bundle-v1") {
        throw invalidManifest("Unsupported Adaptive Journal object layout; the remote must be rebuilt");
    }
    if (manifest.recordKdf !== "hkdf-sha256") throw invalidManifest("Unsupported record KDF");
    if (
        !manifest.passwordKdf ||
        typeof manifest.passwordKdf !== "object" ||
        Array.isArray(manifest.passwordKdf) ||
        JSON.stringify(manifest.passwordKdf) !== JSON.stringify(MANIFEST_PASSWORD_KDF)
    ) {
        throw invalidManifest("Unsupported password KDF parameters");
    }
    if (JSON.stringify(manifest.requiredCapabilities) !== JSON.stringify(ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1)) {
        throw invalidManifest("Unsupported required capability set");
    }
    if (
        typeof manifest.manifestAuth !== "string" ||
        typeof manifest.repositoryId !== "string" ||
        typeof manifest.securitySeed !== "string"
    ) {
        throw invalidManifest("Manifest identifiers and authentication value must be strings");
    }
    const encrypted = manifest.chunkKeyMode === "hmac-sha256" && manifest.cipherSuite === "aes-256-gcm";
    const unencrypted = manifest.chunkKeyMode === "repository-scoped-sha256" && manifest.cipherSuite === "none";
    if (!encrypted && !unencrypted) throw invalidManifest("Manifest encryption parameters are inconsistent");
    return manifest as unknown as AdaptiveJournalManifestV1;
}

export async function parseAndVerifyAdaptiveJournalManifestV1(
    bytes: Uint8Array,
    options: VerifyAdaptiveJournalManifestV1Options
): Promise<AdaptiveJournalManifestCandidateV1> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes));
    } catch (error) {
        throw invalidManifest("Manifest is not valid UTF-8 JSON", error);
    }
    const manifest = parseManifestShape(parsed);
    const canonical = canonicalJsonBytes(manifest);
    if (!bytesEqual(bytes, canonical)) {
        throw new AdaptiveJournalError("non-canonical-manifest", "Manifest bytes are not canonical JSON");
    }
    const encryption: AdaptiveJournalEncryption = manifest.cipherSuite === "aes-256-gcm" ? "encrypted" : "unencrypted";
    if (encryption !== options.expectedEncryption) {
        throw new AdaptiveJournalError(
            "encryption-mode-mismatch",
            "Manifest encryption does not match the local profile"
        );
    }
    let repositoryId: Uint8Array;
    let securitySeed: Uint8Array;
    let manifestAuth: Uint8Array;
    try {
        repositoryId = fixedLength(base64UrlToBytes(manifest.repositoryId), 32, "repositoryId");
        securitySeed = fixedLength(base64UrlToBytes(manifest.securitySeed), 32, "securitySeed");
        manifestAuth = fixedLength(base64UrlToBytes(manifest.manifestAuth), 32, "manifestAuth");
    } catch (error) {
        throw invalidManifest("Manifest contains an invalid binary field", error);
    }
    if (options.expectedRepositoryId !== undefined && options.expectedRepositoryId !== manifest.repositoryId) {
        throw new AdaptiveJournalError(
            "repository-id-mismatch",
            "Manifest repository ID does not match the pinned binding"
        );
    }
    const keys = await deriveKeySet(encryption, repositoryId, securitySeed, options.passphrase);
    const expectedAuth = await calculateManifestAuth(manifest, keys);
    if (!bytesEqual(manifestAuth, expectedAuth)) {
        throw new AdaptiveJournalError("manifest-authentication-failed", "Manifest authentication failed");
    }
    return { bytes: bytes.slice(), digest: await sha256(bytes), keys, manifest };
}

function canonicalChunkId(localChunkId: string): Uint8Array {
    const domain = utf8Bytes("livesync/adaptive-journal/v1/local-chunk-id");
    const value = utf8Bytes(localChunkId);
    return concatBytes(u16be(domain.byteLength), domain, u32be(value.byteLength), value);
}

export async function deriveRemoteChunkKeyV1(keys: AdaptiveJournalKeySetV1, localChunkId: string): Promise<Uint8Array> {
    if (localChunkId.length === 0) throw new TypeError("localChunkId must not be empty");
    const canonical = canonicalChunkId(localChunkId);
    if (keys.encryption === "encrypted") {
        return await hmacSha256(adaptiveJournalRoleKeyV1(keys, "chunk-identity"), canonical);
    }
    return await sha256(
        concatBytes(utf8Bytes("livesync/adaptive-journal/v1/public-chunk-identity"), keys.repositoryId, canonical)
    );
}

function canonicalWriterIdentity(hostId: string, writerEpoch: string): Uint8Array {
    const domain = utf8Bytes("livesync/adaptive-journal/v1/writer-stream");
    const host = utf8Bytes(hostId);
    const epoch = utf8Bytes(writerEpoch);
    return concatBytes(u16be(domain.byteLength), domain, u32be(host.byteLength), host, u32be(epoch.byteLength), epoch);
}

export async function deriveWriterStreamIdV1(
    keys: AdaptiveJournalKeySetV1,
    hostId: string,
    writerEpoch: string
): Promise<Uint8Array> {
    if (hostId.length === 0 || writerEpoch.length === 0) {
        throw new TypeError("hostId and writerEpoch must not be empty");
    }
    const canonical = canonicalWriterIdentity(hostId, writerEpoch);
    if (keys.encryption === "encrypted") {
        return await hmacSha256(adaptiveJournalRoleKeyV1(keys, "writer-name"), canonical);
    }
    return await sha256(
        concatBytes(utf8Bytes("livesync/adaptive-journal/v1/public-writer-name"), keys.repositoryId, canonical)
    );
}
