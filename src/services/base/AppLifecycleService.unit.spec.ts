import { describe, expect, it } from "vitest";
import { EVENT_APPLICATION_READY } from "@lib/events/coreEvents";
import { createServiceContext, type ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import type { ISettingService } from "./IService";

class TestAppLifecycleService extends InjectableAppLifecycleService {}

function setup(context: ServiceContext = createServiceContext()) {
    const lifecycle = new TestAppLifecycleService(context, { settingService: {} as ISettingService });
    const readinessSeenByListeners: boolean[] = [];
    context.events.onEvent(EVENT_APPLICATION_READY, () => readinessSeenByListeners.push(lifecycle.isReady()));
    return { lifecycle, readinessSeenByListeners };
}

describe("AppLifecycleService readiness", () => {
    it("emits EVENT_APPLICATION_READY once readiness is established, with the flag already set", () => {
        const { lifecycle, readinessSeenByListeners } = setup();

        lifecycle.markIsReady();

        expect(readinessSeenByListeners).toEqual([true]);
    });

    it("emits nothing while the application stays ready or when readiness is cleared", () => {
        const { lifecycle, readinessSeenByListeners } = setup();

        lifecycle.markIsReady();
        lifecycle.markIsReady();
        lifecycle.resetIsReady();

        expect(readinessSeenByListeners).toEqual([true]);
    });

    it("emits again when readiness is established anew, as at the end of a fetch", () => {
        const { lifecycle, readinessSeenByListeners } = setup();

        lifecycle.markIsReady();
        lifecycle.resetIsReady();
        lifecycle.markIsReady();

        expect(readinessSeenByListeners).toEqual([true, true]);
    });

    it("emits on the event channel of its own service context only", () => {
        const { lifecycle, readinessSeenByListeners } = setup();
        const otherContext = createServiceContext();
        let otherChannelEvents = 0;
        otherContext.events.onEvent(EVENT_APPLICATION_READY, () => otherChannelEvents++);

        lifecycle.markIsReady();

        expect(readinessSeenByListeners).toEqual([true]);
        expect(otherChannelEvents).toBe(0);
    });
});
