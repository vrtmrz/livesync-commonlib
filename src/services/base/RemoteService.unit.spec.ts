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

async function connect(service: TestRemoteService, skipInfo = true) {
    const connection = await rawConnect(service, skipInfo);
    expect(typeof connection).not.toBe("string");
    if (typeof connection === "string") throw new Error(connection);
    return connection;
}

describe("RemoteService request activity", () => {
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
