import { describe, expect, it, vi } from "vitest";

import { EVENT_ON_UNRESOLVED_ERROR } from "@lib/events/coreEvents";
import { createServiceContext } from "./ServiceBase";
import { UnresolvedErrorManager } from "./UnresolvedErrorManager";
import type { AppLifecycleService } from "./AppLifecycleService";

describe("UnresolvedErrorManager event isolation", () => {
    it("notifies only the service context which owns the manager", () => {
        const first = createServiceContext();
        const second = createServiceContext();
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        first.events.onEvent(EVENT_ON_UNRESOLVED_ERROR, firstListener);
        second.events.onEvent(EVENT_ON_UNRESOLVED_ERROR, secondListener);
        const appLifecycle = {
            context: first,
            getUnresolvedMessages: { addHandler: vi.fn() },
        } as unknown as AppLifecycleService;
        const manager = new UnresolvedErrorManager(appLifecycle, first.events);

        manager.showError("Expected test error");

        expect(firstListener).toHaveBeenCalledOnce();
        expect(secondListener).not.toHaveBeenCalled();
    });
});
