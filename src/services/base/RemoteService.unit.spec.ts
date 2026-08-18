import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it, vi } from "vitest";
import type { APIService } from "./APIService";
import type { AppLifecycleService } from "./AppLifecycleService";
import { RemoteService } from "./RemoteService";
import { ServiceContext } from "./ServiceBase";
import type { SettingService } from "./SettingService";
import { PouchDB } from "@lib/pouchdb/pouchdb-http";

class TestRemoteService extends RemoteService {}

function createService(
    fetchImplementation: (req: string | Request, opts?: RequestInit) => Promise<Response>,
    pouchDB: PouchDB.Static = PouchDB
) {
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const nativeFetch = vi.fn(fetchImplementation);
    const webCompatFetch = vi.fn(fetchImplementation);
    const APIService = {
        addLog: vi.fn(),
        isOnline: true,
        nativeFetch,
        requestCount,
        responseCount,
        webCompatFetch,
    } as unknown as APIService;
    const appLifecycle = {
        getUnresolvedMessages: { addHandler: vi.fn() },
    } as unknown as AppLifecycleService;
    const setting = {
        currentSettings: vi.fn(() => ({ E2EEAlgorithm: "v2" })),
    } as unknown as SettingService;
    const service = new TestRemoteService(new ServiceContext(), {
        pouchDB,
        APIService,
        appLifecycle,
        setting,
    });
    return { APIService, nativeFetch, requestCount, responseCount, service, webCompatFetch };
}

const databaseInfo = {
    compact_running: false,
    data_size: 0,
    db_name: "db",
    disk_format_version: 6,
    disk_size: 0,
    doc_count: 0,
    doc_del_count: 0,
    instance_start_time: "0",
    purge_seq: 0,
    update_seq: "0",
};

