import { describe, expect, it, vi } from "vitest";

import {
    createServiceContext,
    ServiceContext,
    type ServiceContextContract,
} from "./ServiceBase";

function useContextContract(context: ServiceContextContract): {
    translation: string;
    received: string[];
} {
    const received: string[] = [];
    const unsubscribe = context.events.onEvent("hello", (value) => received.push(value));
    try {
        context.events.emitEvent("hello", "event-result");
    } finally {
        unsubscribe();
    }
    return {
        translation: context.translate("message"),
        received,
    };
}

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

    it("exposes stable event and translation results through the public contract", () => {
        const result = useContextContract(
            createServiceContext({
                translate: (key) => `translated:${key}`,
            })
        );

        expect(result).toEqual({
            translation: "translated:message",
            received: ["event-result"],
        });
    });

    it("allows a host to extend the contract without changing its shared results", () => {
        class HostContext extends ServiceContext {
            constructor(readonly root: string) {
                super({ translate: (key) => `host:${key}` });
            }
        }

        const context = new HostContext("host-root");

        expect(useContextContract(context)).toEqual({
            translation: "host:message",
            received: ["event-result"],
        });
        expect(context.root).toBe("host-root");
    });
});
