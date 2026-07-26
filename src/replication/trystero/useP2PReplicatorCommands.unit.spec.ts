import { describe, expect, it, vi } from "vitest";
import { useP2PReplicatorCommands } from "./useP2PReplicatorCommands";

describe("useP2PReplicatorCommands", () => {
    it("uses the current replicator after the feature replaces its instance", () => {
        const commands: Array<{
            id: string;
            checkCallback?: (isChecking: boolean) => boolean | void;
        }> = [];
        const first = { open: vi.fn(), close: vi.fn(), server: undefined };
        const second = { open: vi.fn(), close: vi.fn(), server: undefined };
        let current = first;
        const result = {
            get replicator() {
                return current;
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
        current = second;
        commands.find((command) => command.id === "p2p-establish-connection")?.checkCallback?.(false);

        expect(first.open).not.toHaveBeenCalled();
        expect(second.open).toHaveBeenCalledOnce();
    });
});
