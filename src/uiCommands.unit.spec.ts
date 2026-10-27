import { describe, expect, it, vi } from "vitest";
import { declareUICommand, UICommandRegistry } from "@lib/uiCommands";

type JoinRequest = { deviceId: string };
type JoinResult = { accepted: boolean };

async function assertUICommandTypes(
    registry: UICommandRegistry,
    command: ReturnType<typeof declareUICommand<JoinRequest, JoinResult>>
) {
    const result: Promise<{ status: "handled"; value: JoinResult } | { status: "unavailable" }> = registry.invoke(
        command,
        { deviceId: "device-1" }
    );
    void result;
    const invocation = await registry.invoke(command, { deviceId: "device-1" });
    if (invocation.status === "handled") {
        const typedResult: JoinResult = invocation.value;
        void typedResult;

        // @ts-expect-error The invocation result must use the declared result type.
        const incorrectResult: { accepted: string } = invocation.value;
        void incorrectResult;
    }

    // @ts-expect-error The declared request shape is required.
    registry.invoke(command, { deviceId: 1 });

    registry.register(command, (request) => ({ accepted: request.deviceId.length > 0 }));

    // @ts-expect-error The handler request must match the command declaration.
    registry.register(command, (request: { unrelated: string }) => ({ accepted: true }));

    // @ts-expect-error The handler result must match the command declaration.
    registry.register(command, () => ({ accepted: "yes" }));
}
void assertUICommandTypes;

describe("UICommandRegistry", () => {
    it("creates immutable command definitions", () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/immutable");

        expect(Object.isFrozen(command)).toBe(true);
    });

    it("passes the declared request to its handler and returns its result", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/join");
        const registry = new UICommandRegistry();
        const handler = vi.fn(async (request: JoinRequest) => ({ accepted: request.deviceId === "device-1" }));
        registry.register(command, handler);

        await expect(registry.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "handled",
            value: { accepted: true },
        });
        expect(handler).toHaveBeenCalledWith({ deviceId: "device-1" });
    });

    it("propagates handler failures", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/fail");
        const registry = new UICommandRegistry();
        const failure = new Error("handler failed");
        registry.register(command, () => {
            throw failure;
        });

        await expect(registry.invoke(command, { deviceId: "device-1" })).rejects.toBe(failure);
    });

    it("returns unavailable when no handler is registered", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/missing");
        const registry = new UICommandRegistry();

        await expect(registry.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "unavailable",
        });
    });

    it("rejects duplicate handlers and conflicting definitions with the same name", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/duplicate");
        const conflictingCommand = declareUICommand<{ id: number }, JoinResult>("joinedDevices/duplicate");
        const registry = new UICommandRegistry();
        registry.register(command, () => ({ accepted: true }));

        expect(() => registry.register(command, () => ({ accepted: false }))).toThrow(/already registered/);
        expect(() => registry.register(conflictingCommand, () => ({ accepted: false }))).toThrow(/conflicting command/);
        await expect(registry.invoke(conflictingCommand, { id: 1 })).resolves.toEqual({
            status: "unavailable",
        });
    });

    it("allows idempotent unregistration followed by registration of the same definition", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/re-register");
        const registry = new UICommandRegistry();
        const unregister = registry.register(command, () => ({ accepted: true }));

        unregister();
        unregister();
        await expect(registry.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "unavailable",
        });

        registry.register(command, () => ({ accepted: false }));
        unregister();
        await expect(registry.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "handled",
            value: { accepted: false },
        });
    });

    it("isolates handlers between registry instances", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/isolated");
        const first = new UICommandRegistry();
        const second = new UICommandRegistry();
        first.register(command, () => ({ accepted: true }));

        await expect(first.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "handled",
            value: { accepted: true },
        });
        await expect(second.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "unavailable",
        });
    });

    it("makes invocations unavailable after disposal and rejects later registration", async () => {
        const command = declareUICommand<JoinRequest, JoinResult>("joinedDevices/disposed");
        const registry = new UICommandRegistry();
        registry.register(command, () => ({ accepted: true }));
        registry.dispose();

        await expect(registry.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "unavailable",
        });
        expect(() => registry.register(command, () => ({ accepted: false }))).toThrow(/disposed/);
    });
});
