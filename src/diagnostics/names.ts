import { Sha256 } from "@aws-crypto/sha256-js";
import type { DiagnosticNameMode } from "./types.ts";

export interface DiagnosticNameMapper {
    readonly mode: DiagnosticNameMode;
    readonly salt?: string;
    path(value: string): string;
    id(value: string): string;
    revision(value: string): string;
    chunk(value: string): string;
}

const SALT_PATTERN = /^[A-Za-z0-9_-]{8}$/;

/** Reads only a complete version-one path token, never a document or revision alias. */
export function parseDiagnosticPathToken(value: string): { salt: string; hash: string } | undefined {
    const match = /^([A-Za-z0-9_-]{8})\$([0-9a-f]{32})$/.exec(value);
    return match ? { salt: match[1], hash: match[2] } : undefined;
}

function randomSalt(): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
}

function nameHash(salt: string, domain: string, value: string): string {
    const hash = new Sha256();
    hash.update(JSON.stringify(["livesync-diagnostic-v1", salt, domain, value]));
    return Array.from(hash.digestSync().subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reuses public report salts without storing paths or a correspondence table outside this mapper. */
export function createDiagnosticNameMapper(mode: DiagnosticNameMode, suppliedSalt?: string): DiagnosticNameMapper {
    if (mode === "original") {
        const original = (value: string) => value;
        return { mode, path: original, id: original, revision: original, chunk: original };
    }
    const salt = suppliedSalt ?? randomSalt();
    if (!SALT_PATTERN.test(salt)) throw new Error("Invalid diagnostic salt");
    const domainMapper = (domain: string, format: (hash: string, value: string) => string) => {
        const aliases = new Map<string, string>();
        return (value: string): string => {
            const existing = aliases.get(value);
            if (existing !== undefined) return existing;
            const alias = format(nameHash(salt, domain, value), value);
            if (aliases.size >= 4096) aliases.clear();
            aliases.set(value, alias);
            return alias;
        };
    };
    return {
        mode,
        salt,
        path: domainMapper("path", (hash) => `${salt}$${hash}`),
        id: domainMapper("document", (hash) => `document-${hash}`),
        revision: domainMapper("revision", (hash, value) => {
            const generation = /^([1-9][0-9]*)-.+$/.exec(value)?.[1];
            const prefix = generation !== undefined && Number.isSafeInteger(Number(generation)) ? `${generation}-` : "";
            return `${prefix}psu${hash}`;
        }),
        chunk: domainMapper("chunk", (hash) => `chunk-${hash}`),
    };
}
