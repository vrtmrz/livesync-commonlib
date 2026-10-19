import { DOCID_SYNC_PARAMETERS, type EntryDoc, type RemoteDBSettings } from "../common/types.ts";
import { isObfuscatedEntry, parseHeaderValues } from "../common/utils.ts";
import { getConfiguredFunctionsForEncryption, isEncryptedMeta } from "../pouchdb/encryption.ts";
import { isPathProbablyObfuscated } from "octagonal-wheels/encryption/encryption";
import { decompressDoc } from "../pouchdb/compress.ts";
import { AuthorizationHeaderGenerator, generateCredentialObject } from "../replication/httplib.ts";
import { base64ToArrayBuffer } from "../string_and_binary/convert.ts";
import { DiagnosticReadError, type DiagnosticDatabaseSource } from "./types.ts";

export interface CouchDBDiagnosticSourceOptions {
    settings: RemoteDBSettings;
    fetch(request: string, options: RequestInit): Promise<Response>;
    signal?: AbortSignal;
}

/**
 * Open an operation-owned HTTP reader. All requests are GETs, including the
 * Security Seed lookup; the replication connection and its setup paths are
 * deliberately absent from this boundary.
 */
export function createCouchDBDiagnosticSource({
    settings: originalSettings,
    fetch,
    signal,
}: CouchDBDiagnosticSourceOptions): DiagnosticDatabaseSource & { close(): Promise<void> } {
    const settings = { ...originalSettings };
    const root = `${settings.couchDB_URI.replace(/\/+$/, "")}/${encodeURIComponent(settings.couchDB_DBNAME)}`;
    const url = new URL(root);
    if (!settings.couchDB_DBNAME || !["https:", "http:"].includes(url.protocol) || url.search || url.hash) {
        throw new DiagnosticReadError("source-unavailable");
    }
    if (settings.encrypt && !settings.passphrase && !settings.permitEmptyPassphrase) {
        throw new DiagnosticReadError("source-unavailable");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const auth = new AuthorizationHeaderGenerator();
    const credentials = generateCredentialObject(settings);
    const headers = new Headers(parseHeaderValues(settings.couchDB_CustomHeaders));
    const checkCancelled = () => {
        if (controller.signal.aborted) throw new DOMException("Diagnostic cancelled", "AbortError");
    };
    const readJSON = async (path: string, parameters: Record<string, string> = {}): Promise<unknown> => {
        checkCancelled();
        const requestURL = new URL(`${root}${path}`);
        for (const [key, value] of Object.entries(parameters)) requestURL.searchParams.set(key, value);
        headers.set("authorization", await auth.getAuthorizationHeader(credentials));
        checkCancelled();
        const response = await fetch(requestURL.toString(), {
            method: "GET",
            headers,
            cache: "no-store",
            signal: controller.signal,
        });
        checkCancelled();
        if (!response.ok) throw new DiagnosticReadError("document-unreadable", response.status === 404);
        const result: unknown = await response.json();
        checkCancelled();
        return result;
    };
    let salt: Promise<Uint8Array<ArrayBuffer>> | undefined;
    const readSalt = () =>
        (salt ??= (async () => {
            try {
                const parameters = (await readJSON(`/${DOCID_SYNC_PARAMETERS}`)) as { pbkdf2salt?: unknown };
                if (typeof parameters.pbkdf2salt !== "string" || !parameters.pbkdf2salt) {
                    throw new DiagnosticReadError("security-seed-unavailable");
                }
                const bytes = new Uint8Array(base64ToArrayBuffer(parameters.pbkdf2salt));
                if (!bytes.length) throw new DiagnosticReadError("security-seed-unavailable");
                return bytes;
            } catch {
                checkCancelled();
                throw new DiagnosticReadError("security-seed-unavailable");
            }
        })());
    const decrypt = settings.encrypt
        ? getConfiguredFunctionsForEncryption(
              settings.passphrase,
              settings.useDynamicIterationCount,
              false,
              readSalt,
              settings.E2EEAlgorithm,
              false,
              () => {}
          ).outgoing
        : async (doc: EntryDoc) => doc;
    return {
        async info() {
            const info = (await readJSON("")) as { update_seq?: string | number };
            return { update_seq: info.update_seq };
        },
        async *enumerateIds() {
            let previous: string | undefined;
            while (true) {
                const parameters: Record<string, string> = { limit: "256" };
                if (previous !== undefined) {
                    parameters.startkey = JSON.stringify(previous);
                    parameters.skip = "1";
                }
                const page = (await readJSON("/_all_docs", parameters)) as {
                    rows?: { id: string; value?: { deleted?: boolean } }[];
                };
                if (!Array.isArray(page.rows)) throw new DiagnosticReadError("source-unavailable");
                if (page.rows.length === 0) return;
                for (const row of page.rows) {
                    checkCancelled();
                    if (typeof row.id !== "string") throw new DiagnosticReadError("source-unavailable");
                    if (!row.value?.deleted) yield row.id;
                }
                const last = page.rows.at(-1)!.id;
                if (last === previous) throw new DiagnosticReadError("source-unavailable");
                previous = last;
                if (page.rows.length < 256) return;
            }
        },
        async get(id, options = {}) {
            const parameters: Record<string, string> = {};
            if (options.rev !== undefined) parameters.rev = options.rev;
            if (options.conflicts) parameters.conflicts = "true";
            if (options.revs) parameters.revs = "true";
            if (options.revs_info) parameters.revs_info = "true";
            const raw = (await readJSON(`/${encodeURIComponent(id)}`, parameters)) as EntryDoc;
            if (raw._id !== id || typeof raw._rev !== "string") {
                throw new DiagnosticReadError("document-unreadable");
            }
            const decoded = await decompressDoc(await decrypt(raw));
            if (
                ("e_" in decoded && decoded.e_ === true) ||
                ("path" in decoded &&
                    typeof decoded.path === "string" &&
                    (isEncryptedMeta(decoded) ||
                        (isObfuscatedEntry(decoded) && isPathProbablyObfuscated(decoded.path))))
            ) {
                throw new DiagnosticReadError("document-unreadable");
            }
            checkCancelled();
            return decoded;
        },
        close() {
            signal?.removeEventListener("abort", abort);
            controller.abort();
            return Promise.resolve();
        },
    };
}
