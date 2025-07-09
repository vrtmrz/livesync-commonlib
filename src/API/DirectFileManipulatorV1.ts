// deno-lint-ignore-file
//@ts-nocheck : obsolete library
/**
 * The API for manipulating files stored in the CouchDB by Self-hosted LiveSync or its families.
 */
//TODO ADJUST TO Using LiveSyncDBFunction.ts
import { LRUCache } from "../memory/LRUCache.ts";
import { encrypt, decrypt, obfuscatePath } from "../encryption/e2ee_v2.ts";
import { LEVEL_DEBUG, LEVEL_INFO, LEVEL_VERBOSE, Logger } from "../common/logger.ts";
import { path2id_base, shouldSplitAsPlainText } from "../string_and_binary/path.ts";
import { decodeBinary } from "../string_and_binary/convert.ts";
import { splitPieces2 } from "../string_and_binary/chunks.ts";
import { type Task, processAllTasksWithConcurrencyLimit } from "../concurrency/task.ts";
import {
    type DocumentID,
    type FilePathWithPrefix,
    MAX_DOC_SIZE_BIN,
    type NewEntry,
    type PlainEntry,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
} from "../common/types.ts";
import { default as xxhash, type XXHashAPI } from "xxhash-wasm-102";
import { createBinaryBlob, createTextBlob } from "../common/utils.ts";

/**
 * Options for DirectFileManipulator (V1)
 * @deprecated Use DirectFileManipulatorOptions (of V2) instead.
 */
export type DirectFileManipulatorOptions = {
    url: string;
    username: string;
    password: string;
    passphrase: string | undefined;
    database: string;
    obfuscatePassphrase: string | undefined;
    useDynamicIterationCount?: boolean;
    customChunkSize?: number;
    minimumChunkSize?: number;
};

function base64encode(src: string) {
    if (typeof window != "undefined" && window.btoa) return window.btoa(src);
    return Buffer.from(src).toString("base64");
}
function unique<T>(obj: T[]): T[] {
    return [...new Set([...obj])] as T[];
}
export type ReadyEntry = (NewEntry | PlainEntry) & { data: string[] };
export type MetaEntry = (NewEntry | PlainEntry) & { children: string[] };

let _xxhash64: (input: string) => bigint;

async function prepareHashFunctions() {
    if (_xxhash64 != null) return;
    const { h64 } = await (xxhash as unknown as () => Promise<XXHashAPI>)();
    _xxhash64 = h64;
}
export type FileInfo = {
    ctime: number;
    mtime: number;
    size: number;
};

export type EnumerateConditions = {
    startKey?: string;
    endKey?: string;
    ids?: string[];
    metaOnly: boolean;
};

/**
 * DirectFileManipulator (V1)
 * @deprecated Use DirectFileManipulator (V2) instead.
 */
export class DirectFileManipulator {
    options: DirectFileManipulatorOptions;
    hashCaches = new LRUCache<DocumentID, string>(300, 50);

    constructor(options: DirectFileManipulatorOptions) {
        this.options = options;
    }

    //#region internal methods

    async _fetch(
        path: string[],
        querySrc: Record<string, any>,
        method: "get" | "post" | "put",
        body?: any,
        controller?: AbortController
    ) {
        const headers = {
            authorization: "Basic " + base64encode(this.options.username + ":" + this.options.password),
            "content-type": "application/json",
        };
        const query = Object.entries(querySrc)
            .map((e) => `${encodeURIComponent(e[0])}=${encodeURIComponent(e[1])}`)
            .join("&");
        const requestURI = `${this.options.url}/${this.options.database}/${path.map((e) => encodeURIComponent(e)).join("/")}${query != "" ? `?${query}` : ""}`;
        Logger(`Requesting ... ${method} ${requestURI}`, LEVEL_DEBUG);
        const opt = {
            headers,
            method,
            body: method == "get" || body == undefined ? undefined : JSON.stringify(body),
            signal: controller?.signal,
        };
        return await fetch(requestURI, opt);
    }
    async _fetchJson(path: string[], querySrc: Record<string, any>, method: "get" | "post" | "put", body?: any) {
        return await (await this._fetch(path, querySrc, method, body)).json();
    }

