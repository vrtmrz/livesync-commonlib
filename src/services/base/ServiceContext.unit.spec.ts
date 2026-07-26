import { describe, expect, it, vi } from "vitest";

import { createServiceContext, ServiceContext, type ServiceContextContract } from "./ServiceBase";

const MESSAGE_KEY = "moduleLocalDatabase.logWaitingForReady" as const;

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
        translation: context.translate(MESSAGE_KEY),
        received,
    };
}

describe("ServiceContext", () => {
    it("uses the English catalogue when a host does not provide a translator", () => {
        const context = createServiceContext();

        expect(
            context.translate("moduleCheckRemoteSize.optionIncreaseLimit", {
                newMax: "800",
            })
        ).toBe("increase to 800MB");
    });

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

        expect(first.translate(MESSAGE_KEY)).toBe(`first:${MESSAGE_KEY}`);
        expect(second.translate(MESSAGE_KEY)).toBe(`second:${MESSAGE_KEY}`);
    });

    it("exposes stable event and translation results through the public contract", () => {
        const result = useContextContract(
            createServiceContext({
                translate: (key) => `translated:${key}`,
            })
        );

        expect(result).toEqual({
            translation: `translated:${MESSAGE_KEY}`,
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
            translation: `host:${MESSAGE_KEY}`,
            received: ["event-result"],
        });
        expect(context.root).toBe("host-root");
    });
});
