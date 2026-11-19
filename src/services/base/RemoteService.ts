import { SuperCallCapture } from "@lib/common/SuperCallCapture.ts";
import { E2EEAlgorithms, type CouchDBCredentials, type EntryDoc } from "@lib/common/types";
import type { IRemoteService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
} from "@lib/common/types";
import { replicationFilter } from "@lib/pouchdb/compress";
import { disableEncryption, enableEncryption } from "@lib/pouchdb/encryption";
import { isCloudantURI, isValidRemoteCouchDBURI } from "@lib/pouchdb/utils_couchdb";
import { AuthorizationHeaderGenerator } from "@lib/replication/httplib";
import { observedOfflineReplicationFailure } from "@lib/replication/ReplicatorProvider.ts";
import { captureRemoteTransportFailure, ReplicationNetworkError } from "@lib/replication/remoteTransportFailure.ts";
import type { APIService } from "@lib/services/base/APIService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { SettingService } from "@lib/services/base/SettingService";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { createInstanceLogFunction, MARK_LOG_NETWORK_ERROR, type LogFunction } from "@lib/services/lib/logUtils";
import { runWithTrackedPhysicalRequest } from "@lib/services/lib/remoteActivity.ts";
import { createCouchDBHttpCache } from "@lib/services/lib/couchdbHttpCache.ts";
import type PouchDB from "pouchdb-core";
import type { PouchDBConstructor } from "@lib/pouchdb/PouchDBConstructor.ts";
import { LiveSyncError } from "@lib/common/LSError";
import type {
    CouchDBConnectionOpenResult,
    OwnedCouchDBConnection,
    RemoteConnectionOpenOptions,
} from "./RemoteConnection.ts";

type RemoteConnectionScope = {
    readonly signal: AbortSignal;
    combine(signal?: AbortSignal | null): AbortSignal;
    abort(reason?: unknown): void;
};

function createRemoteConnectionScope(ownerSignal?: AbortSignal): RemoteConnectionScope {
    const controller = new AbortController();
    const combinedSignals = new WeakMap<AbortSignal, AbortSignal>();
    let detachOwner = () => {};
    const abort = (reason?: unknown) => {
        detachOwner();
        if (!controller.signal.aborted) {
            controller.abort(reason);
        }
    };
    if (ownerSignal?.aborted) {
        abort(ownerSignal.reason);
    } else if (ownerSignal) {
        const onOwnerAbort = () => abort(ownerSignal.reason);
        ownerSignal.addEventListener("abort", onOwnerAbort, { once: true });
        detachOwner = () => ownerSignal.removeEventListener("abort", onOwnerAbort);
    }
    const combine = (signal?: AbortSignal | null) => {
        if (!signal || signal === controller.signal) return controller.signal;
        const cached = combinedSignals.get(signal);
        if (cached) return cached;
        const combined = combineAbortSignals(signal, controller.signal);
        combinedSignals.set(signal, combined);
        return combined;
    };
    return { signal: controller.signal, combine, abort };
}

function combineAbortSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
    if (first === second) return first;

    const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
        any?: (signals: AbortSignal[]) => AbortSignal;
    };
    if (typeof abortSignalWithAny.any === "function") {
        return abortSignalWithAny.any([first, second]);
    }

    // Older hosts do not provide AbortSignal.any(). Keep both cancellation
    // sources without replacing PouchDB's per-request signal.
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const detach = () => {
        for (const [signal, listener] of listeners) {
            signal.removeEventListener("abort", listener);
        }
        listeners.clear();
    };
    const abortFrom = (signal: AbortSignal) => {
        detach();
        if (!controller.signal.aborted) {
            controller.abort(signal.reason);
        }
    };
    for (const signal of [first, second]) {
        if (signal.aborted) {
            abortFrom(signal);
            break;
        }
        const listener = () => abortFrom(signal);
        listeners.set(signal, listener);
        signal.addEventListener("abort", listener, { once: true });
    }
    return controller.signal;
}

function createCouchDBConnection<T extends object>(
    db: PouchDB.Database<T>,
    info: PouchDB.Core.DatabaseInfo,
    scope: RemoteConnectionScope
): OwnedCouchDBConnection<T> {
    let closePromise: Promise<void> | undefined;
    return {
        db,
        info,
        close: () => {
            closePromise ??= (async () => {
                scope.abort(new Error("Remote connection closed."));
                await db.close();
            })();
            return closePromise;
        },
    };
}

const responseBodyReaders = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