    async _collectChunks(ids: string[], onlyCheckExistence = false): Promise<Record<string, string | boolean>> {
        const params = !onlyCheckExistence ? { include_docs: "true" } : {};
        const ret = {} as Record<string, string | boolean>;
        const reqIds = [];
        Logger(`Collecting chunks: ${ids.length}`, LEVEL_DEBUG);
        for (const id of ids) {
            const cachedChunk = this.hashCaches.get(id as DocumentID);
            if (typeof cachedChunk === "string") {
                ret[id] = cachedChunk;
            } else {
                reqIds.push(id);
            }
        }
        // If already have all chunks, return so
        if (reqIds.length == 0) {
            Logger(`All chunks has been found on cache.`, LEVEL_DEBUG);
            return ret;
        }
        const apiRet = await this._fetchJson([`_all_docs`], params, "post", { keys: unique([...reqIds]) });
        if (!("rows" in apiRet)) throw new Error("API Error (_all_docs)");
        for (const v of apiRet.rows) {
            const k = v.key;
            if (v.error) {
                ret[k] = false;
            } else {
                if (onlyCheckExistence) {
                    ret[k] = true;
                    continue;
                }
                if (!("doc" in v)) {
                    throw new Error(`Corrupted chunk found (${k})`);
                }
                const doc = v.doc;
                if (!("type" in doc) || doc.type != "leaf") {
                    throw new Error(`Corrupted chunk found (Pointed non-chunk object) (${k})`);
                }
                if (!("data" in doc)) {
                    throw new Error(`Corrupted chunk found (No data contained) (${k})`);
                }
                const dataSrc = `${doc.data}`;
                const data = this.options.passphrase
                    ? await decrypt(dataSrc, this.options.passphrase, this.options.useDynamicIterationCount ?? false)
                    : dataSrc;
                ret[k] = data;
                this.hashCaches.set(v.key, data);
            }
        }
        Logger(`Chunks retrieved (${reqIds.length} / ${ids.length})`, LEVEL_DEBUG);
        return ret;
    }

    /**
    Encrypt path of the Entry
     * @param entry 
     * @returns 
     */
    async encryptDocumentPath<T extends ReadyEntry | MetaEntry>(entry: T): Promise<T> {
        return {
            ...entry,
            path: this.options.obfuscatePassphrase
                ? await obfuscatePath(
                      entry.path,
                      this.options.obfuscatePassphrase,
                      this.options.useDynamicIterationCount ?? false
                  )
                : entry.path,
        };
    }
    /**
     * Decrypt path of the Entry
     * @param entry
     * @returns
     */
    async decryptDocumentPath<T extends ReadyEntry | MetaEntry>(entry: T): Promise<T> {
        let path = "";
        if (this.options.obfuscatePassphrase) {
            if (entry.path.startsWith("%") || entry.path.startsWith("[")) {
                path = await decrypt(
                    entry.path,
                    this.options.obfuscatePassphrase,
                    this.options.useDynamicIterationCount ?? false
                );
            }
        } else {
            path = entry.path ?? "";
        }
        if (path == "") {
            if (entry._id.indexOf(":") !== -1) {
                path = entry._id;
            }
        }
        if (path == "") throw new Error("Could not determine path");
        return {
            ...entry,
            path,
        } as T;
    }
    async path2id(path: string) {
        return await path2id_base(path as FilePathWithPrefix, this.options.obfuscatePassphrase ?? false);
    }
    //#endregion

    /**
     * Get specific document from the Remote Database by path.
     * @param path
     * @param metaOnly if it has been enabled, the note does not contains the content.
     * @returns
     */
    async get(path: FilePathWithPrefix, metaOnly = false) {
        Logger(`GET: START: ${path}`, LOG_LEVEL_VERBOSE);
        const id = await this.path2id(path);
        const ret = await this.getById(id, metaOnly);
        Logger(`GET: DONE: ${path}`, LEVEL_INFO);
        return ret;
    }

