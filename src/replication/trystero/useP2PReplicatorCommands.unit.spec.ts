import { describe, expect, it, vi } from "vitest";
import { useP2PReplicatorCommands } from "./useP2PReplicatorCommands";

describe("useP2PReplicatorCommands", () => {
    it("uses the transport lifecycle view without accessing the compatibility replicator", () => {
        const commands: Array<{
            id: string;
            checkCallback?: (isChecking: boolean) => boolean | void;
        }> = [];
        const connect = vi.fn();
        const disconnect = vi.fn();
        const result = {
            transportLifecycle: {
                isConnected: false,
                connect,
                disconnect,
            },
        };
        const host = {
            services: {
                API: { addCommand: vi.fn((command) => commands.push(command)) },
                setting: {},
                context: {},
            },
            serviceModules: {},
        } as unknown as Parameters<typeof useP2PReplicatorCommands>[0];

        useP2PReplicatorCommands(host, result as never);
        commands.find((command) => command.id === "p2p-establish-connection")?.checkCallback?.(false);
        commands.find((command) => command.id === "p2p-close-connection")?.checkCallback?.(false);

        expect(connect).toHaveBeenCalledOnce();
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