/** Capture failures when PouchDB consumes a successful response after fetch has settled. */
function observeResponseBody(response: Response, captureFailure: (error: unknown) => unknown): Response {
    if (!response.ok) {
        return response;
    }
    return new Proxy(response, {
        get(target, property) {
            if (property === "clone") {
                return () => observeResponseBody(target.clone(), captureFailure);
            }
            const member: unknown = Reflect.get(target, property);
            if (typeof member !== "function" || property === "constructor") {
                return member;
            }
            if (!responseBodyReaders.has(property)) {
                return member.bind(target);
            }
            return async () => {
                try {
                    return await Reflect.apply(member, target, []);
                } catch (error) {
                    throw captureFailure(error);
                }
            };
        },
    });
}

export interface RemoteServiceDependencies {
    /** PouchDB with the HTTP adapter required by the host runtime already registered. */
    pouchDB: PouchDBConstructor;
    APIService: APIService;
    appLifecycle: AppLifecycleService;
    setting: SettingService;
}

const FetchMethod = {
    webCompat: 0,
    native: 1,
} as const;

type FetchMethod = (typeof FetchMethod)[keyof typeof FetchMethod];

const connectSuperCall = new SuperCallCapture<CouchDBConnectionOpenResult<EntryDoc>>();

/**
 * The RemoteService provides methods for interacting with the remote database.
 */
export abstract class RemoteService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IRemoteService
{
    protected _log: LogFunction;
    protected _authHeader = new AuthorizationHeaderGenerator();
    protected _APIService: APIService;
    protected _appLifecycleService: AppLifecycleService;
    protected _settingService: SettingService;
    protected _unresolvedErrors: UnresolvedErrorManager;
    protected _pouchDB: PouchDBConstructor;
    protected last_successful_post = false;

    get hadLastPostFailedBySize(): boolean {
        return !this.last_successful_post;
    }

    constructor(context: T, dependencies: RemoteServiceDependencies) {
        super(context);
        this._pouchDB = dependencies.pouchDB;
        this._APIService = dependencies.APIService;
        this._appLifecycleService = dependencies.appLifecycle;
        this._settingService = dependencies.setting;
        this._log = createInstanceLogFunction("RemoteService", dependencies.APIService);
        this._unresolvedErrors = new UnresolvedErrorManager(this._appLifecycleService, this.context.events);
    }

    showError(msg: string, max_log_level: LOG_LEVEL = LOG_LEVEL_NOTICE) {
        this._unresolvedErrors.showError(msg, max_log_level);
    }

    clearErrors() {
        this._unresolvedErrors.clearErrors();
    }

    async performFetch(
        req: string | Request,
        opts?: RequestInit,
        fetchMethod: FetchMethod = FetchMethod.webCompat
    ): Promise<Response> {
        const useNativeFetch = fetchMethod === FetchMethod.native;
        const fetchFunction = useNativeFetch
            ? this._APIService.nativeFetch.bind(this._APIService)
            : this._APIService.webCompatFetch.bind(this._APIService);
        return await runWithTrackedPhysicalRequest(this._APIService, async () => {
            const response = await fetchFunction(req, opts);
            const method = opts?.method ?? "GET";
            if (method == "POST" || method == "PUT") {
                this.last_successful_post = response.ok;
            } else {
                this.last_successful_post = true;
            }
            const url = new URL(typeof req === "string" ? req : req.url);
            const localURL = `${url.protocol}//${url.host}${url.pathname}`;
            this._log(`[REQ] (${method}) ${localURL} -> ${response.status}`, LOG_LEVEL_DEBUG);
            if (Math.floor(response.status / 100) !== 2) {
                if (response.status == 404) {
                    if (method === "GET" && url.pathname.indexOf("/_local/") === -1) {
                        this._log(
                            `Just checkpoint or some server information has been missing. The 404 error shown above is not an error.`,
                            LOG_LEVEL_VERBOSE
                        );
                    }
                } else {
                    const r = response.clone();
                    this._log(
                        `The request may have failed. The reason sent by the server: ${r.status}: ${r.statusText}`,
                        LOG_LEVEL_NOTICE
                    );
                    try {
                        const result = await r.text();
                        this._log(result, LOG_LEVEL_VERBOSE);
                    } catch (_) {
                        this._log("Could not fetch response body", LOG_LEVEL_VERBOSE);
                        this._log(_, LOG_LEVEL_VERBOSE);
                    }
                }
            } else {
                this.clearErrors();
            }
            return response;
        });
    }