    /**
     * Get specific document from the Remote Database by ID.
     * @param path
     * @param metaOnly if it has been enabled, the note does not contains the content.
     * @returns
     */
    async getById(id: string, metaOnly = false): Promise<false | MetaEntry | ReadyEntry> {
        // TODO: TREAT FOR CONFLICTED FILES or OLD REVISIONS.
        // Logger(`GET: START: ${id}`, LOG_LEVEL_VERBOSE)
        const docEntry = await this._fetchJson([id], {}, "get");
        if (!("_id" in docEntry && "type" in docEntry && (docEntry.type == "plain" || docEntry.type == "newnote"))) {
            return false;
        }
        const doc = await this.decryptDocumentPath<MetaEntry>(docEntry);
        if (metaOnly) {
            // Logger(`GET: DONE (METAONLY): ${id}`, LOG_LEVEL_INFO)
            return doc;
        }
        return this.getByMeta(doc);
    }
    async getByMeta(doc: MetaEntry): Promise<ReadyEntry> {
        const chunks = await this._collectChunks(doc.children);
        const data = doc.children.map((e) => (e in chunks && chunks[e] !== false ? chunks[e] : false));
        if (data.some((e) => e === false)) {
            throw new Error(`Missing chunks: ${doc.path}!`);
        }
        Logger(`GET: DONE (META): ${doc.path}`, LOG_LEVEL_INFO);
        return { ...doc, data: data as unknown as string[] };
    }