function createDatabaseInfoResponse() {
    return new Response(JSON.stringify(databaseInfo), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

async function rawConnect(service: TestRemoteService, skipInfo = true) {
    return await service.connect(
        "https://example.com/db",
        { username: "user", password: "password", type: "basic" },
        false,
        false,
        false,
        false,
        skipInfo,
        false,
        {},
        false,
        () => Promise.resolve(new Uint8Array())
    );
}

type ConnectWithOptions = (
    uri: string,
    auth: { username: string; password: string; type: "basic" },
    disableRequestURI: boolean,
    passphrase: string | false,
    useDynamicIterationCount: boolean,
    performSetup: boolean,
    skipInfo: boolean,
    compression: boolean,
    customHeaders: Record<string, string>,
    useRequestAPI: boolean,
    getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>,
    options: { signal?: AbortSignal; allowNativeFallback?: boolean }
) => ReturnType<TestRemoteService["connect"]>;

async function connectOwned(
    service: TestRemoteService,
    options: { signal?: AbortSignal; allowNativeFallback?: boolean } = {},
    skipInfo = true
) {
    const connectWithOptions = service.connect as unknown as ConnectWithOptions;
    const opened = await connectWithOptions.call(
        service,
        "https://example.com/db",
        { username: "user", password: "password", type: "basic" },
        false,
        false,
        false,
        false,
        skipInfo,
        false,
        {},
        false,
        () => Promise.resolve(new Uint8Array()),
        options
    );
    expect(typeof opened).not.toBe("string");
    if (typeof opened === "string") throw new Error(opened);
    return opened;
}

async function rawConnectWithSignal(service: TestRemoteService, signal: AbortSignal) {
    // Keep the regression executable against the previous implementation: its
    // connect method ignores the final ownership argument, so the request remains
    // pending until the connection contract binds that signal.
    return await connectOwned(service, { signal, allowNativeFallback: false });
}

async function connect(service: TestRemoteService, skipInfo = true) {
    const connection = await rawConnect(service, skipInfo);
    expect(typeof connection).not.toBe("string");
    if (typeof connection === "string") throw new Error(connection);
    return connection;
}

describe("RemoteService request activity", () => {
    it("settles an in-flight request when its connection signal is aborted", async () => {
        const fetchStarted = Promise.withResolvers<void>();
        const { service } = createService(
            (_request, options) =>
                new Promise<Response>((_resolve, reject) => {
                    fetchStarted.resolve();
                    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
                })
        );
        const controller = new AbortController();
        const connection = await rawConnectWithSignal(service, controller.signal);
        expect(typeof connection).not.toBe("string");
        if (typeof connection === "string") throw new Error(connection);

        const result = connection as {
            db: PouchDB.Database<never>;
            close?: () => Promise<void>;
        };
        const infoRequest = result.db.info();
        await fetchStarted.promise;
        controller.abort(new Error("connectivity preflight expired"));

        let pendingTimer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            infoRequest.then(
                () => "fulfilled" as const,
                () => "rejected" as const
            ),
            new Promise<"pending">((resolve) => {
                pendingTimer = setTimeout(() => resolve("pending"), 250);
            }),
        ]);
        if (pendingTimer) clearTimeout(pendingTimer);
        await (result.close?.() ?? result.db.close());

        expect(outcome).toBe("rejected");
    });

    it("aborts a response body read before closing the PouchDB handle", async () => {
        const bodyReadStarted = Promise.withResolvers<void>();
        const { service } = createService((_request, options) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    const signal = options?.signal;
                    const rejectBody = () => controller.error(signal?.reason);
                    if (signal?.aborted) {
                        rejectBody();
                    } else {
                        signal?.addEventListener("abort", rejectBody, { once: true });
                    }
                },
                pull() {
                    bodyReadStarted.resolve();
                },
            });
            return Promise.resolve(
                new Response(body, {
                    headers: { "content-type": "application/json" },
                    status: 200,
                })
            );
        });
        const opened = await connectOwned(service);
        const owned = opened as typeof opened & { close(): Promise<void> };

        const infoRequest = opened.db.info();
        await bodyReadStarted.promise;
        await owned.close();

        await expect(infoRequest).rejects.toThrow("Remote connection closed");
    });

    it("does not fall back to the native request API for an owned preflight", async () => {
        const { nativeFetch, service } = createService(() => Promise.reject(new TypeError("CORS failed")));
        nativeFetch.mockResolvedValue(createDatabaseInfoResponse());
        const opened = await connectOwned(service, { allowNativeFallback: false });

        await expect(opened.db.info()).rejects.toThrow("CORS failed");

        expect(nativeFetch).not.toHaveBeenCalled();
        await (opened as typeof opened & { close(): Promise<void> }).close();
    });

    it("closes an owned connection once and preserves the skipped information snapshot", async () => {
        const database = {
            close: vi.fn().mockResolvedValue(undefined),
            transform: vi.fn(),
        };
        const FakePouchDB = vi.fn(function () {
            return database;
        });
        const { service } = createService(() => Promise.reject(new Error("unused")), FakePouchDB as never);
        const opened = await connectOwned(service);
        const owned = opened as typeof opened & { close(): Promise<void> };

        expect(opened.info).toEqual({ db_name: "", doc_count: 0, update_seq: "" });
        await Promise.all([owned.close(), owned.close()]);

        expect(database.close).toHaveBeenCalledOnce();
    });

    it("reuses a composed request signal when AbortSignal.any is unavailable", async () => {
        type AdapterFetch = (request: string | Request, options?: RequestInit) => Promise<Response>;
        let adapterFetch: AdapterFetch | undefined;
        const database = {
            close: vi.fn().mockResolvedValue(undefined),
            transform: vi.fn(),
        };
        const FakePouchDB = vi.fn(function (_uri: string, configuration: { fetch: AdapterFetch }) {
            adapterFetch = configuration.fetch;
            return database;
        });
        const { service } = createService(() => Promise.resolve(createDatabaseInfoResponse()), FakePouchDB as never);
        const abortSignalConstructor = AbortSignal as typeof AbortSignal & {
            any?: (signals: AbortSignal[]) => AbortSignal;
        };
        const originalAny = Object.getOwnPropertyDescriptor(abortSignalConstructor, "any");
        Object.defineProperty(abortSignalConstructor, "any", { configurable: true, value: undefined });

        try {
            const connection = await connectOwned(service);
            const requestController = new AbortController();
            const addEventListener = vi.spyOn(requestController.signal, "addEventListener");
            const removeEventListener = vi.spyOn(requestController.signal, "removeEventListener");

            await adapterFetch?.("https://example.com/db/_changes", { signal: requestController.signal });
            await adapterFetch?.("https://example.com/db/_changes", { signal: requestController.signal });

            expect(addEventListener).toHaveBeenCalledTimes(1);
            await (connection as typeof connection & { close(): Promise<void> }).close();
            expect(removeEventListener).toHaveBeenCalledTimes(1);
        } finally {
            if (originalAny) {
                Object.defineProperty(abortSignalConstructor, "any", originalAny);
            } else {
                delete abortSignalConstructor.any;
            }
        }
    });

    it.each([
        ["closes successfully", undefined],
        ["fails to close", new Error("close failed")],
    ] as const)("preserves the initial info failure when cleanup %s", async (_case, closeError) => {
        const database = {
            info: vi.fn().mockRejectedValue(new Error("info failed")),
            close: closeError ? vi.fn().mockRejectedValue(closeError) : vi.fn().mockResolvedValue(undefined),
            transform: vi.fn(),
        };
        const FakePouchDB = vi.fn(function () {
            return database;
        });
        const { service } = createService(() => Promise.reject(new Error("unused")), FakePouchDB as never);

        await expect(rawConnect(service, false)).resolves.toBe("Error:info failed");
        expect(database.close).toHaveBeenCalledOnce();
    });

    it("balances the counters after a CouchDB adapter request settles", async () => {
        const { requestCount, responseCount, service } = createService(() =>
            Promise.resolve(createDatabaseInfoResponse())
        );

        const connection = await connect(service);
        await connection.db.info();

        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("balances both attempts when a web request falls back to the native API", async () => {
        const { nativeFetch, requestCount, responseCount, service, webCompatFetch } = createService(() =>
            Promise.reject(new TypeError("CORS failed"))
        );
        nativeFetch.mockResolvedValue(createDatabaseInfoResponse());

        const connection = await connect(service);
        await connection.db.info();

        expect(webCompatFetch).toHaveBeenCalledOnce();
        expect(nativeFetch).toHaveBeenCalledOnce();
        expect(requestCount.value).toBe(2);
        expect(responseCount.value).toBe(2);
    });

    it("balances the counters when an individual request rejects", async () => {
        const { requestCount, responseCount, service } = createService(() =>
            Promise.reject(new TypeError("network failed"))
        );

        await expect(service.performFetch("https://example.com/db")).rejects.toThrow("network failed");

        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });
});