    /**
     * Opens a remote CouchDB connection with request cancellation bound to its
     * owner.
     *
     * @param uri - The URI of the remote database.
     * @param auth - Authentication credentials for the remote database.
     * @param disableRequestURI - Whether request URI handling is disabled.
     * @param passphrase - The database encryption passphrase, or `false` when
     * encryption is disabled.
     * @param useDynamicIterationCount - Whether legacy dynamic iteration counts
     * are enabled.
     * @param performSetup - Whether PouchDB may set up a missing database.
     * @param skipInfo - Whether to omit the opening database information request.
     * @param compression - Whether chunk compression is enabled.
     * @param customHeaders - Additional HTTP headers for every request.
     * @param useRequestAPI - Whether to use the host-native request adapter.
     * @param getPBKDF2Salt - Resolves the PBKDF2 salt when encryption needs it.
     * @param connectionOptions - Ownership and request fallback options.
     * @returns An error description, or the owned connection. The caller must
     * transfer ownership or call `close()`.
     */
    async connect(...args: Parameters<IRemoteService["connect"]>): Promise<string | OwnedCouchDBConnection<EntryDoc>> {
        const record = connectSuperCall.takeRecorder(this);
        const opened = await this.openConnection(...args);
        record?.(opened);
        return "error" in opened ? opened.error.message : opened;
    }

    async openCouchDBConnection(
        ...args: Parameters<IRemoteService["connect"]>
    ): Promise<CouchDBConnectionOpenResult<EntryDoc>> {
        if (this.connect !== RemoteService.prototype.connect) {
            const { result, delegated } = connectSuperCall.invoke(this, () => this.connect(...args));
            const opened = await result;
            if (typeof opened !== "string") {
                return opened;
            }
            const base = delegated.value;
            if (base && "error" in base && base.error.message === opened) {
                return base;
            }
            return { error: new Error(opened) };
        }
        return await this.openConnection(...args);
    }

