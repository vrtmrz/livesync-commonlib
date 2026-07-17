import { describe, expect, it, vi } from "vitest";

import { createServiceContext } from "./ServiceBase";

describe("ServiceContext", () => {
    it("creates an event hub which is isolated from other contexts", () => {
        const first = createServiceContext();
        const second = createServiceContext();
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        first.events.onEvent("hello", firstListener);
        second.events.onEvent("hello", secondListener);

        first.events.emitEvent("hello", "first");

        expect(firstListener).toHaveBeenCalledWith("first");
        expect(secondListener).not.toHaveBeenCalled();
    });

    it("uses an instance-owned translator", () => {
        const first = createServiceContext({
            translate: (key) => `first:${key}`,
        });
        const second = createServiceContext({
            translate: (key) => `second:${key}`,
        });

        expect(first.translate("message")).toBe("first:message");
        expect(second.translate("message")).toBe("second:message");
    });
});