    /**
     * Put a note to the remote database
     * @param path
     * @param data
     * @param info
     * @param type
     * @returns
     */
    async put(path: string, data: string[] | Blob, info: FileInfo, type: "newnote" | "plain" = "plain") {
        await prepareHashFunctions();
        Logger(`PUT: START: ${path}`, LOG_LEVEL_VERBOSE);
        const id = await this.path2id(path);

        const maxChunkSize = Math.floor(MAX_DOC_SIZE_BIN * ((this.options.customChunkSize || 0) * 1 + 1));
        const pieceSize = maxChunkSize;
        let plainSplit = false;
        const userPassphrase = this.options.passphrase;
        const minimumChunkSize = this.options.minimumChunkSize || 20;
        if (shouldSplitAsPlainText(path)) {
            // pieceSize = MAX_DOC_SIZE;
            plainSplit = true;
        }
        let xData: Blob;
        switch (type) {
            case "newnote":
                if (data instanceof Blob) {
                    xData = data;
                } else {
                    xData = createBinaryBlob(decodeBinary(data));
                }
                break;
            case "plain":
                xData = data instanceof Blob ? data : createTextBlob(data);
                break;
            default:
                throw new Error("Could not prepare document data");
        }

        const pieces = await splitPieces2(xData, pieceSize, plainSplit, minimumChunkSize, path);
        const chunks = {} as Record<string, string>;
        const children = [];
        // Make chunks once.
        for await (const piece of pieces()) {
            let leafId = "" as DocumentID;
            let hashedPiece = "";
            const cachedLeafId = this.hashCaches.revGet(piece);
            if (cachedLeafId) {
                chunks[cachedLeafId] = piece;
                children.push(cachedLeafId);
                continue;
            }
            if (this.options.passphrase) {
                hashedPiece = "+" + _xxhash64(`${piece}-${userPassphrase}-${piece.length}`).toString(36);
            } else {
                hashedPiece = _xxhash64(`${piece}-${piece.length}`).toString(36);
            }

            leafId = ("h:" + hashedPiece) as DocumentID;
            chunks[leafId] = piece;
            children.push(leafId);
        }
        const existedIds = await this._collectChunks(Object.keys(chunks), true);
        const chunksToBeUploaded = [] as any[];
        const entries = Object.entries(chunks).filter((e) => !existedIds[e[0]]);
        for (const e of entries) {
            chunksToBeUploaded.push({
                _id: e[0],
                data: this.options.passphrase
                    ? await encrypt(e[1], this.options.passphrase, this.options.useDynamicIterationCount ?? false)
                    : e[1],
                type: "leaf",
            });
        }
        Logger(`PUT: All chunks:${Object.entries(chunks).length}, Upload chunk: ${chunksToBeUploaded.length}`);
        const apiRet = (await this._fetchJson([`_bulk_docs`], {}, "post", { docs: chunksToBeUploaded })) as any[];
        for (const ret of apiRet) {
            if (ret?.ok) {
                this.hashCaches.set(ret.key, chunks[ret.key]);
            } else {
                if (ret.error != "conflict") {
                    throw Error(`Chunk uploading failed! ${ret?.id}`);
                }
            }
        }
        // All chunks are ready
        const theEntry = await this.encryptDocumentPath<MetaEntry>({
            _id: id,
            path: path as FilePathWithPrefix,
            children: children,
            ctime: info.ctime,
            mtime: info.mtime,
            size: info.size,
            type: type,
            eden: {},
        });
        // to update, retrieve the latest revision
        const oldData = await this.getById(id, true);
        if (oldData) {
            theEntry._rev = oldData._rev;
        }
        Logger(`PUT: UPLOADING: ${path}`, LOG_LEVEL_VERBOSE);
        const ret = await this._fetchJson([id], {}, "put", theEntry);
        if (ret?.ok) {
            Logger(`PUT: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        }
        Logger(`PUT: FAILED: ${path}`, LOG_LEVEL_NOTICE);
        return false;
    }

    async delete(path: string) {
        Logger(`DELETE: START: ${path}`, LEVEL_VERBOSE);
        const id = await this.path2id(path);
        const oldData = await this.getById(id, true);
        if (!oldData || !oldData._rev) {
            return true;
        }
        if (oldData.deleted) {
            return true;
        }
        const newData = await this.encryptDocumentPath({
            _id: oldData._id,
            _rev: oldData._rev,
            // path: this.options.obfuscatePassphrase ? await encrypt(oldData.path, this.options.obfuscatePassphrase, this.options.useDynamicIterationCount) : oldData.path,
            path: oldData.path,
            children: [] as string[],
            ctime: oldData.ctime,
            mtime: Date.now(),
            size: 0,
            type: oldData.type,
            deleted: true,
            data: "data" in oldData ? oldData.data : [],
            eden: {},
        });
        const ret = await this._fetchJson([id], {}, "put", newData);
        if (ret?.ok) {
            Logger(`DELETE: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        }
        Logger(`DELETE: FAILED: ${path}`, LOG_LEVEL_INFO);
        return false;
    }
    // Untested
    async *enumerate(cond: EnumerateConditions) {
        //TODO
        const param = {} as Record<string, string>;
        if (cond.startKey) param.startkey = cond.startKey;
        if (cond.endKey) param.endkey = cond.endKey;
        if (cond.ids) param.keys = JSON.stringify(cond.ids);

        let key = cond.startKey;
        do {
            const result = await this._fetchJson(["_all_docs"], {}, "get", {
                ...param,
                include_docs: true,
                startkey: key,
                limit: 100,
            });
            if (!result.rows || result.rows.length == 0) {
                break;
            }
            //there are some result
            for (const v of result.rows) {
                const doc = v.doc;
                if (cond.metaOnly) {
                    yield await doc;
                } else {
                    yield await this.getByMeta(doc);
                }
                key = doc._id + "\u{10ffff}";
            }
        } while (true);
        return;
    }
    async *_enumerate(startKey: string, endKey: string, opt: { metaOnly: boolean }) {
        let key = startKey;
        const req = (key: string) => {
            const param = {
                include_docs: true,
                startkey: JSON.stringify(key),
                limit: 100,
                endkey: JSON.stringify(endKey),
            };
            return this._fetchJson(["_all_docs"], param, "get");
        };
        let request = req(key);
        do {
            // Awaiting pre-started request.
            const result = await request;
            if (!result.rows || result.rows.length == 0) {
                break;
            }
            key = `${result.rows[result.rows.length - 1].key}\u{10ffff}`;

            // Perform next request while processing results;
            request = req(key);

            const entries = result.rows
                .filter((e: any) => "doc" in e)
                .map((e: any) => e.doc as MetaEntry) as MetaEntry[];
            const rowsForProc = entries
                .filter((docEntry) => "type" in docEntry && (docEntry.type == "plain" || docEntry.type == "newnote"))
                .map((e: MetaEntry) => async () => {
                    try {
                        const w = await this.decryptDocumentPath<MetaEntry>(e);
                        if (opt.metaOnly) {
                            return w;
                        }
                        return await this.getByMeta(w);
                    } catch (ex) {
                        Logger(ex, LOG_LEVEL_VERBOSE);
                        throw new Error(`Something happened at ${e.path}`);
                    }
                }) as Task<MetaEntry>[];
            const newDocs = processAllTasksWithConcurrencyLimit(5, rowsForProc);

            for await (const v of newDocs) {
                if ("err" in v) {
                    Logger(`${v.err}`);
                    continue;
                }
                yield v.ok;
            }
        } while (true);
        return;
    }
    async *enumerateAllNormalDocs(opt: { metaOnly: boolean }) {
        // const opt = {};
        const targets = [
            this._enumerate("", "h:", opt),
            this._enumerate(`h:\u{10ffff}`, "i:", opt),
            this._enumerate(`i:\u{10ffff}`, "ix:", opt),
            this._enumerate(`ix:\u{10ffff}`, "ps:", opt),
            this._enumerate(`ps:\u{10ffff}`, "\u{10ffff}", opt),
        ];
        for (const target of targets) {
            for await (const f of target) {
                yield f;
            }
        }
    }

    watching = false;
    _abortController?: AbortController;
    since = "";

    async processJSONL(
        mode: string,
        lineData: any,
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean
    ) {
        if ("seq" in lineData) {
            this.since = lineData.seq; // update seq to prevent infinite loop.
        }
        if ("doc" in lineData) {
            const docEntry = lineData.doc as MetaEntry;
            if (!(docEntry.type == "newnote" || docEntry.type == "plain")) {
                Logger(`${mode}: SKIP ${(docEntry as any)._id}: Not a document`, LOG_LEVEL_VERBOSE);
                return;
            }
            const docDecrypted = await this.decryptDocumentPath(docEntry);
            if (checkIsInterested) {
                if (!checkIsInterested(docDecrypted)) {
                    Logger(
                        `${mode}: SKIP ${(docDecrypted as any)?.path ?? docEntry._id}: OUT OF TARGET FOLDER`,
                        LOG_LEVEL_VERBOSE
                    );
                    return;
                }
            }
            Logger(`${mode}: PROCESSING: ${docDecrypted.path}`, LEVEL_VERBOSE, mode);
            const doc = await this.getByMeta(docDecrypted);
            try {
                await callback(doc, lineData.seq);
                Logger(`${mode}: PROCESS DONE: ${docDecrypted.path}`, LEVEL_INFO, mode);
            } catch (ex) {
                Logger(`${mode}: PROCESS FAILED`, LEVEL_INFO, mode);
                Logger(ex, LEVEL_VERBOSE, mode);
            }
        }
    }

    async beginWatch(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean
    ) {
        if (this.watching) return false;
        this.watching = true;
        try {
            if (this._abortController) {
                this._abortController.abort();
                this._abortController = undefined;
            }
            if (this.since == "") {
                this.since = "0";
            }
            Logger(`WATCH: START: (since:${this.since})`, LEVEL_INFO, "watch");
            this._abortController = new AbortController();
            const response = await this._fetch(
                ["_changes"],
                {
                    style: "all_docs",
                    filter: "replicate/pull",
                    include_docs: true,
                    since: this.since,
                    feed: "continuous",
                    timeout: 100000,
                    heartbeat: 5000,
                },
                "get",
                {},
                this._abortController
            );
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Could not get reader from response body");
            for await (const chunk of readLines(reader)) {
                if (chunk) {
                    try {
                        const lineData = JSON.parse(chunk);
                        await this.processJSONL("WATCH", lineData, callback, checkIsInterested);
                    } catch (ex: any) {
                        // console.log(chunk);
                        if (ex?.name == "AbortError") {
                            Logger(`WATCH: ABORTED`, LEVEL_VERBOSE, "watch");
                            this.watching = false;
                        } else {
                            Logger(`WATCH: SOMETHING WENT WRONG ON EACH PROCESS`, LEVEL_VERBOSE, "watch");
                            Logger(ex, LEVEL_VERBOSE, "watch");
                            Logger(chunk, LOG_LEVEL_VERBOSE, "watch");
                        }
                    }
                }
            }
        } catch (ex) {
            Logger(`WATCH: SOMETHING WENT WRONG ON WATCHING`, LEVEL_VERBOSE, "watch");
            Logger(ex, LEVEL_VERBOSE, "watch");
        } finally {
            if (this.watching) {
                Logger(`WATCH: CONNECTION HAS BEEN CLOSED, RECONNECTING...`, LEVEL_INFO, "watch");
                this.watching = false;
                setTimeout(() => {
                    void this.beginWatch(callback, checkIsInterested);
                }, 10000);
            } else {
                Logger(`WATCH: CONNECTION HAS BEEN CLOSED.`, LEVEL_INFO, "watch");
            }
        }
    }
    endWatch() {
        if (this._abortController) {
            Logger(`WATCH: ABORT PROCESS.`, LEVEL_INFO, "watch");
            this.watching = false;
            this._abortController.abort();
            Logger(`WATCH: ABORT SIGNAL HAS BEEN SENT.`, LEVEL_INFO, "watch");
        }
        this._abortController = undefined;
    }
    async followUpdates(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean
    ) {
        try {
            if (this.since == "") {
                this.since = "0";
            }
            let pending = 0;
            Logger(`FOLLOW: START: (since:${this.since})`, LEVEL_INFO, "followUpdates");
            do {
                const response = await this._fetch(
                    ["_changes"],
                    {
                        style: "all_docs",
                        filter: "replicate/pull",
                        include_docs: true,
                        since: this.since,
                        feed: "normal",
                        limit: 25,
                    },
                    "get"
                );
                const ret = await response.json();
                pending = ret?.pending ?? 0;
                const results = ret.results;
                Logger(`FOLLOW: incoming ${results?.length ?? 0} entries, ${pending} pending.`);
                for await (const lineData of results) {
                    try {
                        await this.processJSONL("FOLLOW", lineData, callback, checkIsInterested);
                    } catch (ex) {
                        Logger(`FOLLOW: SOMETHING WENT WRONG ON EACH PROCESS`, LEVEL_VERBOSE, "followUpdates");
                        Logger(ex, LEVEL_VERBOSE, "followUpdates");
                    }
                }
            } while (pending > 0);
        } catch (ex) {
            Logger(`FOLLOW: SOMETHING WENT WRONG ON WATCHING`, LEVEL_VERBOSE, "followUpdates");
            Logger(ex, LEVEL_VERBOSE, "watch");
        } finally {
            Logger(`FOLLOW: FINISHED AT ${this.since}.`, LEVEL_INFO, "followUpdates");
        }
        return this.since;
    }
}

async function* readLines(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const textDecoder = new TextDecoder();
    let partOfLine = "";
    for await (const chunk of readChunks(reader)) {
        const chunkText = textDecoder.decode(chunk);
        const chunkLines = chunkText.split("\n");
        if (chunkLines.length === 1) {
            partOfLine += chunkLines[0];
        } else if (chunkLines.length > 1) {
            yield partOfLine + chunkLines[0];
            for (let i = 1; i < chunkLines.length - 1; i++) {
                yield chunkLines[i];
            }
            partOfLine = chunkLines[chunkLines.length - 1];
        }
    }
}

function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>) {
    return {
        async *[Symbol.asyncIterator]() {
            let readResult = await reader.read();
            while (!readResult.done) {
                yield readResult.value;
                readResult = await reader.read();
            }
        },
    };
}
