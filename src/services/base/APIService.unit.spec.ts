import { describe, expect, it, vi } from "vitest";
import { EVENT_PLATFORM_UNLOADED, EVENT_PLUGIN_UNLOADED } from "@lib/events/coreEvents";
import type { Confirm } from "@lib/interfaces/Confirm";
import { BrowserAPIService } from "@lib/services/implements/browser/BrowserAPIService";
import { HeadlessAPIService } from "@lib/services/implements/headless/HeadlessAPIService";
import { ControlService, type ControlServiceDependencies } from "./ControlService";
import { ServiceContext } from "./ServiceBase";

const hosts = [
    { name: "headless", create: (context: ServiceContext) => new HeadlessAPIService(context) },
    {
        name: "browser",
        create: (context: ServiceContext) => new BrowserAPIService(context, { confirm: {} as Confirm }),
    },
];

describe.each(hosts)("$name API cleanup", ({ create }) => {
    it("runs each registration once at terminal unload, without running it at registration or unload start", () => {
        const context = new ServiceContext();
        const API = create(context);
        const cleanup = vi.fn();
        API.registerCleanup(cleanup);
        API.registerCleanup(cleanup);
        expect(cleanup).not.toHaveBeenCalled();
        context.events.emitEvent(EVENT_PLUGIN_UNLOADED);
        expect(cleanup).not.toHaveBeenCalled();
        context.events.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(cleanup).toHaveBeenCalledTimes(2);
        context.events.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it("keeps cleanup isolated from another client context", () => {
        const first = new ServiceContext();
        const second = new ServiceContext();
        const ownCleanup = vi.fn();
        const otherCleanup = vi.fn();
        create(first).registerCleanup(ownCleanup);
        create(second).registerCleanup(otherCleanup);
        first.events.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(ownCleanup).toHaveBeenCalledOnce();
        expect(otherCleanup).not.toHaveBeenCalled();
        second.events.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(otherCleanup).toHaveBeenCalledOnce();
    });
});

describe("API cleanup in controlled shutdown", () => {
    it("uses the existing terminal event after the asynchronous database close", async () => {
        const context = new ServiceContext();
        const API = new HeadlessAPIService(context);
        API.addLog.setHandler(vi.fn(), true);
        const order: string[] = [];
        API.registerCleanup(() => {
            order.push("cleanup");
        });
        const control = new ControlService(context, {
            appLifecycleService: {
                onLoaded: { addHandler: vi.fn() },
                onBeforeUnload: vi.fn(async () => true),
                onAppUnload: vi.fn(async () => []),
                onUnload: vi.fn(async () => {
                    order.push("lifecycle-unload");
                    return true;
                }),
            },
            databaseService: {
                localDatabaseDirect: {
                    onunload: vi.fn(),
                    close: vi.fn(async () => {
                        order.push("database-close");
                    }),
                },
            },
            APIService: API,
        } as unknown as ControlServiceDependencies);
        await control.onUnload();
        expect(order).toEqual(["lifecycle-unload", "database-close", "cleanup"]);
    });
});
