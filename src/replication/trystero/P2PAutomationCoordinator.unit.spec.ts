import { describe, expect, it, vi } from "vitest";
import { P2PAutomationCoordinator } from "./P2PAutomationCoordinator";

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

describe("P2PAutomationCoordinator", () => {
    it("shares one completed baseline for a normalised peer name", async () => {
        const coordinator = new P2PAutomationCoordinator();
        const first = vi.fn(async () => ({ status: "completed", ok: true }) as const);
        const duplicate = vi.fn(async () => ({ status: "completed", ok: true }) as const);

        await expect(coordinator.runBaseline(" Peer A ", first)).resolves.toEqual({
            status: "completed",
            ok: true,
        });
        await expect(coordinator.runBaseline("peer a", duplicate)).resolves.toEqual({
            status: "completed",
            ok: true,
        });

        expect(first).toHaveBeenCalledOnce();
        expect(duplicate).not.toHaveBeenCalled();
    });

    it("shares in-flight work across a generation change without publishing stale completion", async () => {
        const coordinator = new P2PAutomationCoordinator();
        const pending = createDeferred<{ readonly status: "completed"; readonly ok: true }>();
        const first = vi.fn(() => pending.promise);
        const retry = vi.fn(async () => ({ status: "completed", ok: true }) as const);

        const original = coordinator.runBaseline("peer-a", first);
        coordinator.beginLifecycle();
        const shared = coordinator.runBaseline("peer-a", retry);

        expect(shared).toBe(original);
        expect(retry).not.toHaveBeenCalled();

        pending.resolve({ status: "completed", ok: true });
        await expect(shared).resolves.toEqual({ status: "completed", ok: true });
        await expect(coordinator.runBaseline("peer-a", retry)).resolves.toEqual({
            status: "completed",
            ok: true,
        });

        expect(retry).toHaveBeenCalledOnce();
    });
});
