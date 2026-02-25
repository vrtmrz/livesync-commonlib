import type { CouchDBCredentials, EntryDoc } from "@lib/common/types";
import type { IRemoteService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { LOG_LEVEL_DEBUG, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type LOG_LEVEL } from "@lib/common/types";
import { replicationFilter } from "@lib/pouchdb/compress";
import { disableEncryption, enableEncryption } from "@lib/pouchdb/encryption";
import { isCloudantURI, isValidRemoteCouchDBURI } from "@lib/pouchdb/utils_couchdb";
import { AuthorizationHeaderGenerator } from "@lib/replication/httplib";
import type { APIService } from "@lib/services/base/APIService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { SettingService } from "@lib/services/base/SettingService";
import { UnresolvedErrorManager } from "@lib/services/base/UnresolvedErrorManager";
import { createInstanceLogFunction, MARK_LOG_NETWORK_ERROR, type LogFunction } from "@lib/services/lib/logUtils";
import { PouchDB } from "@lib/pouchdb/pouchdb-browser.ts";
export interface RemoteServiceDependencies {
    APIService: APIService;
    appLifecycle: AppLifecycleService;
    setting: SettingService;
}

const FetchMethod = {
    webCompat: 0,
    native: 1,
} as const;

type FetchMethod = (typeof FetchMethod)[keyof typeof FetchMethod];

/**
 * The RemoteService provides methods for interacting with the remote database.
 */
export abstract class RemoteService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IRemoteService
{
    /**
     * Connect to the remote database with the provided settings.
     * @param uri  The URI of the remote database.
     * @param auth  The authentication credentials for the remote database.
     * @param disableRequestURI  Whether to disable the request URI.
     * @param passphrase  The passphrase for the remote database.
     * @param useDynamicIterationCount  Whether to use dynamic iteration count.
     * @param performSetup  Whether to perform setup.
     * @param skipInfo  Whether to skip information retrieval.
     * @param compression  Whether to enable compression.
     * @param customHeaders  Custom headers to include in the request.
     * @param useRequestAPI  Whether to use the request API.
     * @param getPBKDF2Salt  Function to retrieve the PBKDF2 salt.
     * Note that this function is used for CouchDB and compatible only.
     */
    protected _log: LogFunction;
    protected _authHeader = new AuthorizationHeaderGenerator();
    protected _APIService: APIService;
    protected _appLifecycleService: AppLifecycleService;
    protected _settingService: SettingService;
    protected _unresolvedErrors: UnresolvedErrorManager;
    protected last_successful_post = false;

    get hadLastPostFailedBySize(): boolean {
        return !this.last_successful_post;
    }

    constructor(context: T, dependencies: RemoteServiceDependencies) {
        super(context);
        this._APIService = dependencies.APIService;
        this._appLifecycleService = dependencies.appLifecycle;
        this._settingService = dependencies.setting;
        this._log = createInstanceLogFunction("RemoteService", dependencies.APIService);
        this._unresolvedErrors = new UnresolvedErrorManager(this._appLifecycleService);
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
        this._APIService.requestCount.value = this._APIService.requestCount.value + 1;
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
    }

    async connect(
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
        getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>
    ): Promise<string | { db: PouchDB.Database<EntryDoc>; info: PouchDB.Core.DatabaseInfo }> {
        if (!isValidRemoteCouchDBURI(uri)) return "Remote URI is not valid";
        if (uri.toLowerCase() != uri) return "Remote URI and database name could not contain capital letters.";
        if (uri.indexOf(" ") !== -1) return "Remote URI and database name could not contain spaces.";
        if (!this._APIService.isOnline) {
            return "Network is offline";
        }
        // let authHeader = await this._authHeader.getAuthorizationHeader(auth);
        const conf: PouchDB.HttpAdapter.HttpAdapterConfiguration = {
            adapter: "http",
            auth: "username" in auth ? auth : undefined,
            skip_setup: !performSetup,
            fetch: async (url: string | Request, opts?: RequestInit) => {
                const authHeader = await this._authHeader.getAuthorizationHeader(auth);
                let size = "";
                const localURL = url.toString().substring(uri.length);
                const method = opts?.method ?? "GET";
                if (opts?.body) {
                    const opts_length = opts.body.toString().length;
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
                    try {
                        this._APIService.requestCount.value = this._APIService.requestCount.value + 1;
                        // const response: Response = await (useRequestAPI
                        //     ? this.nativeFetch(url.toString(), { ...opts, headers })
                        //     : this.webCompatFetch(url, { ...opts, headers }));
                        // if (method == "POST" || method == "PUT") {
                        //     this.last_successful_post = response.ok;
                        // } else {
                        //     this.last_successful_post = true;
                        // }
                        // this._log(`HTTP:${method}${size} to:${localURL} -> ${response.status}`, LOG_LEVEL_DEBUG);
                        // if (Math.floor(response.status / 100) !== 2) {
                        //     if (response.status == 404) {
                        //         if (method === "GET" && localURL.indexOf("/_local/") === -1) {
                        //             this._log(
                        //                 `Just checkpoint or some server information has been missing. The 404 error shown above is not an error.`,
                        //                 LOG_LEVEL_VERBOSE
                        //             );
                        //         }
                        //     } else {
                        //         const r = response.clone();
                        //         this._log(
                        //             `The request may have failed. The reason sent by the server: ${r.status}: ${r.statusText}`,
                        //             LOG_LEVEL_NOTICE
                        //         );
                        //         try {
                        //             const result = await r.text();
                        //             this._log(result, LOG_LEVEL_VERBOSE);
                        //         } catch (_) {
                        //             this._log("Cloud not fetch response body", LOG_LEVEL_VERBOSE);
                        //             this._log(_, LOG_LEVEL_VERBOSE);
                        //         }
                        //     }
                        // }
                        // this.clearErrors();
                        const response = await this.performFetch(
                            url,
                            { ...opts, headers },
                            useRequestAPI ? FetchMethod.native : FetchMethod.webCompat
                        );
                        return response;
                    } catch (ex) {
                        if (ex instanceof TypeError) {
                            if (useRequestAPI) {
                                this._log("Failed to request by API.");
                                throw ex;
                            }
                            this._log(
                                "Failed to fetch by native fetch API. Trying to fetch by API to get more information."
                            );
                            // const resp2 = await this.fetchByAPI(url.toString(), localURL, method, authHeader, {
                            //     ...opts,
                            //     headers,
                            // });
                            const resp2 = await this.performFetch(url, { ...opts, headers }, FetchMethod.native);
                            if (resp2.status / 100 == 2) {
                                this.showError(
                                    "The request was successful by API. But the native fetch API failed! Please check CORS settings on the remote database!. While this condition, you cannot enable LiveSync",
                                    LOG_LEVEL_NOTICE
                                );
                                return resp2;
                            }
                            const r2 = resp2.clone();
                            const msg = await r2.text();
                            this.showError(`Failed to fetch by API. ${resp2.status}: ${msg}`, LOG_LEVEL_NOTICE);
                            return resp2;
                        }
                        throw ex;
                    }
                } catch (ex: any) {
                    this._log(`HTTP:${method}${size} to:${localURL} -> failed`, LOG_LEVEL_VERBOSE);
                    const msg = ex instanceof Error ? `${ex?.name}:${ex?.message}` : ex?.toString();
                    this.showError(`${MARK_LOG_NETWORK_ERROR}Network Error: Failed to fetch: ${msg}`); // Do not show notice, due to throwing below
                    this._log(ex, LOG_LEVEL_VERBOSE);
                    // limit only in bulk_docs.
                    if (url.toString().indexOf("_bulk_docs") !== -1) {
                        this.last_successful_post = false;
                    }
                    this._log(ex);
                    throw ex;
                } finally {
                    this._APIService.responseCount.value = this._APIService.responseCount.value + 1;
                }
                // return await fetch(url, opts);
            },
        };
        const setting = this._settingService.currentSettings();
        const db: PouchDB.Database<EntryDoc> = new PouchDB<EntryDoc>(uri, conf);
        replicationFilter(db, compression);
        disableEncryption();
        if (passphrase !== "false" && typeof passphrase === "string") {
            enableEncryption(db, passphrase, useDynamicIterationCount, false, getPBKDF2Salt, setting.E2EEAlgorithm);
        }
        if (skipInfo) {
            return { db: db, info: { db_name: "", doc_count: 0, update_seq: "" } };
        }
        try {
            const info = await db.info();
            return { db: db, info: info };
        } catch (ex: any) {
            const msg = `${ex?.name}:${ex?.message}`;
            this._log(ex, LOG_LEVEL_VERBOSE);
            return msg;
        }
    }
}