    private async openConnection(
        uri: string,
        auth: CouchDBCredentials,
        disableRequestURI: boolean,
        passphrase: string | false,
        useDynamicIterationCount: boolean,
        performSetup: boolean,
        skipInfo: boolean,
        compression: boolean,
        customHeaders: Record<string, string>,
        useRequestAPI: boolean,
        getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>,
        connectionOptions: RemoteConnectionOpenOptions = {}
    ): Promise<CouchDBConnectionOpenResult<EntryDoc>> {
        if (!isValidRemoteCouchDBURI(uri)) {
            return { error: new Error("Remote URI is not valid") };
        }
        if (uri.toLowerCase() !== uri) {
            return { error: new Error("Remote URI and database name could not contain capital letters.") };
        }
        if (uri.includes(" ")) {
            return { error: new Error("Remote URI and database name could not contain spaces.") };
        }
        if (!this._APIService.isOnline) {
            return {
                error: new ReplicationNetworkError("Network is offline", observedOfflineReplicationFailure()),
            };
        }
        const connectionScope = createRemoteConnectionScope(connectionOptions.signal);
        const encryptionAlgorithm =
            connectionOptions.encryptionAlgorithm ?? this._settingService.currentSettings().E2EEAlgorithm;
        const prepareCachedRequest = createCouchDBHttpCache(
            uri,
            typeof passphrase === "string" && passphrase !== "false" && encryptionAlgorithm !== E2EEAlgorithms.ForceV1
                ? getPBKDF2Salt
                : undefined,
            connectionOptions.useCouchDBCacheControlHeadersOnly === true
        );
        // let authHeader = await this._authHeader.getAuthorizationHeader(auth);
        const conf: PouchDB.HttpAdapter.HttpAdapterConfiguration = {
            adapter: "http",
            auth: "username" in auth ? auth : undefined,
            skip_setup: !performSetup,
            fetch: async (requestSrc: string | Request, opts?: RequestInit) => {
                const url = new URL(typeof requestSrc === "string" ? requestSrc : requestSrc.url);
                const authHeader = await this._authHeader.getAuthorizationHeader(auth);
                let size = "";
                const localURL = url.toString().substring(uri.length);
                const method = opts?.method ?? "GET";
                if (opts?.body) {
                    const bodyLength =
                        typeof opts.body === "string" ? opts.body.length : JSON.stringify(opts.body).length;
                    const opts_length = isNaN(bodyLength) ? 0 : bodyLength;
                    if (opts_length > 1000 * 1000 * 10) {
                        // over 10MB
                        if (isCloudantURI(uri)) {
                            this.last_successful_post = false;
                            this._log("This request should fail on IBM Cloudant.", LOG_LEVEL_VERBOSE);
                            throw new Error("This request should fail on IBM Cloudant.");
                        }
                    }
                    size = ` (${opts_length})`;
                }
                try {
                    const headers = new Headers(opts?.headers);
                    if (customHeaders) {
                        for (const [key, value] of Object.entries(customHeaders)) {
                            if (key && value) {
                                headers.append(key, value);
                            }
                        }
                    }
                    if (!("username" in auth)) {
                        headers.append("authorization", authHeader);
                    }
                    const cachedRequest = await prepareCachedRequest(requestSrc, opts);
                    const signal = connectionScope.combine(opts?.signal);
                    const captureFailure = (error: unknown) =>
                        captureRemoteTransportFailure(error, signal, () => this._APIService.isOnline);
                    try {
                        const response = await this.performFetch(
                            cachedRequest.request,
                            { ...opts, headers, signal, cache: cachedRequest.cache },
                            useRequestAPI ? FetchMethod.native : FetchMethod.webCompat
                        );
                        return observeResponseBody(response, captureFailure);
                    } catch (error) {
                        if (
                            !(error instanceof TypeError) ||
                            connectionScope.signal.aborted ||
                            connectionOptions.allowNativeFallback === false ||
                            useRequestAPI
                        ) {
                            if (useRequestAPI && error instanceof TypeError && !connectionScope.signal.aborted) {
                                this._log("Failed to request by API.");
                            }
                            throw captureFailure(error);
                        }

                        this._log(
                            "Failed to fetch by native fetch API. Trying to fetch by API to get more information."
                        );
                        let response: Response;
                        try {
                            response = await this.performFetch(
                                cachedRequest.request,
                                { ...opts, headers, cache: cachedRequest.cache },
                                FetchMethod.native
                            );
                        } catch (fallbackError) {
                            throw captureFailure(fallbackError);
                        }
                        if (response.status / 100 == 2) {
                            this.showError(
                                "The request was successful by API. But the native fetch API failed! Please check CORS settings on the remote database!. While this condition, you cannot enable LiveSync",
                                LOG_LEVEL_NOTICE
                            );
                        } else {
                            const msg = await response.clone().text();
                            this.showError(`Failed to fetch by API. ${response.status}: ${msg}`, LOG_LEVEL_NOTICE);
                        }
                        return observeResponseBody(response, captureFailure);
                    }
                } catch (ex) {
                    this._log(`HTTP:${method}${size} to:${localURL} -> failed`, LOG_LEVEL_VERBOSE);
                    const msg = ex instanceof Error ? `${ex?.name}:${ex?.message}` : ex?.toString();
                    if (!connectionScope.signal.aborted) {
                        this.showError(
                            `${MARK_LOG_NETWORK_ERROR}Network Error: Failed to fetch: ${msg}`,
                            LOG_LEVEL_INFO
                        ); // Do not show notice, due to throwing below
                    }
                    this._log(ex, LOG_LEVEL_VERBOSE);
                    // limit only in bulk_docs.
                    if (url.toString().indexOf("_bulk_docs") !== -1) {
                        this.last_successful_post = false;
                    }
                    this._log(ex);
                    throw ex;
                }
                // return await fetch(url, opts);
            },
        };
        let db: PouchDB.Database<EntryDoc>;
        try {
            db = new this._pouchDB<EntryDoc>(uri, conf);
        } catch (ex) {
            connectionScope.abort(ex);
            throw ex;
        }
        const compatibilityInfo = { db_name: "", doc_count: 0, update_seq: "" };
        const connection = createCouchDBConnection(db, compatibilityInfo, connectionScope);
        const closeAfterConnectionFailure = async () => {
            try {
                await connection.close();
            } catch (closeError) {
                this._log("Failed to close remote database after connection failure.", LOG_LEVEL_INFO);
                this._log(closeError, LOG_LEVEL_VERBOSE);
            }
        };
        try {
            replicationFilter(db, compression);
            disableEncryption();
            if (passphrase !== "false" && typeof passphrase === "string") {
                enableEncryption(
                    db,
                    passphrase,
                    useDynamicIterationCount,
                    false,
                    getPBKDF2Salt,
                    encryptionAlgorithm,
                    connectionOptions.encryptInternalMetadata ?? false,
                    connectionOptions.acceptUnencryptedContent ?? false
                );
            }
        } catch (ex) {
            await closeAfterConnectionFailure();
            throw ex;
        }
        if (skipInfo) {
            return connection;
        }
        try {
            const info = await db.info();
            return { ...connection, info };
        } catch (ex) {
            const error = ex instanceof Error ? ex : LiveSyncError.fromError(ex);
            this._log(ex, LOG_LEVEL_VERBOSE);
            await closeAfterConnectionFailure();
            return { error: new Error(`${error.name}:${error.message}`, { cause: ex }) };
        }
    }
}
