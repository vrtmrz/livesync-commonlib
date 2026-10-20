import { DOCID_SYNC_PARAMETERS, type EntryDoc, type RemoteDBSettings } from "../common/types.ts";
import { isObfuscatedEntry, parseHeaderValues } from "../common/utils.ts";
import { getConfiguredFunctionsForEncryption, isEncryptedMeta } from "../pouchdb/encryption.ts";
import { isPathProbablyObfuscated } from "octagonal-wheels/encryption/encryption";
import { decompressDoc } from "../pouchdb/compress.ts";
import { AuthorizationHeaderGenerator, generateCredentialObject } from "../replication/httplib.ts";
import { base64ToArrayBuffer } from "../string_and_binary/convert.ts";
import { DiagnosticReadError, type DiagnosticDatabaseSource, type DiagnosticDocumentReadResult } from "./types.ts";

const MAX_BULK_DOCUMENTS = 64;
const MAX_BULK_URL_LENGTH = 6000;

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
    const requestURL = (path: string, parameters: Record<string, string> = {}) => {
        const requestURL = new URL(`${root}${path}`);
        for (const [key, value] of Object.entries(parameters)) requestURL.searchParams.set(key, value);
        return requestURL.toString();
    };
    const readJSON = async (path: string, parameters: Record<string, string> = {}): Promise<unknown> => {
        checkCancelled();
        headers.set("authorization", await auth.getAuthorizationHeader(credentials));
        checkCancelled();
        const response = await fetch(requestURL(path, parameters), {
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
    const decode = async (id: string, value: unknown): Promise<EntryDoc> => {
        if (
            !value ||
            typeof value !== "object" ||
            !("_id" in value) ||
            value._id !== id ||
            !("_rev" in value) ||
            typeof value._rev !== "string"
        ) {
            throw new DiagnosticReadError("document-unreadable");
        }
        const decoded = await decompressDoc(await decrypt(value as EntryDoc));
        if (
            ("e_" in decoded && decoded.e_ === true) ||
            ("path" in decoded &&
                typeof decoded.path === "string" &&
                (isEncryptedMeta(decoded) || (isObfuscatedEntry(decoded) && isPathProbablyObfuscated(decoded.path))))
        )
            throw new DiagnosticReadError("document-unreadable");
        checkCancelled();
        return decoded;
    };
    const source: DiagnosticDatabaseSource & { close(): Promise<void> } = {
        async info() {
            const info = (await readJSON("")) as { update_seq?: string | number; doc_count?: number };
            return { update_seq: info.update_seq, doc_count: info.doc_count };
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
            return await decode(id, await readJSON(`/${encodeURIComponent(id)}`, parameters));
        },
        async getMany(ids, options = {}) {
            const result: DiagnosticDocumentReadResult[] = [];
            const parameters = (keys: string[]) => ({
                keys: JSON.stringify(keys),
                include_docs: "true",
                ...(options.conflicts ? { conflicts: "true" } : {}),
            });
            const readBatch = async (keys: string[]) => {
                if (!keys.length) return;
                let rows: {
                    key?: string;
                    id?: string;
                    error?: unknown;
                    value?: { deleted?: boolean };
                    doc?: unknown;
                }[];
                try {
                    const page = (await readJSON("/_all_docs", parameters(keys))) as { rows?: typeof rows };
                    if (!Array.isArray(page.rows)) throw new DiagnosticReadError("document-unreadable");
                    rows = page.rows;
                } catch {
                    checkCancelled();
                    // An endpoint failure does not establish that any requested document is absent.
                    result.push(...keys.map((id) => ({ id, error: new DiagnosticReadError("document-unreadable") })));
                    return;
                }
                for (let offset = 0; offset < keys.length; offset += 4) {
                    checkCancelled();
                    const decoded = await Promise.allSettled(
                        keys.slice(offset, offset + 4).map(async (id, index): Promise<DiagnosticDocumentReadResult> => {
                            try {
                                const row = rows[offset + index];
                                if (!row || row.key !== id) throw new DiagnosticReadError("document-unreadable");
                                if (row.error === "not_found" || row.value?.deleted)
                                    throw new DiagnosticReadError("document-unreadable", true);
                                if (row.error || row.id !== id) throw new DiagnosticReadError("document-unreadable");
                                return { id, document: await decode(id, row.doc) };
                            } catch (error) {
                                checkCancelled();
                                return {
                                    id,
                                    error:
                                        error instanceof DiagnosticReadError
                                            ? error
                                            : new DiagnosticReadError("document-unreadable"),
                                };
                            }
                        })
                    );
                    checkCancelled();
                    for (const outcome of decoded) {
                        if (outcome.status === "rejected") throw outcome.reason;
                        result.push(outcome.value);
                    }
                }
            };
            let pending: string[] = [];
            for (const id of ids) {
                checkCancelled();
                if (
                    pending.length >= MAX_BULK_DOCUMENTS ||
                    requestURL("/_all_docs", parameters([...pending, id])).length > MAX_BULK_URL_LENGTH
                ) {
                    await readBatch(pending);
                    pending = [];
                }
                if (requestURL("/_all_docs", parameters([id])).length > MAX_BULK_URL_LENGTH) {
                    try {
                        result.push({ id, document: await source.get(id, options) });
                    } catch (error) {
                        checkCancelled();
                        result.push({ id, error });
                    }
                } else pending.push(id);
            }
            await readBatch(pending);
            checkCancelled();
            return result;
        },
        close() {
            signal?.removeEventListener("abort", abort);
            controller.abort();
            return Promise.resolve();
        },
    };
    return source;
}
